import { LoroDoc, VersionVector } from 'loro-crdt'
import { chunkPath, parseRemotePath, snapshotPath } from './paths'
import type { LocalStore, RemoteDrive, SyncReport, SyncStatus } from './types'

export interface SyncEngineOptions {
  local: LocalStore
  remote: RemoteDrive
  deviceId: string
  deviceName: string
  platform?: string
  /** This device's chunk count per doc above which it uploads a snapshot instead. */
  compactAfter?: number
}

type Counts = Pick<SyncReport, 'pushed' | 'pulled' | 'conflicts'>

/** A doc being pulled into: `doc` holds what was stored at pull start plus every import since. */
interface PullState {
  doc: LoroDoc
  /** Stored version at pull start. */
  before: VersionVector
  pushed: VersionVector
}

const META = {
  pushed: (docId: string) => `pushed:${docId}`,
  seq: (docId: string) => `seq:${docId}`,
  chunks: (docId: string) => `chunks:${docId}`,
  snapshot: (docId: string) => `snapshot:${docId}`,
  stale: (docId: string) => `stale:${docId}`,
  cursor: 'deltaCursor'
}

const versionMap = (vv: VersionVector) => vv.toJSON() as Map<string, number>

/** True when `vv` holds an op `base` does not. */
function ahead(vv: VersionVector, base: VersionVector): boolean {
  for (const [peer, counter] of versionMap(vv)) if (counter > (versionMap(base).get(peer) ?? 0)) return true
  return false
}

function statusOf(err: unknown): SyncStatus {
  const e = err as { offline?: unknown; status?: unknown } | null
  if (e?.offline === true) return 'offline'
  if (e?.status === 401) return 'signed-out'
  return 'error'
}

/**
 * Syncs this device's docs through a shared drive. Each device writes only its own files under
 * `docs/<doc>/<device>/`: immutable update chunks, and a snapshot that replaces them when they
 * pile up. Everyone else's files are imported; Loro makes the order of imports irrelevant.
 */
export class SyncEngine {
  private readonly local: LocalStore
  private readonly remote: RemoteDrive
  private readonly deviceId: string
  private readonly deviceName: string
  private readonly platform: string
  private readonly compactAfter: number

  constructor(opts: SyncEngineOptions) {
    this.local = opts.local
    this.remote = opts.remote
    this.deviceId = opts.deviceId
    this.deviceName = opts.deviceName
    this.platform = opts.platform ?? ''
    this.compactAfter = opts.compactAfter ?? 50
  }

  /** Never throws: every failure becomes the report's status. */
  async syncOnce(): Promise<SyncReport> {
    const counts: Counts = { pushed: 0, pulled: 0, conflicts: 0 }
    try {
      for (const docId of await this.local.docIds()) await this.pushDoc(docId, counts)
      await this.pushBlobs()
      await this.writeDevice()
      await this.pull(counts)
      return { status: 'idle-synced', ...counts, at: Date.now() }
    } catch (err) {
      return { status: statusOf(err), message: err instanceof Error ? err.message : String(err), ...counts, at: Date.now() }
    }
  }

  private async load(docId: string): Promise<LoroDoc> {
    const doc = new LoroDoc()
    const updates = await this.local.loadDoc(docId)
    if (updates.length > 0) doc.importBatch(updates)
    return doc
  }

  private async pushedVersion(docId: string): Promise<VersionVector> {
    const bytes = await this.local.getBytesMeta(META.pushed(docId))
    return bytes ? VersionVector.decode(bytes) : new VersionVector(null)
  }

  private async jsonMeta<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.local.getMeta(key)
    return raw === undefined ? fallback : (JSON.parse(raw) as T)
  }

  private async pushDoc(docId: string, counts: Counts): Promise<void> {
    await this.removeStale(docId)
    const doc = await this.load(docId)
    const pushed = await this.pushedVersion(docId)
    const version = doc.oplogVersion()
    if (!ahead(version, pushed)) return

    const seq = Number((await this.local.getMeta(META.seq(docId))) ?? 0) + 1
    const path = chunkPath(docId, this.deviceId, seq)
    await this.remote.upload(path, doc.export({ mode: 'update', from: pushed }))
    const chunks = [...(await this.jsonMeta<string[]>(META.chunks(docId), [])), path]
    await this.local.setMeta(META.seq(docId), String(seq))
    await this.local.setMeta(META.chunks(docId), JSON.stringify(chunks))
    await this.local.setBytesMeta(META.pushed(docId), version.encode())
    counts.pushed++

    if (chunks.length > this.compactAfter) await this.compact(docId, doc, seq + 1, chunks)
  }

  /**
   * Replaces this device's chunks for a doc with one snapshot. The snapshot is uploaded before
   * anything is removed, so a reader always finds either the chunks or a file covering them.
   */
  private async compact(docId: string, doc: LoroDoc, seq: number, chunks: string[]): Promise<void> {
    const path = snapshotPath(docId, this.deviceId, seq)
    await this.remote.upload(path, doc.export({ mode: 'snapshot' }))
    const previous = await this.local.getMeta(META.snapshot(docId))
    const stale = [...(await this.jsonMeta<string[]>(META.stale(docId), [])), ...chunks, ...(previous ? [previous] : [])]
    await this.local.setMeta(META.seq(docId), String(seq))
    await this.local.setMeta(META.snapshot(docId), path)
    await this.local.setMeta(META.chunks(docId), '[]')
    await this.local.setMeta(META.stale(docId), JSON.stringify(stale))
    await this.removeStale(docId)
  }

  /** Removes files a snapshot superseded; what an interrupted sync left is retried next time. */
  private async removeStale(docId: string): Promise<void> {
    const stale = await this.jsonMeta<string[]>(META.stale(docId), [])
    while (stale.length > 0) {
      await this.remote.remove(stale[0]!)
      stale.shift()
      await this.local.setMeta(META.stale(docId), JSON.stringify(stale))
    }
  }

  private async pushBlobs(): Promise<void> {
    for (const name of await this.local.blobNames()) {
      if (await this.local.blobSynced(name)) continue
      await this.remote.upload(`blobs/${name}`, await this.local.readBlob(name))
      await this.local.markBlobSynced(name)
    }
  }

  private async writeDevice(): Promise<void> {
    const record = { name: this.deviceName, platform: this.platform, lastSeen: Date.now() }
    await this.remote.upload(`devices/${this.deviceId}.json`, new TextEncoder().encode(JSON.stringify(record)))
  }

  private async pull(counts: Counts): Promise<void> {
    const page = await this.remote.delta((await this.local.getMeta(META.cursor)) ?? null)
    const states = new Map<string, PullState>()
    for (const item of page.items) {
      if (item.deleted || !item.isFile) continue
      const parsed = parseRemotePath(item.path)
      if ((parsed.kind !== 'chunk' && parsed.kind !== 'snapshot') || parsed.deviceId === this.deviceId) continue
      if (await this.local.seen(item.id, item.eTag)) continue
      let bytes: Uint8Array
      try {
        bytes = await this.remote.download(item.path)
      } catch (err) {
        // Compacted away since the listing; the snapshot that replaced it is in this delta too.
        if ((err as { status?: unknown }).status === 404) continue
        throw err
      }
      let state = states.get(parsed.docId)
      if (!state) {
        const doc = await this.load(parsed.docId)
        state = { doc, before: doc.oplogVersion(), pushed: await this.pushedVersion(parsed.docId) }
        states.set(parsed.docId, state)
      }
      state.doc.import(bytes)
      await this.local.appendRemote(parsed.docId, bytes)
      await this.local.markSeen(item.id, item.eTag)
      counts.pulled++
    }
    await this.local.setMeta(META.cursor, page.cursor)
    for (const [docId, state] of states) await this.local.setBytesMeta(META.pushed(docId), this.afterPull(state).encode())
  }

  /**
   * What counts as pushed once remote files are imported: every peer's ops up to what the doc now
   * holds, except peers with ops still unpushed from before the pull. Those are this device's
   * own sessions; their next push must still carry them. Remote ops are never uploaded again.
   */
  private afterPull(state: PullState): VersionVector {
    const before = versionMap(state.before)
    const pushed = versionMap(state.pushed)
    const next = new Map(pushed)
    for (const [peer, counter] of versionMap(state.doc.oplogVersion())) {
      if ((before.get(peer) ?? 0) > (pushed.get(peer) ?? 0)) continue
      next.set(peer, Math.max(counter, pushed.get(peer) ?? 0))
    }
    return VersionVector.parseJSON(next as Map<`${number}`, number>)
  }
}

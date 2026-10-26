import { LoroDoc, VersionVector } from 'loro-crdt'
import { contentToJSON, newId, PageDoc, writeContent, type BoxState, type PMJSON } from '@slate/core'
import { boxesTouched, boxMarkdown } from './conflicts'
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
  /** Written into the device record. */
  appVersion?: string
  /** What this build can read, written into its device record (C9: `epochs` for key epochs), so others can check. */
  capabilities?: Record<string, number>
  /** Awaited once per sync before anything is written to the drive; a throw aborts the run. */
  beforeUpload?: () => Promise<void>
}

/** Larger remote files are refused without being downloaded (§5.5). */
const MAX_FILE_BYTES = 64 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

/** Thrown by `syncOnce` when its signal aborts: a quiet stop, not a sync failure. */
export class SyncAborted extends Error {
  override name = 'AbortError'
  constructor() {
    super('Sync stopped')
  }
}

export const unverifiedMessage = (n: number) => `${n} synced files could not be verified and were ignored`

type Counts = Pick<SyncReport, 'pushed' | 'pulled' | 'conflicts'>

/** A doc being pulled into: `doc` holds what was stored at pull start plus every import since. */
interface PullState {
  doc: LoroDoc
  /** Stored version at pull start. */
  before: VersionVector
  pushed: VersionVector
  /** Boxes whose content this device changed since its last completed sync. */
  localEdited: Set<string>
  /** The doc at that last sync plus remote imports only: "theirs" in a conflict. */
  remoteOnly: LoroDoc | undefined
  conflicts: Map<string, { mine: string; device: string }>
  /** Boxes a remote change deleted while edited here, as they were before the import. */
  restores: Map<string, { box: BoxState; content: PMJSON | null }>
}

export const RESTORED_MESSAGE = 'A box deleted on another device was restored because you edited it'

const META = {
  pushed: (docId: string) => `pushed:${docId}`,
  seq: (docId: string) => `seq:${docId}`,
  chunks: (docId: string) => `chunks:${docId}`,
  snapshot: (docId: string) => `snapshot:${docId}`,
  stale: (docId: string) => `stale:${docId}`,
  /** The doc's version when this device last finished a sync: later local edits are "mine". */
  base: (docId: string) => `base:${docId}`,
  /** The device record last written, and when. */
  device: 'deviceRecord',
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
  private readonly appVersion: string | undefined
  private readonly capabilities: Record<string, number>
  private readonly beforeUpload: (() => Promise<void>) | undefined
  private signal: AbortSignal | undefined

  constructor(opts: SyncEngineOptions) {
    this.local = opts.local
    this.remote = opts.remote
    this.deviceId = opts.deviceId
    this.deviceName = opts.deviceName
    this.platform = opts.platform ?? ''
    this.compactAfter = opts.compactAfter ?? 50
    this.appVersion = opts.appVersion
    this.capabilities = opts.capabilities ?? {}
    this.beforeUpload = opts.beforeUpload
  }

  /**
   * Every failure becomes the report's status, except an abort through `signal`, which throws
   * `SyncAborted`. It is checked before each transfer and an aborted transfer is abandoned, so
   * the bookkeeping after it is never written.
   */
  async syncOnce(opts: { signal?: AbortSignal } = {}): Promise<SyncReport> {
    const counts: Counts = { pushed: 0, pulled: 0, conflicts: 0 }
    this.signal = opts.signal
    try {
      // Every write below (uploads and removals alike) comes after this.
      await this.beforeUpload?.()
      const pushedAt = new Map<string, VersionVector>()
      for (const docId of await this.local.docIds()) pushedAt.set(docId, await this.pushDoc(docId, counts))
      await this.pushBlobs()
      await this.writeDevice()
      await this.remote.flush?.()
      await this.pull(counts, pushedAt)
      await this.remote.flush?.()
      return { status: 'idle-synced', ...counts, at: Date.now() }
    } catch (err) {
      if (err instanceof SyncAborted || opts.signal?.aborted) throw new SyncAborted()
      return { status: statusOf(err), message: err instanceof Error ? err.message : String(err), ...counts, at: Date.now() }
    }
  }

  /** Rejects as soon as the signal aborts, leaving `work` to finish unobserved. */
  private transfer<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.signal
    if (!signal) return work()
    if (signal.aborted) return Promise.reject(new SyncAborted())
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new SyncAborted())
      signal.addEventListener('abort', onAbort, { once: true })
      work()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort))
    })
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

  /** Returns the doc version it considered. */
  private async pushDoc(docId: string, counts: Counts): Promise<VersionVector> {
    await this.removeStale(docId)
    const doc = await this.load(docId)
    const pushed = await this.pushedVersion(docId)
    const version = doc.oplogVersion()
    if (!ahead(version, pushed)) return version

    const seq = Number((await this.local.getMeta(META.seq(docId))) ?? 0) + 1
    const path = chunkPath(docId, this.deviceId, seq)
    await this.transfer(() => this.remote.upload(path, doc.export({ mode: 'update', from: pushed })))
    const chunks = [...(await this.jsonMeta<string[]>(META.chunks(docId), [])), path]
    await this.local.setMeta(META.seq(docId), String(seq))
    await this.local.setMeta(META.chunks(docId), JSON.stringify(chunks))
    await this.local.setBytesMeta(META.pushed(docId), version.encode())
    counts.pushed++

    if (chunks.length > this.compactAfter) await this.compact(docId, doc, seq + 1, chunks)
    return version
  }

  /**
   * Replaces this device's chunks for a doc with one snapshot. The snapshot is uploaded before
   * anything is removed, so a reader always finds either the chunks or a file covering them.
   */
  private async compact(docId: string, doc: LoroDoc, seq: number, chunks: string[]): Promise<void> {
    const path = snapshotPath(docId, this.deviceId, seq)
    await this.transfer(() => this.remote.upload(path, doc.export({ mode: 'snapshot' })))
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
      await this.transfer(() => this.remote.remove(stale[0]!))
      stale.shift()
      await this.local.setMeta(META.stale(docId), JSON.stringify(stale))
    }
  }

  private async pushBlobs(): Promise<void> {
    for (const name of await this.local.blobNames()) {
      if (await this.local.blobSynced(name)) continue
      const bytes = await this.local.readBlob(name)
      await this.transfer(() => this.remote.upload(`blobs/${name}`, bytes))
      await this.local.markBlobSynced(name)
    }
  }

  /**
   * Forgets what was pushed of every doc, so the next sync pushes each doc whole, other devices' ops included: after
   * a remote's history was replaced and its clone dropped (what was only in that clone is gone), or when a key
   * rotation must re-push notes pulled under the old keys (C9).
   */
  async forgetPushed(): Promise<void> {
    for (const docId of await this.local.docIds()) await this.local.setBytesMeta(META.pushed(docId), new VersionVector(null).encode())
  }

  private async writeDevice(): Promise<void> {
    // A rewrite per sync would be a commit per sync on git, so lastSeen is refreshed daily.
    const content = JSON.stringify({ ...this.capabilities, name: this.deviceName, platform: this.platform, appVersion: this.appVersion })
    const last = await this.jsonMeta<{ content: string; at: number } | null>(META.device, null)
    const now = Date.now()
    if (last && last.content === content && now - last.at < DAY_MS) return
    const record = { ...(JSON.parse(content) as object), lastSeen: now }
    await this.transfer(() => this.remote.upload(`devices/${this.deviceId}.json`, new TextEncoder().encode(JSON.stringify(record))))
    await this.local.setMeta(META.device, JSON.stringify({ content, at: now }))
  }

  private async pullState(docId: string): Promise<PullState> {
    const doc = await this.load(docId)
    const state: PullState = {
      doc,
      before: doc.oplogVersion(),
      pushed: await this.pushedVersion(docId),
      localEdited: new Set(),
      remoteOnly: undefined,
      conflicts: new Map(),
      restores: new Map()
    }
    const baseBytes = await this.local.getBytesMeta(META.base(docId))
    if (baseBytes) {
      const base = VersionVector.decode(baseBytes)
      const atBase = doc.forkAt(doc.vvToFrontiers(base))
      state.localEdited = boxesTouched(atBase, doc.export({ mode: 'update', from: base })).contentEdited
      state.remoteOnly = atBase
    }
    return state
  }

  /** Notes, before `bytes` is imported, the boxes it touches that this device also edited. */
  private detect(state: PullState, bytes: Uint8Array, device: string): void {
    state.remoteOnly?.import(bytes)
    if (state.localEdited.size === 0) return
    const touched = boxesTouched(state.doc, bytes)
    const page = new PageDoc(state.doc)
    for (const id of touched.contentEdited) {
      if (!state.localEdited.has(id)) continue
      const known = state.conflicts.get(id)
      state.conflicts.set(id, { mine: known?.mine ?? boxMarkdown(state.doc, id), device })
    }
    for (const id of touched.deleted) {
      const box = page.getBox(id)
      if (!state.localEdited.has(id) || state.restores.has(id) || !box) continue
      const content = page.contentMap(id)
      state.restores.set(id, { box, content: content ? contentToJSON(content) : null })
    }
  }

  private async settle(docId: string, state: PullState, counts: Counts): Promise<void> {
    for (const [boxId, { mine, device }] of state.conflicts) {
      await this.local.addConflict({
        id: newId(),
        pageId: docId,
        boxId,
        device,
        mine,
        theirs: state.remoteOnly ? boxMarkdown(state.remoteOnly, boxId) : '',
        merged: boxMarkdown(state.doc, boxId),
        at: Date.now()
      })
      counts.conflicts++
    }
    const page = new PageDoc(state.doc)
    const missing = [...state.restores.values()].filter(({ box }) => !page.getBox(box.id))
    if (missing.length === 0) return
    // A new local change (fresh box ids), so it goes out with this device's next push.
    const from = state.doc.oplogVersion()
    for (const { box, content } of missing) {
      const id = page.addBox({ x: box.x, y: box.y, width: box.width })
      if (box.private) page.updateBox(id, { private: true })
      const root = page.contentMap(id)
      if (root && content) writeContent(root, content.content ?? [])
    }
    state.doc.commit()
    await this.local.appendRemote(docId, state.doc.export({ mode: 'update', from }))
    for (let i = 0; i < missing.length; i++) await this.local.notify(RESTORED_MESSAGE)
  }

  private async pull(counts: Counts, pushedAt: Map<string, VersionVector>): Promise<void> {
    const cursor = (await this.local.getMeta(META.cursor)) ?? null
    const page = await this.transfer(() => this.remote.delta(cursor))
    const states = new Map<string, PullState>()
    const ownDeleted = new Set<string>()
    const ownPresent = new Set<string>()
    let unverified = 0
    for (const item of page.items) {
      if (!item.isFile) continue
      const parsed = parseRemotePath(item.path)
      if (parsed.kind !== 'chunk' && parsed.kind !== 'snapshot') continue
      if (parsed.deviceId === this.deviceId) {
        ;(item.deleted ? ownDeleted : ownPresent).add(item.path)
        continue
      }
      if (item.deleted || (await this.local.seen(item.id, item.eTag))) continue
      if (item.size !== undefined && item.size > MAX_FILE_BYTES) {
        await this.local.markSeen(item.id, item.eTag)
        unverified++
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = await this.transfer(() => this.remote.download(item.path))
      } catch (err) {
        // Compacted away since the listing; the snapshot that replaced it is in this delta too.
        if ((err as { status?: unknown }).status === 404) continue
        if ((err as { unverifiable?: unknown }).unverifiable === true) {
          await this.local.markSeen(item.id, item.eTag)
          unverified++
          continue
        }
        throw err
      }
      let state = states.get(parsed.docId)
      if (!state) {
        state = await this.pullState(parsed.docId)
        states.set(parsed.docId, state)
      }
      try {
        this.detect(state, bytes, parsed.deviceId)
        state.doc.import(bytes)
      } catch {
        // Bytes that are not a Loro update (a hostile or damaged remote) are skipped like unverifiable ones.
        await this.local.markSeen(item.id, item.eTag)
        unverified++
        continue
      }
      await this.local.appendRemote(parsed.docId, bytes)
      await this.local.markSeen(item.id, item.eTag)
      counts.pulled++
    }
    await this.local.setMeta(META.cursor, page.cursor)
    for (const [docId, state] of states) {
      await this.local.setBytesMeta(META.pushed(docId), this.afterPull(state).encode())
      await this.local.setBytesMeta(META.base(docId), state.doc.oplogVersion().encode())
      await this.settle(docId, state, counts)
    }
    for (const [docId, version] of pushedAt) {
      if (states.has(docId)) continue
      const bytes = version.encode()
      const stored = await this.local.getBytesMeta(META.base(docId))
      if (!stored || stored.length !== bytes.length || stored.some((b, i) => b !== bytes[i])) {
        await this.local.setBytesMeta(META.base(docId), bytes)
      }
    }
    await this.selfCheck([...pushedAt.keys()], ownDeleted, cursor === null ? ownPresent : undefined)
    if (unverified > 0) await this.local.notify(unverifiedMessage(unverified))
  }

  /**
   * §5.5: a file of ours that the remote lost (deleted, or absent from a full listing) is pushed
   * again by forgetting what was pushed, so the next push uploads the whole doc.
   */
  private async selfCheck(docIds: string[], deleted: Set<string>, present: Set<string> | undefined): Promise<void> {
    if (deleted.size === 0 && present === undefined) return
    for (const docId of docIds) {
      const snapshot = await this.local.getMeta(META.snapshot(docId))
      const believed = [...(await this.jsonMeta<string[]>(META.chunks(docId), [])), ...(snapshot ? [snapshot] : [])]
      if (!believed.some((p) => deleted.has(p) || (present !== undefined && !present.has(p)))) continue
      await this.local.setBytesMeta(META.pushed(docId), new VersionVector(null).encode())
    }
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

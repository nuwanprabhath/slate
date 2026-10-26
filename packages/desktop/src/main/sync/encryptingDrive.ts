import type { KeyHandle } from '@slate/native'
import { UnverifiableFileError, type DeltaPage, type RemoteDrive, type RemoteItem } from '@slate/sync'
import { openEnvelope, sealEnvelope, UnverifiableFile, type EnvelopeKeys } from '../vault/envelope'
import type { KeyRing } from '../vault/keyring'
import { blobRemoteName, decodeId, decodeIdV2, encodeId, encodeIdV2, type IdKind } from '../vault/names'
import { toHex, vaultNative } from '../vault/native'
import { readSuitesOf } from '../vault/profile'
import { epochOf, SUITE, type KeySchedule } from '../vault/suite'

/** Written only by compare-and-swap (E5); never handed to the engine. */
export const VAULT_PATH = 'e2ee/vault.json'

const ENGINE_DOC = /^docs\/(notebook|page)_([0-9a-f-]{36})\/([0-9a-f-]{36})\/(?:(\d{8,})\.chunk|snapshot-(\d{8,})\.bin)$/
const ENGINE_BLOB = /^blobs\/([a-f0-9]{64})\.[a-z0-9]{1,5}$/
const ENGINE_DEVICE = /^devices\/([0-9a-f-]{36})\.json$/
// Suite 0x01 names are 32 hex (one AES block), suite 0x02 names 64 hex (SIV ‖ C, audit §4.6). The name decoder
// of the vault's own suite decides; a name of the other length is never one of its own.
const REMOTE_DOC = /^e2ee\/d\/([0-9a-f]{32}|[0-9a-f]{64})\/([0-9a-f]{32}|[0-9a-f]{64})\/(?:(\d{8,})|s-(\d{8,}))\.c$/
const REMOTE_DEVICE = /^e2ee\/v\/([0-9a-f]{32}|[0-9a-f]{64})\.c$/
/** Ours, but not sync files: never counted as plaintext left behind. */
const QUIET = new Set(['README.md', 'e2ee/README.md', VAULT_PATH])

interface Mapped {
  remote: string
  deflate: boolean
  /** SLE2 Padmé padding: document chunks, snapshots and device records, never blobs (audit §4.5.3). */
  pad: boolean
  /** Blobs: the sha256 their bytes must have. */
  sha256?: string
}

type NameKey = 'sync' | 'name' | 'nameEnc' | 'nameMac'

/**
 * The engine's drive with every file sealed (§5.3) and renamed (§15 N1). The envelope binds the
 * engine path, which `delta` rebuilds from the decoded names, so a file moved, swapped or
 * forged on the remote fails to open and is skipped. Nothing that did not authenticate is returned.
 *
 * C9 (audit §4.7 R-2): files are written under the current key epoch only. Files of an earlier epoch whose master
 * key the ring holds (`history`) are listed and read under that epoch's keys until the rotating device has re-pushed
 * everything and removed them (`sweep`); files of an epoch the ring does not hold are never returned.
 */
export class EncryptingDrive implements RemoteDrive {
  /** Paths outside `e2ee/` that delta has shown and not since reported deleted (§7.6). */
  private readonly plaintext = new Set<string>()
  /** C9: remote document and device names of the current epoch that delta has shown. */
  private readonly current = new Set<string>()
  /** C9: engine path → the latest file of an earlier epoch (through `history`) that delta has shown for it. */
  private readonly older = new Map<string, { remote: string; epoch: number }>()
  /** C9: document and device files that are not the current epoch's (older epochs, or no key the ring holds). */
  private readonly stale = new Set<string>()
  /** Review C9 M2: the stale files positively identified as an earlier epoch's (their names decode under `history`). */
  private readonly oldRemotes = new Set<string>()
  /** Files that did not authenticate when read: never counted as pulled. */
  private readonly unverifiable = new Set<string>()
  /** C9: blob names delta has shown (one-way names, so each epoch's name of a blob is computed, never decoded). */
  private readonly blobsSeen = new Set<string>()
  /** A listing from scratch has been seen, so `stale` is complete. */
  private full = false
  /** C9: files read through `history` since `takeOldReads` last asked. */
  private oldReads = 0

  constructor(
    private readonly inner: RemoteDrive,
    private readonly keys: KeyRing,
  ) {}

  /** Files an older Slate wrote unencrypted; shown as a warning. */
  get plaintextItemsSeen(): number {
    return this.plaintext.size
  }

  /**
   * C9 (R-2): document and device files left from an earlier key epoch, once a listing from scratch has been seen;
   * null until then. Zero means no file of any earlier epoch remains, so `history` can drop them.
   */
  staleFiles(): number | null {
    return this.full ? this.oldRemotes.size : null
  }

  /** Review C9 L3: device records listed whose names decode under no key this ring holds. */
  unreadableDeviceRecords(): number {
    return [...this.stale].filter((r) => REMOTE_DEVICE.test(r) && !this.oldRemotes.has(r)).length
  }

  /**
   * Review C9 M2, before a conversion (whose history is empty): the remote names of this epoch's files after a listing
   * from scratch, and of the images this device holds, minus any that did not authenticate. Once a complete sync has
   * pulled them, they are what the conversion may later remove as positively superseded.
   */
  async currentFiles(localBlobs: Iterable<string>): Promise<Set<string>> {
    await this.delta(null)
    const out = new Set<string>([...this.current].filter((r) => !this.unverifiable.has(r)))
    for (const name of localBlobs) {
      const remote = this.map(`blobs/${name}`).remote
      if (this.blobsSeen.has(remote)) out.add(remote)
    }
    return out
  }

  /**
   * C9: how many files were read under an earlier epoch's keys since the last call. Their ops came from another device,
   * which this device's engine never pushes again, so the runner re-pushes and syncs again before it sweeps them.
   */
  takeOldReads(): number {
    const n = this.oldReads
    this.oldReads = 0
    return n
  }

  /** The current epoch's keys (null), or an earlier epoch's from `history`; null when the ring does not hold it. */
  private codec(epoch: number | null): { schedule: KeySchedule; get: (name: NameKey) => KeyHandle } | null {
    if (epoch === null) return { schedule: this.keys.schedule, get: (name) => this.keys.get(name) }
    return this.keys.epochKeys(epoch)
  }

  private encodeName(kind: IdKind, uuid: string): string {
    return isV2(this.keys.schedule) ? encodeIdV2({ enc: this.keys.get('nameEnc'), mac: this.keys.get('nameMac') }, kind, uuid) : encodeId(this.keys.get('nameEnc'), kind, uuid)
  }

  /** A name decodes only under keys of its own suite (64 hex: 0x02, 32 hex: 0x01). */
  private decodeName(hex: string, epoch: number | null): { kind: IdKind; uuid: string } | null {
    const c = this.codec(epoch)
    if (!c) return null
    if (isV2(c.schedule)) return hex.length === 64 ? decodeIdV2({ enc: c.get('nameEnc'), mac: c.get('nameMac') }, hex) : null
    return hex.length === 32 ? decodeId(c.get('nameEnc'), hex) : null
  }

  /** The vault's suite and epoch (or an earlier epoch's, to read), and the suites its profile reads; a closed ring throws Locked. */
  private envelopeKeys(epoch: number | null = null): EnvelopeKeys {
    const c = this.codec(epoch)
    if (!c) throw new UnverifiableFile('This file was sealed under a key this vault does not hold')
    return { syncKey: c.get('sync'), suite: c.schedule.suite, keyEpoch: epochOf(c.schedule), readSuites: readSuitesOf(this.keys.schedule) }
  }

  private map(path: string): Mapped {
    const doc = ENGINE_DOC.exec(path)
    if (doc) {
      const [, kind, docUuid, devUuid, chunk, snapshot] = doc as unknown as [string, 'notebook' | 'page', string, string, string?, string?]
      const [docName, devName] = [this.encodeName(kind, docUuid), this.encodeName('device', devUuid)]
      const file = chunk !== undefined ? `${chunk}.c` : `s-${snapshot!}.c`
      return { remote: `e2ee/d/${docName}/${devName}/${file}`, deflate: true, pad: true }
    }
    const device = ENGINE_DEVICE.exec(path)
    if (device) return { remote: `e2ee/v/${this.encodeName('device', device[1]!)}.c`, deflate: true, pad: true }
    const blob = ENGINE_BLOB.exec(path)
    if (blob) {
      const name = path.slice('blobs/'.length)
      return { remote: `e2ee/b/${blobRemoteName(this.keys.get('name'), name)}`, deflate: false, pad: false, sha256: blob[1]! }
    }
    throw new Error(`Not an encryptable sync path: ${path}`)
  }

  /** The engine path for a remote name under one epoch's keys, or null for anything that is not one of its files. */
  private unmapUnder(remote: string, epoch: number | null): string | null {
    const doc = REMOTE_DOC.exec(remote)
    if (doc) {
      const [, docName, devName, chunk, snapshot] = doc as unknown as [string, string, string, string?, string?]
      const [d, v] = [this.decodeName(docName, epoch), this.decodeName(devName, epoch)]
      if (!d || d.kind === 'device' || v?.kind !== 'device') return null
      const file = chunk !== undefined ? `${chunk}.chunk` : `snapshot-${snapshot!}.bin`
      return `docs/${d.kind}_${d.uuid}/${v.uuid}/${file}`
    }
    const device = REMOTE_DEVICE.exec(remote)
    if (device) {
      const v = this.decodeName(device[1]!, epoch)
      return v?.kind === 'device' ? `devices/${v.uuid}.json` : null
    }
    // Blob names are one-way; the engine fetches blobs by name and never needs them listed.
    return null
  }

  /** The current epoch first, then the earlier ones the ring holds (newest first). */
  private unmap(remote: string): { path: string; epoch: number | null } | null {
    for (const epoch of [null, ...this.keys.historyEpochs]) {
      const path = this.unmapUnder(remote, epoch)
      if (path !== null) return { path, epoch }
    }
    return null
  }

  async upload(path: string, bytes: Uint8Array): Promise<void> {
    const { remote, deflate, pad } = this.map(path)
    const sealed = sealEnvelope(this.envelopeKeys(), path, bytes, { deflate, pad })
    await this.inner.upload(remote, sealed)
    if (!remote.startsWith('e2ee/b/')) this.current.add(remote)
    else if (this.blobsSeen.size > 0) this.blobsSeen.add(remote)
  }

  /** Where `path` is read from: the current epoch's file, or else an earlier epoch's that delta has shown (C9). */
  private source(path: string, mapped: Mapped): { remote: string; epoch: number | null } {
    if (mapped.sha256 !== undefined) {
      if (this.blobsSeen.size === 0 || this.blobsSeen.has(mapped.remote)) return { remote: mapped.remote, epoch: null }
      const name = path.slice('blobs/'.length)
      for (const epoch of this.keys.historyEpochs) {
        const remote = `e2ee/b/${blobRemoteName(this.keys.epochKeys(epoch)!.get('name'), name)}`
        if (this.blobsSeen.has(remote)) return { remote, epoch }
      }
      return { remote: mapped.remote, epoch: null }
    }
    const old = this.older.get(path)
    return old && !this.current.has(mapped.remote) ? old : { remote: mapped.remote, epoch: null }
  }

  async download(path: string): Promise<Uint8Array> {
    const mapped = this.map(path)
    const { remote, epoch } = this.source(path, mapped)
    // Drive errors (404, offline) pass through as they are; only the contents are judged here.
    const sealed = await this.inner.download(remote)
    // A closed vault (Locked) or the module itself failing (its error state, a destroyed handle, a full
    // handle table) says nothing about this file: rethrown, so the engine retries it instead of skipping
    // an authentic file for good (review C4 L1). Only a file that does not authenticate is unverifiable.
    const keys = this.envelopeKeys(epoch)
    let plain: Uint8Array
    try {
      plain = openEnvelope(keys, path, sealed)
    } catch (err) {
      if (err instanceof UnverifiableFile) {
        this.unverifiable.add(remote)
        throw new UnverifiableFileError(undefined, { cause: err })
      }
      throw err
    }
    if (mapped.sha256 !== undefined && toHex(vaultNative().sha256(plain)) !== mapped.sha256) {
      throw new UnverifiableFileError('This image does not match its name')
    }
    if (epoch !== null) this.oldReads++
    return plain
  }

  async remove(path: string): Promise<void> {
    await this.inner.remove(this.map(path).remote)
  }

  async delta(cursor: string | null): Promise<DeltaPage> {
    const page = await this.inner.delta(cursor)
    const items: RemoteItem[] = []
    for (const item of page.items) {
      if (item.path.startsWith('e2ee/')) {
        const found = this.track(item)
        if (found !== null) items.push({ ...item, path: found })
        continue
      }
      if (item.path === '' || QUIET.has(item.path) || !item.isFile) continue
      if (item.deleted) this.plaintext.delete(item.path)
      else this.plaintext.add(item.path)
    }
    if (cursor === null) this.full = true
    return { items, cursor: page.cursor }
  }

  /** C9: files each listed document, device and blob file under the epoch it belongs to; returns its engine path, if any. */
  private track(item: RemoteItem): string | null {
    const { path: remote, deleted } = item
    if (remote.startsWith('e2ee/b/')) {
      if (deleted) this.blobsSeen.delete(remote)
      else this.blobsSeen.add(remote)
      return null
    }
    if (!REMOTE_DOC.test(remote) && !REMOTE_DEVICE.test(remote)) return null
    const found = this.unmap(remote)
    if (found !== null && found.epoch === null) {
      if (deleted) this.current.delete(remote)
      else this.current.add(remote)
      return found.path
    }
    if (deleted) {
      // An old epoch's file going is the sweep, never a loss: the engine would otherwise re-push the doc it named.
      this.stale.delete(remote)
      this.oldRemotes.delete(remote)
      if (found && this.older.get(found.path)?.remote === remote) this.older.delete(found.path)
      return null
    }
    this.stale.add(remote)
    if (found) {
      this.older.set(found.path, { remote, epoch: found.epoch! })
      this.oldRemotes.add(remote)
    }
    return found?.path ?? null
  }

  /**
   * C9 (R-2), on the rotating device only, once everything was re-pushed under the current epoch. Review C9 M2: only
   * what is positively identified as superseded goes: document and device files whose names decode under an earlier
   * epoch in `history`, the earlier epochs' names of the images this device holds (re-pushed under the current one),
   * and `superseded` (what a conversion listed and pulled under the old keys before it converted). Anything else this
   * ring cannot read is kept, and counted as `kept`.
   */
  async sweep(localBlobs: Iterable<string>, superseded: ReadonlySet<string>): Promise<{ removed: number; kept: number }> {
    if (!this.full) throw new Error('A full listing must come before the old files are removed')
    const keep = new Set<string>()
    const oldBlobs = new Set<string>()
    for (const name of localBlobs) {
      keep.add(this.map(`blobs/${name}`).remote)
      for (const epoch of this.keys.historyEpochs) oldBlobs.add(`e2ee/b/${blobRemoteName(this.keys.epochKeys(epoch)!.get('name'), name)}`)
    }
    const identified = (r: string) => this.oldRemotes.has(r) || superseded.has(r)
    const docs = [...this.stale]
    const blobs = [...this.blobsSeen].filter((b) => !keep.has(b))
    const gone = [...docs.filter(identified), ...blobs.filter((b) => oldBlobs.has(b) || superseded.has(b))]
    for (const remote of gone) await this.inner.remove(remote)
    await this.inner.flush?.()
    for (const remote of gone) {
      this.stale.delete(remote)
      this.oldRemotes.delete(remote)
      this.blobsSeen.delete(remote)
    }
    this.older.clear()
    return { removed: gone.length, kept: docs.length + blobs.length - gone.length }
  }

  async flush(): Promise<void> {
    // §7.6: gone from the tree with this commit; history keeps them, and the warning stays until delta reports them deleted.
    for (const path of this.plaintext) await this.inner.remove(path)
    await this.inner.flush?.()
  }
}

const isV2 = (schedule: KeySchedule): boolean => schedule.suite === SUITE.KBKDF_AES256GCM

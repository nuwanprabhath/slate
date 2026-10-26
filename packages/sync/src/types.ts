export interface RemoteItem {
  id: string
  /** Relative to the app folder, e.g. `docs/page_x/dev1/00000001.chunk`; '' for items outside it. */
  path: string
  eTag: string
  deleted: boolean
  isFile: boolean
  /** Bytes, when the drive reports it: the engine refuses oversized files without fetching them. */
  size?: number
}

export interface DeltaPage {
  items: RemoteItem[]
  cursor: string
}

export interface RemoteDrive {
  upload(path: string, bytes: Uint8Array): Promise<void>
  download(path: string): Promise<Uint8Array>
  remove(path: string): Promise<void>
  /** All changes since `cursor` (null = from scratch), following paging; returns the next cursor. */
  delta(cursor: string | null): Promise<DeltaPage>
  /** Publishes the writes so far, for drives that batch them (git: commit and push). */
  flush?(): Promise<void>
}

/** The drive could not be reached; sync reports `offline` and tries again later. */
export class OfflineError extends Error {
  readonly offline = true

  constructor(message = 'Offline', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OfflineError'
  }
}

/** A remote file that did not authenticate, or is too large to try; the engine skips it. */
export class UnverifiableFileError extends Error {
  readonly unverifiable = true

  constructor(message = 'This synced file could not be verified', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UnverifiableFileError'
  }
}

/**
 * The remote branch shares no history with this clone (another device replaced it, as encrypting
 * does), or became encrypted under a plaintext clone. Replaying local commits onto it would publish
 * them, so the drive stops instead.
 */
export class UnrelatedHistoryError extends Error {
  readonly unrelatedHistory = true

  constructor(readonly encryptedRemote: boolean) {
    super(
      encryptedRemote
        ? 'The sync folder is now encrypted by another device; join it before syncing again'
        : 'The sync folder was replaced and shares no history with this device; Slate will not sync to it',
    )
    this.name = 'UnrelatedHistoryError'
  }
}

export type SyncStatus = 'idle-synced' | 'syncing' | 'offline' | 'error' | 'signed-out' | 'disabled'

export interface SyncReport {
  status: SyncStatus
  message?: string
  pushed: number
  pulled: number
  conflicts: number
  at: number
}

export interface ConflictRecord {
  id: string
  pageId: string
  boxId: string
  device: string
  mine: string
  theirs: string
  merged: string
  at: number
}

export interface LocalStore {
  docIds(): Promise<string[]>
  loadDoc(docId: string): Promise<Uint8Array[]>
  /**
   * Appends updates the sync engine made: other devices' files, and restored boxes. What gets
   * pushed is decided by version, so remote ops are never pushed back and restores are.
   */
  appendRemote(docId: string, update: Uint8Array): Promise<void>
  getMeta(key: string): Promise<string | undefined>
  setMeta(key: string, value: string): Promise<void>
  getBytesMeta(key: string): Promise<Uint8Array | undefined>
  setBytesMeta(key: string, value: Uint8Array): Promise<void>
  seen(itemId: string, eTag: string): Promise<boolean>
  markSeen(itemId: string, eTag: string): Promise<void>
  blobNames(): Promise<string[]>
  readBlob(name: string): Promise<Uint8Array>
  blobSynced(name: string): Promise<boolean>
  markBlobSynced(name: string): Promise<void>
  addConflict(c: ConflictRecord): Promise<void>
  notify(message: string): Promise<void>
}

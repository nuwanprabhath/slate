import { join } from 'node:path'
import type { KeyHandle } from '@slate/native'
import { CH } from '../shared/ipc'
import { DbBlobStore, FileBlobStore, type BlobStore } from './blobs'
import { openDatabase, type Database } from './db/openDatabase'
import { assertNotesMayOpen } from './db/dbModule'
import { createExternalWatch } from './externalWatch'
import type { ScopedLog } from './log/logger'
import { ImportService } from './onenote/importService'
import { SearchIndex } from './search/searchIndex'
import { DocStore } from './store'
import { SyncService, type SyncServiceDeps } from './sync/syncService'
import { ThemeStore } from './theme/themeStore'
import { Locked, type KeyRing } from './vault/keyring'
import type { VaultRemote } from './vault/remoteVault'

type ImportDeps = Omit<ConstructorParameters<typeof ImportService>[0], 'dbFile' | 'dbKey' | 'blobs' | 'emit'>

export interface ServiceContext {
  dataDir: string
  /** To every window; dropped once the lock sequence mutes the services. */
  emit(channel: string, payload: unknown): void
  sync: Omit<SyncServiceDeps, 'dbFile' | 'dbKey' | 'blobs' | 'emitStatus' | 'emitNotice' | 'emitOpenNotebook' | 'checkVault' | 'afterSync'>
  importer: ImportDeps
  watchLog?: ScopedLog
  /** §7.3: the vault check before each sync upload, given this opening's key ring (null: plaintext). */
  checkVault?: (remote: VaultRemote, keyRing: KeyRing | null) => Promise<void>
  /** C9: the rekey runner after each sync run of an encrypted device (`Migration.afterSync`). */
  afterSync?: (outcome: Parameters<NonNullable<SyncServiceDeps['afterSync']>>[0], keyRing: KeyRing) => Promise<boolean>
}

export interface Services {
  readonly store: DocStore
  readonly blobs: BlobStore
  readonly search: SearchIndex
  readonly sync: SyncService
  readonly importer: ImportService
  readonly themes: ThemeStore
  /** Null for a plaintext data folder. */
  readonly keyRing: KeyRing | null
  /** Re-indexes and tells the windows about a document another connection wrote. */
  checkExternal(): void
  muteEvents(): void
  stopSync(): Promise<void>
  closeWatch(): void
  closeDatabases(): void
}

let current: Services | null = null

/** §6.2: the one owner of everything that touches notes. Code reaches it at the moment of use, never keeps it. */
export function services(): Services {
  if (!current) throw new Locked()
  return current
}

export function servicesOpen(): boolean {
  return current !== null
}

/**
 * Opens the notes. With a key ring the database is the encrypted `dbFile` (keyed with this device's
 * LK) and images live inside it; without one it is the plaintext `slate.db` with the image folder.
 */
export function openServices(keyRing: KeyRing | null, dbFile: string, ctx: ServiceContext): Services {
  assertNotesMayOpen('openServices')
  if (current) throw new Error('Services are already open')
  let muted = false
  const emit = (channel: string, payload: unknown) => {
    if (!muted) ctx.emit(channel, payload)
  }
  // LK is the key ring's handle (C4: it was unwrapped inside the module and never existed as bytes);
  // every connection opens with it, and the ring destroys it at lock.
  const lk = keyRing?.get('lk') ?? null
  const opened = (handle: KeyHandle | null) => {
    const key = () => handle
    const store = new DocStore(dbFile, { key: key() })
    let blobDb: Database.Database | null = null
    let blobs: BlobStore
    if (keyRing) {
      blobDb = openDatabase(dbFile, key())
      blobs = new DbBlobStore(blobDb)
    } else {
      blobs = new FileBlobStore(join(ctx.dataDir, 'blobs'))
    }
    const search = new SearchIndex(store)
    const themes = new ThemeStore(store)
    themes.onChange((saved) => emit(CH.themesChanged, saved))
    const importer = new ImportService({ ...ctx.importer, dbFile, dbKey: key(), blobs, emit: (p) => emit(CH.onenoteProgress, p) })
    const sync = new SyncService({
      ...ctx.sync,
      dbFile,
      dbKey: key(),
      // Encrypted devices sync through EncryptingDrive: nothing leaves this machine unsealed.
      ...(keyRing ? { keyRing } : {}),
      ...(ctx.checkVault ? { checkVault: (remote: VaultRemote) => ctx.checkVault!(remote, keyRing) } : {}),
      ...(ctx.afterSync && keyRing ? { afterSync: (outcome) => ctx.afterSync!(outcome, keyRing) } : {}),
      blobs,
      emitStatus: (state) => emit(CH.syncStatusEvent, state),
      emitNotice: (message) => emit(CH.syncNotice, message),
      emitOpenNotebook: (notebookId) => emit(CH.syncOpenNotebook, notebookId),
    })
    return { store, blobDb, blobs, search, themes, importer, sync }
  }
  const { store, blobDb, blobs, search, themes, importer, sync } = opened(lk)
  const watch = createExternalWatch(
    store,
    (batches) => {
      // Agents and sync write through other connections; their page and notebook edits re-index here.
      for (const { docId } of batches) search.docChanged(docId)
      emit(CH.externalUpdates, batches)
    },
    ctx.watchLog,
  )
  let watching = true
  const closeWatch = () => {
    if (watching) watch.stop()
    watching = false
  }
  let syncStopped = false
  const svc: Services = {
    store,
    blobs,
    search,
    sync,
    importer,
    themes,
    keyRing,
    checkExternal: () => watch.check(),
    muteEvents: () => {
      muted = true
    },
    stopSync: async () => {
      if (!syncStopped) await sync.stop()
      syncStopped = true
    },
    closeWatch,
    closeDatabases: () => {
      if (current === svc) current = null
      closeWatch()
      if (!syncStopped) sync.close()
      syncStopped = true
      importer.close()
      search.close()
      blobDb?.close()
      store.close()
    },
  }
  current = svc
  return svc
}

/** At quit: everything, without waiting for a sync in flight. */
export function closeServices(): void {
  current?.closeDatabases()
}

/**
 * Erasure (GDPR-04 and GDPR-06, review §3.5 steps 3-4): a document's edit history, or everything
 * Slate keeps on this computer.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { importParts, NotebookDoc, PageDoc, withHandles } from '@slate/core'
import { LoroDoc } from 'loro-crdt'
import { LOCK_FILE } from '../lock'
import type { DocStore } from '../store'
import { MIGRATION_FILE } from '../vault/migration'
import { PQ_CANDIDATE_FILE } from '../vault/pqUpgrade'
import type { ProfileId } from '../vault/profile'
import { PROFILE_FLOOR_FILE } from '../vault/profileFloor'
import { QUICK_UNLOCK_FILE } from '../vault/quickUnlock'
import { SEEN_FILE } from '../vault/seen'
import {
  CANDIDATE_FILE,
  LOCAL_KEYS_FILE,
  PENDING_FILE,
  PREUNLOCK_FILE,
  PREV_FILE,
  REJOIN_KEYS_FILE,
  REJOIN_VAULT_FILE,
  SYNCED_FILE,
  VAULT_FILE,
} from '../vault/unlock'
import { THROTTLE_FILE } from '../vault/unlockThrottle'

/**
 * What erasing a history uses of `DocStore`: `replaceWithSnapshot` (one transaction on compact's path that keeps the
 * doc's sequence moving, never remove + append: FX-6), `wasSynced`, `optimizeSearch` (the search index's deletes only
 * mark entries until its segments merge) and `vacuum` (checkpoint, then VACUUM, so the freed pages leave the file and
 * the WAL).
 */
export type HistoryStore = Pick<DocStore, 'load' | 'wasSynced' | 'replaceWithSnapshot' | 'optimizeSearch' | 'vacuum'>

export class SyncIsOn extends Error {
  constructor() {
    super('Turn sync off first: other devices keep their own history and would bring it back until they are erased too.')
    this.name = 'SyncIsOn'
  }
}

/**
 * A doc another device may hold. Its history erased here, the two copies could each hold edits the other cannot
 * merge: the devices would keep diverging versions of it (packages/sync/test/erasedHistory.test.ts).
 */
export class HistoryWasSynced extends Error {
  constructor() {
    super('This page has been synced, so another device may have it. Its edit history can only be erased while it exists on this computer alone.')
    this.name = 'HistoryWasSynced'
  }
}

export class HistoryEraseUnavailable extends Error {
  constructor(why: string) {
    super(`Erasing edit history is not available in this build: ${why}`)
    this.name = 'HistoryEraseUnavailable'
  }
}

/**
 * Whether Slate's own loaders (`PageDoc.fromUpdates`, `NotebookDoc.fromUpdates`) read a shallow
 * snapshot followed by a later edit, which Loro 1.17's `importBatch` alone does not (`importParts`).
 * If they did not, an erased page would open empty after its next edit.
 */
export function loadersReadShallowHistory(): boolean {
  const doc = new LoroDoc()
  try {
    const { shallow, edit } = withHandles((h) => {
      const text = h.own(doc.getText('probe'))
      // Two commits before the shallow point: with only one, 1.17's importBatch happens to cope.
      text.insert(0, 'a')
      doc.commit()
      text.insert(1, 'b')
      doc.commit()
      const snapshot = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })
      const from = doc.oplogVersion()
      text.insert(2, 'c')
      doc.commit()
      return { shallow: snapshot, edit: doc.export({ mode: 'update', from }) }
    })
    const page = PageDoc.fromUpdates([shallow, edit])
    const notebook = NotebookDoc.fromUpdates([shallow, edit])
    try {
      return withHandles((h) => h.own(page.doc.getText('probe')).toString() === 'abc' && h.own(notebook.doc.getText('probe')).toString() === 'abc')
    } finally {
      page.doc.free()
      notebook.doc.free()
    }
  } finally {
    doc.free()
  }
}

/** Why erasing a history is refused in this build, or null when it is not. */
export function historyEraseBlocker(): string | null {
  return loadersReadShallowHistory() ? null : 'Slate could not reopen a page whose history was erased.'
}

/**
 * Replaces a doc's history with its current state: a shallow snapshot at the doc's own frontier keeps
 * every current value and no deleted text. Refused while sync is on, and for a doc that was ever synced:
 * another device's edits made before it received the erased doc build on history this one no longer has,
 * so neither could take the other's, and an open window on a device that adopted the erased doc would
 * write edits its store could never load again (`replaceDoc` in packages/sync/src/types.ts).
 */
export function eraseDocHistory(
  store: HistoryStore,
  docId: string,
  syncOn: boolean,
  changed: (docId: string) => void,
  blocker: () => string | null = historyEraseBlocker,
): void {
  if (syncOn) throw new SyncIsOn()
  const blocked = blocker()
  if (blocked !== null) throw new HistoryEraseUnavailable(blocked)
  if (store.wasSynced(docId)) throw new HistoryWasSynced()
  const parts = store.load(docId)
  if (parts.length === 0) throw new Error('There is no such page or notebook.')
  const doc = new LoroDoc()
  let shallow: Uint8Array
  try {
    const status = importParts(doc, parts)
    // An update waiting on one that never arrived is not in the state: dropping it would lose that edit.
    if (status.pending !== null && status.pending.size > 0) throw new Error('Part of this document has not arrived yet; try again after it has.')
    shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })
  } finally {
    doc.free()
  }
  store.replaceWithSnapshot(docId, shallow)
  store.optimizeSearch()
  store.vacuum()
  changed(docId)
}

/** Under the data folder: what erase-all deletes. The folder itself stays, and so does `slate.lock`, held by this process. */
const VAULT_FILES = [
  VAULT_FILE,
  PENDING_FILE,
  CANDIDATE_FILE,
  SYNCED_FILE,
  PREV_FILE,
  LOCAL_KEYS_FILE,
  PREUNLOCK_FILE,
  REJOIN_VAULT_FILE,
  REJOIN_KEYS_FILE,
  MIGRATION_FILE,
  QUICK_UNLOCK_FILE,
  THROTTLE_FILE,
  SEEN_FILE,
  PQ_CANDIDATE_FILE,
  PROFILE_FLOOR_FILE,
]
// update-result.json.download: the updater's pending-download sidecar (platformInstaller.ts), naming a path in the home folder.
const ERASED_FILES: readonly string[] = [...VAULT_FILES, 'msal-cache.bin', 'update-result.json', 'update-result.json.download']
const ERASED_DIRS = ['blobs', 'git-sync', 'logs', 'security-log']
/**
 * The plaintext database and an encrypted one (`slate-<8 hex>.db`), with their journals, and the temp copies a
 * migration or rejoin interrupted mid-way left (`copyAndEncrypt`, `copyAndRekey`): once the vault files are gone,
 * no start would remove them, and the first step's is a plaintext copy of the notes.
 */
const DATABASE = /^slate(-[0-9a-f]{8})?\.db((\.enc)?\.tmp)?(-wal|-shm|-journal)?$/
/** A `writeJsonAtomic` temp file a crash left beside one of the files above. */
const ATOMIC_TEMP = /^\.(.+)\.[0-9a-f-]{13}\.tmp$/

/** The names in the data folder that erase-all removes; anything else (Chromium's own folders, `slate.lock`) is left. */
export function erasableNames(entries: readonly string[], profile: ProfileId | null): string[] {
  const named = new Set([...ERASED_FILES, ...ERASED_DIRS, ...(profile === 'fips-140-3' ? [] : ['fips'])])
  return entries.filter((n) => n !== LOCK_FILE && (named.has(n) || DATABASE.test(n) || ERASED_FILES.includes(ATOMIC_TEMP.exec(n)?.[1] ?? '')))
}

export interface EraseAllSteps {
  dataDir: string
  /** Read before anything closes: a fips-140-3 vault keeps `fips/`, which its next start's self-test needs. */
  profile: ProfileId | null
  /** The Microsoft sign-out; runs first, while the settings it reads its client id from are open. */
  signOut: () => Promise<void>
  closeNotes: () => Promise<void>
  /** Each keyring-sealed file, cleared through `SecretFile.clear` (drops the session copy too). */
  secrets: ReadonlyArray<{ name: string; clear: () => Promise<void> }>
  forgetQuickUnlock: () => Promise<void>
  /** Chromium's localStorage, session storage, caches (GDPR-18). */
  clearBrowserStorage: () => Promise<void>
  sweepTemp: () => Promise<number>
  /** Logs by step name only: never a path under the person's home or anything read from a note. */
  warn: (step: string, error: unknown) => void
}

export interface EraseAllReport {
  removed: string[]
  /** Steps or names that could not be removed; the rest still ran. */
  failed: string[]
}

/** Every step is best-effort: one that fails is reported, and the next still runs. */
export async function eraseEverything(s: EraseAllSteps): Promise<EraseAllReport> {
  const report: EraseAllReport = { removed: [], failed: [] }
  const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch (e) {
      report.failed.push(name)
      s.warn(name, e)
    }
  }
  await step('microsoft sign-out', s.signOut)
  await step('close notes', s.closeNotes)
  for (const secret of s.secrets) await step(secret.name, secret.clear)
  await step('quick unlock', s.forgetQuickUnlock)
  let entries: string[] = []
  await step('list data folder', async () => {
    entries = await readdir(s.dataDir)
  })
  for (const name of erasableNames(entries, s.profile)) {
    await step(name, async () => {
      await rm(join(s.dataDir, name), { recursive: true, force: true, maxRetries: 3 })
      report.removed.push(name)
    })
  }
  await step('browser storage', s.clearBrowserStorage)
  await step('temp folders', s.sweepTemp)
  return report
}

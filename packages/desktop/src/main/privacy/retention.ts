/**
 * Retention, purge and the security log's view (GDPR review §3.4: GDPR-04, 07, 08, 13, 14). The
 * signatures are the contract with index.ts and `privacy/ipc.ts`.
 */
import { lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { importParts, PageDoc } from '@slate/core'
import type { PurgeReport, PurgeScope } from '../../shared/api'
import type { BlobStore } from '../blobs'
import { log, securityLog } from '../log/logger'
import { liveBackupDirs, ONE2HTML_TMP_PREFIX } from '../onenote/backup'
import type { SearchIndex } from '../search/searchIndex'
import type { DocStore } from '../store'
import type { SyncService } from '../sync/syncService'
import { THEME_TMP_PREFIX } from '../theme/claudeOneShot'
import type { ProfileId } from '../vault/profile'

export type { PurgeReport, PurgeScope }

export { THEME_TMP_PREFIX }

/** A theme run's folder younger than this may still be its working directory, so the sweep leaves it. */
const THEME_RUN_MAX_MS = 60 * 60 * 1000

const SECURITY_LOG_KEPT = 'A fips-140-3 vault keeps the security log (audit AU-2), so it was not cleared.'

/** The notes' profile does not allow this (a fips-140-3 vault keeps its AU-2 record). */
export class ProfileForbids extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileForbids'
  }
}

/** Accessors index.ts builds once; each `() =>` reads the open services at call time and throws `Locked` while closed. */
export interface RetentionDeps {
  store: () => DocStore
  blobs: () => BlobStore
  search: () => SearchIndex
  sync: () => SyncService
  /** The data folder (`app.getPath('userData')`). */
  dataDir: string
  /** The open vault's profile; null without a vault (or while locked). */
  profile: () => ProfileId | null
  /** The open store's `gdprStrictMode`; true while locked (fail closed). */
  strict: () => boolean
  /** `os.tmpdir()`, where `slate-one2html-*` and `slate-theme-*` folders are left by a crash. */
  tmpDir: string
}

export interface Retention {
  purge(scope: PurgeScope): Promise<PurgeReport>
  clearAudit(): void
  readSecurityLog(): string
  /** Refused under fips-140-3 (AU-2 keeps the record). */
  clearSecurityLog(): void
  /** Removes stray temp folders this user owns; resolves to how many it removed. */
  sweepTemp(): Promise<number>
}

/** For tests: the free bytes on the disk holding `dir`. */
export interface RetentionOptions {
  freeBytes?: (dir: string) => number
}

const BLOB_URL = /slate-blob:\/\/blob\/([a-f0-9]{64}\.[a-z0-9]{1,5})/g
/** A blob name in raw update bytes, for a doc whose updates Loro could not all apply yet. */
const BLOB_NAME = /[a-f0-9]{64}\.[a-z0-9]{1,5}/g

function addUrls(text: string, into: Set<string>): void {
  for (const m of text.matchAll(BLOB_URL)) into.add(m[1]!)
}

/**
 * The images something still refers to: every page's boxes, read through `PageDoc` as the search index
 * reads them, every other doc's JSON, and unresolved conflicts (resolving one can bring its text back).
 * `pending` holds names seen in the raw rows of a doc with updates Loro is still waiting on: those
 * edits are not in the doc's state yet, and an image one of them adds must survive until it applies.
 */
function imageReferences(store: DocStore): { referenced: Set<string>; pending: Set<string> } {
  const referenced = new Set<string>()
  const pending = new Set<string>()
  for (const docId of store.list('')) {
    const parts = store.load(docId)
    const doc = new LoroDoc()
    try {
      const status = importParts(doc, parts)
      if (status.pending && status.pending.size > 0) {
        for (const part of parts) for (const m of Buffer.from(part).toString('latin1').matchAll(BLOB_NAME)) pending.add(m[0])
      }
      if (docId.startsWith('page:')) {
        const page = new PageDoc(doc)
        for (const box of page.listBoxes()) addUrls(JSON.stringify(page.boxContent(box.id) ?? {}), referenced)
      } else {
        addUrls(JSON.stringify(doc.toJSON()), referenced)
      }
    } finally {
      doc.free()
    }
  }
  for (const c of store.listConflicts()) addUrls(`${c.mine}\n${c.theirs}\n${c.merged}`, referenced)
  return { referenced, pending }
}

function diskFree(dir: string): number {
  const s = statfsSync(dir)
  return s.bavail * s.bsize
}

export function createRetention(deps: RetentionDeps, options: RetentionOptions = {}): Retention {
  const freeBytes = options.freeBytes ?? diskFree
  const fips = () => deps.profile() === 'fips-140-3'

  const sweepTemp = async (): Promise<number> => {
    let names: string[]
    try {
      names = readdirSync(deps.tmpDir)
    } catch {
      return 0
    }
    const uid = process.getuid?.()
    let removed = 0
    for (const name of names) {
      const theme = name.startsWith(THEME_TMP_PREFIX)
      if (!theme && !name.startsWith(ONE2HTML_TMP_PREFIX)) continue
      const path = join(deps.tmpDir, name)
      if (liveBackupDirs.has(path)) continue
      try {
        // lstat: a symlink under our prefix is not ours to follow, whatever it points at.
        const st = lstatSync(path)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        if (uid !== undefined && st.uid !== uid) continue
        if (theme && Date.now() - st.mtimeMs < THEME_RUN_MAX_MS) continue
        rmSync(path, { recursive: true, force: true })
        removed++
      } catch {
        // Gone already, or not removable by this user: the next start tries again.
      }
    }
    return removed
  }

  const purgeLogs = (report: PurgeReport): void => {
    log.purgeAll()
    if (fips()) report.securityLogKept = SECURITY_LOG_KEPT
    else securityLog.clear()
    report.logsCleared = true
  }

  const purgeCaches = async (report: PurgeReport): Promise<void> => {
    const store = deps.store()
    const need = store.sizeBytes()
    const free = freeBytes(deps.dataDir)
    if (free < need) {
      throw new Error(`Compacting the notes needs ${Math.ceil(need / 1024 / 1024)} MB free on the disk, and ${Math.floor(free / 1024 / 1024)} MB is free. Free some space and try again.`)
    }
    // No sync run reads an image or a row while they are removed and the file is rewritten. whilePaused nests, so a
    // pause a vault migration holds is still in place afterwards.
    await deps.sync().whilePaused(async () => {
      const { referenced, pending } = imageReferences(store)
      report.blobs = deps.blobs().sweep(referenced, pending)
      // The index is rebuilt below; emptying and merging it first drops the entries of deleted text.
      store.clearSearch()
      store.optimizeSearch()
      // searchIndex.ts's PROGRESS_KEY: a build cut short would otherwise resume past pages just cleared.
      store.setSyncMeta('search.progress', new Uint8Array())
      const before = store.sizeBytes()
      store.vacuum()
      report.bytesFreed = Math.max(0, before - store.sizeBytes())
    })
    report.tempDirs = await sweepTemp()
    deps.search().ensureBuilt()
  }

  return {
    async purge(scope) {
      const report: PurgeReport = { scope, blobs: 0, tempDirs: 0, bytesFreed: 0, logsCleared: false, auditCleared: false }
      if (scope === 'logs' || scope === 'all') purgeLogs(report)
      if (scope === 'audit' || scope === 'all') {
        deps.store().clearAudit()
        report.auditCleared = true
      }
      if (scope === 'caches' || scope === 'all') await purgeCaches(report)
      return report
    },
    clearAudit: () => deps.store().clearAudit(),
    readSecurityLog: () => securityLog.read(),
    clearSecurityLog: () => {
      if (fips()) throw new ProfileForbids(SECURITY_LOG_KEPT)
      securityLog.clear()
    },
    sweepTemp,
  }
}

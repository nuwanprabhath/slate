// GDPR review §3.4 (workstream D): purge by scope, the security log's view and clear, and the sweep of
// temp folders a crash left behind (GDPR-04, 07, 08, 13, 14).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageDoc } from '@slate/core'
import { BLOB_PUT_GRACE_MS, FileBlobStore, type BlobStore } from '../blobs'
import { log, securityLog } from '../log/logger'
import { liveBackupDirs, ONE2HTML_TMP_PREFIX } from '../onenote/backup'
import { SearchIndex } from '../search/searchIndex'
import { DocStore } from '../store'
import type { SyncService } from '../sync/syncService'
import type { ProfileId } from '../vault/profile'
import { createRetention, ProfileForbids, THEME_TMP_PREFIX, type RetentionDeps } from './retention'

let root = ''
let store: DocStore
let blobs: BlobStore
let search: SearchIndex
let profile: ProfileId | null
let sync: { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; whilePaused: ReturnType<typeof vi.fn>; held: number }
let tmp = ''

function deps(): RetentionDeps {
  return {
    store: () => store,
    blobs: () => blobs,
    search: () => search,
    sync: () => sync as unknown as SyncService,
    dataDir: root,
    profile: () => profile,
    strict: () => true,
    tmpDir: tmp,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slate-retention-'))
  tmp = join(root, 'tmp')
  mkdirSync(tmp)
  store = new DocStore(join(root, 'slate.db'), { compact: false })
  blobs = new FileBlobStore(join(root, 'blobs'))
  search = new SearchIndex(store, { schedule: (run) => run() })
  profile = null
  sync = {
    pause: vi.fn(async () => {}),
    resume: vi.fn(),
    held: 0,
    whilePaused: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      sync.held++
      try {
        return await fn()
      } finally {
        sync.held--
      }
    }),
  }
  log.configure({ enabled: true, dir: join(root, 'logs'), maxSizeMb: 20 })
  securityLog.configure({ enabled: true, dir: join(root, 'security-log'), maxSizeMb: 2, retentionDays: 90 })
})
afterEach(() => {
  vi.useRealTimers()
  log.configure({ enabled: false, dir: '', maxSizeMb: 20 })
  securityLog.configure({ enabled: false, dir: '', maxSizeMb: 2 })
  search.close()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** An image put long enough ago that the sweep's grace for a fresh paste has passed. */
function oldImage(byte: number): string {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - BLOB_PUT_GRACE_MS - 1000)
  try {
    return blobs.put(new Uint8Array([byte]), 'image/png')
  } finally {
    vi.useRealTimers()
  }
}

function pageWithImage(pageId: string, url: string, text = 'words'): void {
  const page = new PageDoc()
  page.addBox({ x: 0, y: 0, width: 100, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, { type: 'image', attrs: { src: url, alt: '' } }] })
  store.append(`page:${pageId}`, page.doc.export({ mode: 'update' }))
  page.doc.free()
}

describe('purge', () => {
  it('audit: clears the AI activity record', async () => {
    store.appendAudit({ tool: 'read_page', target: 'p', outcome: 'ok' })
    const report = await createRetention(deps()).purge('audit')
    expect(store.listAudit()).toEqual([])
    expect(report).toMatchObject({ scope: 'audit', auditCleared: true, logsCleared: false, blobs: 0, tempDirs: 0 })
  })

  it('logs: deletes the diagnostic log and the security log on a standard install', async () => {
    log.info('app', 'diagnostic line')
    securityLog.info('app', 'unlock')
    const report = await createRetention(deps()).purge('logs')
    expect(existsSync(join(root, 'logs'))).toBe(false)
    expect(securityLog.read()).toBe('')
    expect(report).toMatchObject({ scope: 'logs', logsCleared: true, auditCleared: false })
    expect(report.securityLogKept).toBeUndefined()
  })

  it('logs: keeps the security log under fips-140-3, and says why', async () => {
    profile = 'fips-140-3'
    securityLog.info('app', 'unlock')
    const report = await createRetention(deps()).purge('logs')
    expect(securityLog.read()).toContain('unlock')
    expect(report.logsCleared).toBe(true)
    expect(report.securityLogKept).toMatch(/fips-140-3/)
  })

  it('caches: removes images no page refers to, keeps the ones a page uses, and pauses sync around the rewrite', async () => {
    const used = oldImage(1)
    const orphan = oldImage(2)
    pageWithImage('11111111-1111-4111-8111-111111111111', used)
    const report = await createRetention(deps()).purge('caches')
    const name = (url: string) => url.slice('slate-blob://blob/'.length)
    expect(blobs.has(name(used))).toBe(true)
    expect(blobs.has(name(orphan))).toBe(false)
    expect(report).toMatchObject({ scope: 'caches', blobs: 1 })
    expect(report.bytesFreed).toBeGreaterThanOrEqual(0)
    expect(sync.whilePaused).toHaveBeenCalledTimes(1)
    // A bare pause/resume would undo a pause someone else holds (a vault migration's remote claim).
    expect(sync.pause).not.toHaveBeenCalled()
    expect(sync.resume).not.toHaveBeenCalled()
  })

  it('caches: keeps an image only an unresolved sync conflict mentions', async () => {
    const inConflict = oldImage(3)
    store.addConflict({ id: 'c', pageId: 'p', boxId: 'b', device: 'Device 1', mine: 'x', theirs: JSON.stringify({ src: inConflict }), merged: 'x', at: Date.now() })
    await createRetention(deps()).purge('caches')
    expect(blobs.has(inConflict.slice('slate-blob://blob/'.length))).toBe(true)
  })

  it('caches: rebuilds the search index from the pages that are there', async () => {
    pageWithImage('22222222-2222-4222-8222-222222222222', oldImage(4), 'findable text')
    search.ensureBuilt()
    store.replaceSearchPage({ pageId: 'gone', sectionId: 's', notebookId: 'n' }, [{ boxId: 'b', ord: 0, text: 'stale removed text' }])
    await createRetention(deps()).purge('caches')
    const texts = store.searchRows(null, null).map((r) => r.text)
    expect(texts).toContain('findable text')
    expect(texts).not.toContain('stale removed text')
  })

  it('caches: refuses before touching anything when the disk has less free space than the database', async () => {
    const orphan = oldImage(5)
    const retention = createRetention(deps(), { freeBytes: () => 10 })
    await expect(retention.purge('caches')).rejects.toThrow(/free/)
    expect(blobs.has(orphan.slice('slate-blob://blob/'.length))).toBe(true)
    expect(sync.whilePaused).not.toHaveBeenCalled()
  })

  it('caches: resumes sync even when the rewrite fails', async () => {
    const retention = createRetention({ ...deps(), store: () => Object.assign(Object.create(store) as DocStore, { vacuum: () => { throw new Error('busy') } }) })
    await expect(retention.purge('caches')).rejects.toThrow('busy')
    expect(sync.whilePaused).toHaveBeenCalledTimes(1)
    expect(sync.held).toBe(0)
  })

  it('all: does all three', async () => {
    store.appendAudit({ tool: 'read_page', target: 'p', outcome: 'ok' })
    log.info('app', 'line')
    mkdirSync(join(tmp, `${ONE2HTML_TMP_PREFIX}abc`))
    const report = await createRetention(deps()).purge('all')
    expect(report).toMatchObject({ scope: 'all', auditCleared: true, logsCleared: true, tempDirs: 1 })
  })
})

describe('the security log', () => {
  it('reads what the security log holds', () => {
    securityLog.info('app', 'unlock by password')
    expect(createRetention(deps()).readSecurityLog()).toContain('unlock by password')
  })

  it('clears it on a standard install', () => {
    securityLog.info('app', 'unlock')
    createRetention(deps()).clearSecurityLog()
    expect(securityLog.read()).toBe('')
  })

  it('refuses to clear it under fips-140-3 (AU-2 keeps the record)', () => {
    profile = 'fips-140-3'
    securityLog.info('app', 'unlock')
    expect(() => createRetention(deps()).clearSecurityLog()).toThrow(ProfileForbids)
    expect(securityLog.read()).toContain('unlock')
  })

  it('clearAudit empties the audit table', () => {
    store.appendAudit({ tool: 'read_page', target: 'p', outcome: 'ok' })
    createRetention(deps()).clearAudit()
    expect(store.listAudit()).toEqual([])
  })
})

describe('sweepTemp (GDPR-14)', () => {
  const hourAgo = (path: string) => {
    const when = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(path, when, when)
  }

  it('removes conversion and theme folders this user left, with what is in them', async () => {
    const conv = join(tmp, `${ONE2HTML_TMP_PREFIX}a1`)
    mkdirSync(conv)
    writeFileSync(join(conv, 'page.html'), '<p>private notes</p>')
    const theme = join(tmp, `${THEME_TMP_PREFIX}b2`)
    mkdirSync(theme)
    hourAgo(theme)
    expect(await createRetention(deps()).sweepTemp()).toBe(2)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('leaves other folders, files with the prefix, and a symlink with the prefix (never following it)', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    mkdirSync(join(tmp, 'other-app-1'))
    writeFileSync(join(tmp, `${ONE2HTML_TMP_PREFIX}file`), 'x')
    symlinkSync(outside, join(tmp, `${ONE2HTML_TMP_PREFIX}link`))
    expect(await createRetention(deps()).sweepTemp()).toBe(0)
    expect(readdirSync(tmp).sort()).toEqual(['other-app-1', `${ONE2HTML_TMP_PREFIX}file`, `${ONE2HTML_TMP_PREFIX}link`].sort())
    expect(readdirSync(outside)).toEqual(['keep.txt'])
  })

  it('leaves a conversion folder a running import holds, and a theme folder a run may still be using', async () => {
    const held = join(tmp, `${ONE2HTML_TMP_PREFIX}live`)
    mkdirSync(held)
    ;(liveBackupDirs as Set<string>).add(held)
    const fresh = join(tmp, `${THEME_TMP_PREFIX}now`)
    mkdirSync(fresh)
    try {
      expect(await createRetention(deps()).sweepTemp()).toBe(0)
      expect(readdirSync(tmp).sort()).toEqual([`${ONE2HTML_TMP_PREFIX}live`, `${THEME_TMP_PREFIX}now`].sort())
    } finally {
      ;(liveBackupDirs as Set<string>).delete(held)
    }
  })

  it('counts nothing when the temp folder cannot be read', async () => {
    expect(await createRetention({ ...deps(), tmpDir: join(root, 'missing') }).sweepTemp()).toBe(0)
  })
})

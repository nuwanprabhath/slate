import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { eraseDocHistory, eraseEverything, erasableNames, historyEraseBlocker, HistoryEraseUnavailable, HistoryWasSynced, loadersReadShallowHistory, SyncIsOn, type EraseAllSteps, type HistoryStore } from './erase'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const MARKER = 'ERASED-MARKER-7f3a'
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text)

/** A fake of the `DocStore` methods an erase uses, holding rows as `DocStore` does: snapshot first, then updates. */
function fakeStore(rows: Uint8Array[], synced = false): HistoryStore & { rows: Uint8Array[]; calls: string[] } {
  const calls: string[] = []
  return {
    rows,
    calls,
    load: () => rows,
    wasSynced: () => synced,
    replaceWithSnapshot(docId, snapshot) {
      calls.push(`replace ${docId}`)
      rows.splice(0, rows.length, snapshot)
    },
    optimizeSearch: () => calls.push('optimize search'),
    vacuum: () => calls.push('vacuum'),
  }
}

function typedThenDeleted(): Uint8Array[] {
  const doc = new LoroDoc()
  const text = doc.getText('t')
  const vv0 = doc.oplogVersion()
  text.insert(0, `keep ${MARKER} this`)
  doc.commit()
  const first = doc.export({ mode: 'update', from: vv0 })
  const vv1 = doc.oplogVersion()
  text.delete(5, MARKER.length + 1)
  doc.commit()
  const second = doc.export({ mode: 'update', from: vv1 })
  doc.free()
  return [first, second]
}

describe('eraseDocHistory (GDPR-04)', () => {
  it('replaces the rows with one shallow snapshot: the deleted marker is gone, the current text stays, then a search merge, VACUUM and a re-index', () => {
    const store = fakeStore(typedThenDeleted())
    expect(store.rows.some((r) => has(r, MARKER))).toBe(true)
    const changed = vi.fn()
    eraseDocHistory(store, 'page:x', false, changed, () => null)
    // The search index's deletes only mark entries until its segments merge: the deleted text's trigrams go too.
    expect(store.calls).toEqual(['replace page:x', 'optimize search', 'vacuum'])
    expect(changed).toHaveBeenCalledWith('page:x')
    expect(store.rows).toHaveLength(1)
    expect(has(store.rows[0]!, MARKER)).toBe(false)
    const reopened = new LoroDoc()
    reopened.importBatch(store.rows)
    expect(reopened.getText('t').toString()).toBe('keep this')
    // Edits made after the erase still merge into the shallow document.
    const vv = reopened.oplogVersion()
    reopened.getText('t').insert(0, '> ')
    reopened.commit()
    const later = new LoroDoc()
    later.import(store.rows[0]!)
    later.importBatch([reopened.export({ mode: 'update', from: vv })])
    expect(later.getText('t').toString()).toBe('> keep this')
    // A second erase reads the shallow snapshot plus the later edit.
    store.rows.push(reopened.export({ mode: 'update', from: vv }))
    eraseDocHistory(store, 'page:x', false, changed, () => null)
    const again = new LoroDoc()
    again.importBatch(store.rows)
    expect(again.getText('t').toString()).toBe('> keep this')
  })

  it('is refused, touching nothing, while something blocks it', () => {
    const store = fakeStore(typedThenDeleted())
    expect(() => eraseDocHistory(store, 'page:x', false, () => {}, () => 'not today')).toThrow(HistoryEraseUnavailable)
    expect(store.calls).toEqual([])
  })

  it('Slate’s loaders now reopen a shallow history with two commits before it (core importParts, Loro 1.17 importBatch)', () => {
    // Was false while every loader batched every part: an erased page then opened empty after its next edit.
    expect(loadersReadShallowHistory()).toBe(true)
  })

  it('is not blocked by the build: sync carries a page erased before it ever synced (packages/sync/test/erasedHistory.test.ts)', () => {
    expect(historyEraseBlocker()).toBeNull()
    const store = fakeStore(typedThenDeleted())
    eraseDocHistory(store, 'page:x', false, () => {})
    expect(store.calls).toEqual(['replace page:x', 'optimize search', 'vacuum'])
  })

  it('is refused, touching nothing, for a document that was ever synced: another device holds it, and the two could not merge', () => {
    const store = fakeStore(typedThenDeleted(), true)
    expect(() => eraseDocHistory(store, 'page:x', false, () => {})).toThrow(HistoryWasSynced)
    expect(store.calls).toEqual([])
  })

  it('is refused while sync is on, and touches nothing', () => {
    const store = fakeStore(typedThenDeleted())
    expect(() => eraseDocHistory(store, 'page:x', true, () => {})).toThrow(SyncIsOn)
    expect(store.calls).toEqual([])
  })

  it('refuses a document with a missing update rather than dropping the edit waiting on it', () => {
    const [, second] = typedThenDeleted()
    const store = fakeStore([second!])
    expect(() => eraseDocHistory(store, 'page:x', false, () => {}, () => null)).toThrow(/not arrived/)
    expect(store.calls).toEqual([])
  })
})

describe('erasableNames', () => {
  const entries = ['slate.db', 'slate.db-wal', 'slate.db-shm', 'slate-0a1b2c3d.db', 'slate-0a1b2c3d.db-wal', 'slate.lock', 'mcp.sock', 'blobs', 'git-sync', 'logs', 'security-log', 'fips',
    'vault.json', 'local-keys.json', 'preunlock.json', 'quick-unlock.bin', 'unlock-throttle.json', 'vault.seen.json', 'msal-cache.bin', 'update-result.json',
    '.vault.json.0123456789abc.tmp', 'Local Storage', 'Preferences', 'notes.txt', 'slate.dbx']
  it('names Slate’s own files only, keeps slate.lock and Chromium’s folders, and fips/ under fips-140-3', () => {
    const standard = erasableNames(entries, 'standard')
    expect(standard).toEqual(expect.arrayContaining(['slate.db', 'slate.db-wal', 'slate.db-shm', 'slate-0a1b2c3d.db', 'slate-0a1b2c3d.db-wal', 'blobs', 'git-sync', 'logs', 'security-log', 'fips', 'vault.json', 'local-keys.json', 'preunlock.json', 'quick-unlock.bin', 'unlock-throttle.json', 'vault.seen.json', 'msal-cache.bin', 'update-result.json', '.vault.json.0123456789abc.tmp']))
    for (const kept of ['slate.lock', 'mcp.sock', 'Local Storage', 'Preferences', 'notes.txt', 'slate.dbx']) expect(standard).not.toContain(kept)
    expect(erasableNames(entries, 'fips-140-3')).not.toContain('fips')
    expect(erasableNames(entries, null)).toContain('fips')
  })

  it('names a crashed migration\'s temp copies of a database, which may be plaintext notes', () => {
    const temps = ['slate-0a1b2c3d.db.tmp', 'slate-0a1b2c3d.db.enc.tmp', 'slate-0a1b2c3d.db.tmp-wal', 'slate-0a1b2c3d.db.enc.tmp-journal']
    expect(erasableNames([...temps, 'slate-0a1b2c3d.db.tmpx', 'slate.db.bak'], 'standard')).toEqual(temps)
  })

  it('names the updater\'s pending-download sidecar, which holds the download\'s path in the home folder', () => {
    expect(erasableNames(['update-result.json.download', 'update-result.json.downloadx'], 'standard')).toEqual(['update-result.json.download'])
  })

  it('names the temp copies a migration or rejoin left mid-way (the first is a plaintext copy of the notes), which no start removes once the vault files are gone', () => {
    const temps = ['slate-0a1b2c3d.db.tmp', 'slate-0a1b2c3d.db.tmp-journal', 'slate-0a1b2c3d.db.tmp-wal', 'slate-0a1b2c3d.db.tmp-shm', 'slate-0a1b2c3d.db.enc.tmp']
    expect(erasableNames([...temps, 'slate-0a1b2c3d.db.tmpx', 'slate-0a1b2c3d.db.bak'], 'standard').sort()).toEqual([...temps].sort())
  })
})

describe('eraseEverything (GDPR-06, GDPR-18)', () => {
  function dataDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'slate-erase-'))
    dirs.push(d)
    for (const f of ['slate.db', 'slate.db-wal', 'vault.json', 'msal-cache.bin', 'slate.lock', 'Preferences']) writeFileSync(join(d, f), 'x')
    for (const sub of ['blobs', 'git-sync/abc', 'logs', 'Local Storage']) mkdirSync(join(d, sub), { recursive: true })
    writeFileSync(join(d, 'git-sync', 'token.bin'), 'sealed')
    return d
  }
  const steps = (d: string, order: string[], patch: Partial<EraseAllSteps> = {}): EraseAllSteps => ({
    dataDir: d,
    profile: null,
    signOut: async () => void order.push('signOut'),
    closeNotes: async () => void order.push('closeNotes'),
    secrets: [{ name: 'git token', clear: async () => void order.push('git token') }],
    forgetQuickUnlock: async () => void order.push('quick unlock'),
    clearBrowserStorage: async () => void order.push('browser storage'),
    sweepTemp: async () => {
      order.push('temp')
      return 0
    },
    warn: () => {},
    ...patch,
  })

  it('signs out, closes, clears secrets, deletes Slate’s files, clears browser storage and temp, in that order', async () => {
    const d = dataDir()
    const order: string[] = []
    const report = await eraseEverything(steps(d, order))
    expect(order).toEqual(['signOut', 'closeNotes', 'git token', 'quick unlock', 'browser storage', 'temp'])
    expect(report.failed).toEqual([])
    expect(readdirSync(d).sort()).toEqual(['Local Storage', 'Preferences', 'slate.lock'])
    expect(report.removed.sort()).toEqual(['blobs', 'git-sync', 'logs', 'msal-cache.bin', 'slate.db', 'slate.db-wal', 'vault.json'])
  })

  it('deletes a symlink in the data folder, never what it points at, also one inside blobs/', async () => {
    const d = dataDir()
    const outside = mkdtempSync(join(tmpdir(), 'slate-erase-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'mine.txt'), 'not Slate\'s')
    rmSync(join(d, 'logs'), { recursive: true })
    symlinkSync(outside, join(d, 'logs'))
    symlinkSync(outside, join(d, 'blobs', 'linked'))
    symlinkSync(join(outside, 'mine.txt'), join(d, 'blobs', 'file-link'))
    const report = await eraseEverything(steps(d, []))
    expect(report.failed).toEqual([])
    expect(existsSync(join(d, 'logs'))).toBe(false)
    expect(existsSync(join(d, 'blobs'))).toBe(false)
    expect(readdirSync(outside)).toEqual(['mine.txt'])
  })

  it('is best-effort: a failing step is reported by name and the rest still run', async () => {
    const d = dataDir()
    const order: string[] = []
    const warn = vi.fn()
    const report = await eraseEverything(steps(d, order, { signOut: () => Promise.reject(new Error('No Microsoft client id is configured')), warn }))
    expect(report.failed).toEqual(['microsoft sign-out'])
    expect(warn).toHaveBeenCalledWith('microsoft sign-out', expect.any(Error))
    expect(existsSync(join(d, 'slate.db'))).toBe(false)
    expect(order).toContain('temp')
  })
})

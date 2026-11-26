// GDPR review §3.4 (workstream D): retention by age, the AI-activity clear, forgetting one sync
// connection's bookkeeping, VACUUM, and replacing a doc's history with a snapshot (GDPR-04, 06, 07, 15).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { DocStore } from './store'
import { openDatabase } from './db/openDatabase'

const DAY = 24 * 60 * 60 * 1000
const MARKER = 'GIRAFFE-ERASE-3c9d'
const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-store-privacy-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => {
  vi.useRealTimers()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

/** Writes through `run` as if it were `daysAgo` days ago. */
function at<T>(daysAgo: number, run: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - daysAgo * DAY)
  try {
    return run()
  } finally {
    vi.useRealTimers()
  }
}

function conflict(id: string, at: number) {
  return { id, pageId: 'p', boxId: 'b', device: 'Anna’s laptop', mine: 'a', theirs: 'b', merged: 'ab', at }
}

function textDoc(text: string): { doc: LoroDoc; update: Uint8Array } {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  doc.commit()
  return { doc, update: doc.export({ mode: 'update' }) }
}

describe('audit and conflict retention by age (GDPR-07, GDPR-15)', () => {
  it('drops audit rows older than 90 days by default, keeping newer ones', () => {
    const file = tempDb()
    const first = new DocStore(file, { compact: false })
    at(120, () => first.appendAudit({ tool: 'search', target: '[5 chars]', outcome: 'ok' }))
    at(60, () => first.appendAudit({ tool: 'read_page', target: 'p1', outcome: 'ok' }))
    first.close()
    const store = new DocStore(file, { compact: false })
    expect(store.listAudit().map((r) => r.target)).toEqual(['p1'])
    store.close()
  })

  it('drops audit rows older than 30 days when retention says so', () => {
    const file = tempDb()
    const first = new DocStore(file, { compact: false })
    at(45, () => first.appendAudit({ tool: 'read_page', target: 'old', outcome: 'ok' }))
    at(10, () => first.appendAudit({ tool: 'read_page', target: 'new', outcome: 'ok' }))
    first.close()
    const store = new DocStore(file, { compact: false, retention: { auditDays: 30, conflictDays: 90 } })
    expect(store.listAudit().map((r) => r.target)).toEqual(['new'])
    store.close()
  })

  it('applyRetention prunes an open store with the settings read after it opened', () => {
    const store = new DocStore(tempDb(), { compact: false })
    at(45, () => store.appendAudit({ tool: 'read_page', target: 'old', outcome: 'ok' }))
    store.appendAudit({ tool: 'read_page', target: 'new', outcome: 'ok' })
    store.addConflict(conflict('c-old', Date.now() - 100 * DAY))
    store.addConflict(conflict('c-new', Date.now() - 10 * DAY))
    expect(store.listAudit()).toHaveLength(2)
    store.applyRetention({ auditDays: 30, conflictDays: 90 })
    expect(store.listAudit().map((r) => r.target)).toEqual(['new'])
    expect(store.listConflicts().map((c) => c.id)).toEqual(['c-new'])
    store.close()
  })

  it('keeps conflicts of any age when conflictDays is null (strict mode off)', () => {
    const file = tempDb()
    const first = new DocStore(file, { compact: false })
    first.addConflict(conflict('c-old', Date.now() - 400 * DAY))
    first.close()
    const store = new DocStore(file, { compact: false, retention: { auditDays: 90, conflictDays: null } })
    expect(store.listConflicts().map((c) => c.id)).toEqual(['c-old'])
    store.close()
  })

  it('clearAudit deletes every audit row', () => {
    const store = new DocStore(tempDb(), { compact: false })
    store.appendAudit({ tool: 'read_page', target: 'p1', outcome: 'ok' })
    store.appendAudit({ tool: 'list_tree', target: '*', outcome: 'ok' })
    store.clearAudit()
    expect(store.listAudit()).toEqual([])
    store.close()
  })
})

describe('forgetSync (GDPR-06; called by SyncService.forget)', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  const GIT = 'git:https://github.com/anna/notes_1%x.git#main:'
  const OTHER_GIT = 'git:https://github.com/anna/other.git#main:'

  function seeded(): DocStore {
    const store = new DocStore(tempDb(), { compact: false })
    // OneDrive's engine keys are unprefixed; a git remote's sit under `git:<url>#<branch>:`.
    for (const key of ['deltaCursor', 'changedSeq', 'deviceRecord', 'pushed:page:1', 'seq:page:1', 'chunks:page:1', 'snapshot:page:1', 'stale:page:1', 'base:page:1'])
      store.setSyncMeta(key, bytes('od'))
    for (const key of ['deltaCursor', 'pushed:page:1', 'blob:abc.png']) {
      store.setSyncMeta(GIT + key, bytes('git'))
      store.setSyncMeta(OTHER_GIT + key, bytes('other'))
    }
    // Not sync bookkeeping: the search index's own keys, and the transport probe's timestamp.
    store.setSyncMeta('search.version', bytes('1'))
    store.setSyncMeta('search.progress', bytes(''))
    store.setSyncMeta('pq:transport-probed-at', bytes('1'))
    // A key that only looks like the git prefix with LIKE's wildcards read as wildcards.
    store.setSyncMeta('git:https://github.com/anna/notes_1Zx.git#main:deltaCursor', bytes('lookalike'))
    store.markSyncSeen('item-1', 'e1')
    store.markSyncSeen(`${GIT}item-2`, 'e2')
    store.markSyncSeen(`${OTHER_GIT}item-3`, 'e3')
    store.markBlobSynced('abc.png')
    store.recordTransport({ remote: 'https:github.com', transport: 'tls', kex: 'X25519MLKEM768', pq: 'hybrid', source: 'test-connection', at: 1 })
    store.recordTransport({ remote: 'https:gitlab.com', transport: 'tls', kex: 'X25519', pq: 'classical', source: 'test-connection', at: 1 })
    return store
  }

  const allMeta = (store: DocStore) => store.syncMetaKeys('').sort()

  it('with a git prefix, removes that connection only: its keys, its seen items and its host observation', () => {
    const store = seeded()
    store.forgetSync(GIT, 'https:github.com')
    const keys = allMeta(store)
    expect(keys.filter((k) => k.startsWith(GIT))).toEqual([])
    expect(keys.filter((k) => k.startsWith(OTHER_GIT))).toHaveLength(3)
    expect(keys).toContain('git:https://github.com/anna/notes_1Zx.git#main:deltaCursor')
    expect(keys).toContain('deltaCursor')
    expect(keys).toContain('search.version')
    expect(store.syncSeen(`${GIT}item-2`, 'e2')).toBe(false)
    expect(store.syncSeen(`${OTHER_GIT}item-3`, 'e3')).toBe(true)
    expect(store.syncSeen('item-1', 'e1')).toBe(true)
    expect(store.blobSynced('abc.png')).toBe(true)
    expect(store.transportObservations().map((o) => o.remote)).toEqual(['https:gitlab.com'])
    store.close()
  })

  it('with no prefix (OneDrive), removes the unprefixed engine keys, seen items and synced blobs, and nothing of git or search', () => {
    const store = seeded()
    store.forgetSync(null, null)
    const keys = allMeta(store)
    for (const gone of ['deltaCursor', 'changedSeq', 'deviceRecord', 'pushed:page:1', 'seq:page:1', 'chunks:page:1', 'snapshot:page:1', 'stale:page:1', 'base:page:1'])
      expect(keys, gone).not.toContain(gone)
    expect(keys.filter((k) => k.startsWith('git:'))).toHaveLength(7)
    expect(keys).toEqual(expect.arrayContaining(['search.version', 'search.progress', 'pq:transport-probed-at']))
    expect(store.syncSeen('item-1', 'e1')).toBe(false)
    expect(store.syncSeen(`${GIT}item-2`, 'e2')).toBe(true)
    expect(store.blobSynced('abc.png')).toBe(false)
    expect(store.transportObservations()).toHaveLength(2)
    store.close()
  })

  it('remembers, past the forget, which documents were synced: an erase of their history stays refused (GDPR-04)', () => {
    const store = seeded()
    store.setSyncMeta(`${GIT}base:page:2`, bytes('git'))
    store.forgetSync(GIT, null)
    store.forgetSync(null, null)
    expect(store.wasSynced('page:1')).toBe(true)
    expect(store.wasSynced('page:2')).toBe(true)
    expect(store.wasSynced('page:3')).toBe(false)
    store.close()
  })

  it('refuses an empty prefix, which would match every key', () => {
    const store = seeded()
    expect(() => store.forgetSync('', null)).toThrow(/prefix/)
    expect(allMeta(store).length).toBeGreaterThan(10)
    store.close()
  })
})

describe('vacuum (GDPR-04)', () => {
  it('refuses inside a transaction', () => {
    const db = openDatabase(tempDb(), null)
    const store = new DocStore(db, { compact: false })
    expect(() => db.transaction(() => store.vacuum())()).toThrow(/transaction/)
    store.close()
  })

  it('leaves no trace of a removed page in the file or the WAL', () => {
    const file = tempDb()
    const store = new DocStore(file, { compact: false })
    const filler = 'x'.repeat(4000)
    for (let i = 0; i < 200; i++) store.append(`page:${i}`, new TextEncoder().encode(`${MARKER} ${filler}`))
    store.replaceSearchPage({ pageId: 'page:0', sectionId: 's', notebookId: 'n' }, [{ boxId: 'b', ord: 0, text: MARKER }])
    for (let i = 0; i < 200; i++) store.remove(`page:${i}`)
    store.removeSearchPage('page:0')
    store.optimizeSearch()
    store.vacuum()
    const scan = () => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(MARKER))
    expect(scan()).toBe(false)
    store.close()
    expect(scan()).toBe(false)
  })

  it('reports the database size it would need free', () => {
    const store = new DocStore(tempDb(), { compact: false })
    store.append('page:a', new Uint8Array(10_000))
    expect(store.sizeBytes()).toBeGreaterThan(10_000)
    store.close()
  })
})

describe('replaceWithSnapshot (GDPR-04; for erase history)', () => {
  it('replaces the doc with the snapshot in place, keeps its content, and drops the old rows', () => {
    const store = new DocStore(tempDb(), { compact: false })
    const { doc, update } = textDoc(`secret ${MARKER}`)
    store.append('page:a', update)
    doc.getText('t').delete(0, doc.getText('t').length)
    doc.getText('t').insert(0, 'kept')
    doc.commit()
    store.append('page:a', doc.export({ mode: 'update' }))
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })
    doc.free()
    store.replaceWithSnapshot('page:a', shallow)
    const parts = store.load('page:a')
    expect(parts).toHaveLength(1)
    expect(store.origins('page:a')).toEqual([])
    const back = new LoroDoc()
    back.importBatch(parts)
    expect(back.getText('t').toString()).toBe('kept')
    back.free()
    expect(Buffer.from(parts[0]!).includes(MARKER)).toBe(false)
    store.close()
  })

  it('moves the doc past a sync cursor, and the next append to another doc is still seen (FX-6)', () => {
    const store = new DocStore(tempDb(), { compact: false })
    const a = textDoc('a')
    const b = textDoc('b')
    store.append('page:a', a.update)
    store.append('page:b', b.update)
    const cursor = store.changedDocs(0).seq
    store.replaceWithSnapshot('page:a', a.doc.export({ mode: 'shallow-snapshot', frontiers: a.doc.oplogFrontiers() }))
    const after = store.changedDocs(cursor)
    expect(after.ids).toEqual(['page:a'])
    expect(after.seq).toBeGreaterThan(cursor)
    b.doc.getText('t').insert(1, '2')
    b.doc.commit()
    store.append('page:b', b.doc.export({ mode: 'update', from: b.doc.oplogVersion() }))
    expect(store.changedDocs(after.seq).ids).toEqual(['page:b'])
    a.doc.free()
    b.doc.free()
    store.close()
  })

  it('tells a loadSince reader to start over', () => {
    const store = new DocStore(tempDb(), { compact: false })
    const a = textDoc('a')
    store.append('page:a', a.update)
    const first = store.loadSince('page:a', undefined)
    store.replaceWithSnapshot('page:a', a.doc.export({ mode: 'snapshot' }))
    expect(store.loadSince('page:a', first.cursor).full).toBe(true)
    a.doc.free()
    store.close()
  })

  it('an erased doc still compacts: its shallow snapshot and the edits after it fold into one snapshot that reads them', () => {
    const store = new DocStore(tempDb(), { compact: false })
    const doc = new LoroDoc()
    const text = doc.getText('t')
    // Two or more commits before the shallow point: the case Loro 1.17's importBatch reads as empty.
    for (const word of ['one ', 'two ', `${MARKER} `]) {
      const from = doc.oplogVersion()
      text.insert(text.length, word)
      doc.commit()
      store.append('page:a', doc.export({ mode: 'update', from }))
    }
    text.delete(8, MARKER.length + 1)
    doc.commit()
    store.replaceWithSnapshot('page:a', doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() }))
    for (const word of ['three', '!']) {
      const from = doc.oplogVersion()
      text.insert(text.length, word)
      doc.commit()
      store.append('page:a', doc.export({ mode: 'update', from }))
    }
    doc.free()
    expect(store.load('page:a')).toHaveLength(3)
    store.compact('page:a')
    const parts = store.load('page:a')
    expect(parts).toHaveLength(1)
    const back = new LoroDoc()
    back.import(parts[0]!)
    expect(back.getText('t').toString()).toBe('one two three!')
    back.free()
    expect(Buffer.from(parts[0]!).includes(MARKER)).toBe(false)
    store.close()
  })

  it('refuses bytes that are not a Loro document and leaves the doc as it was', () => {
    const store = new DocStore(tempDb(), { compact: false })
    const a = textDoc('a')
    store.append('page:a', a.update)
    const seq = store.headSeq()
    expect(() => store.replaceWithSnapshot('page:a', new Uint8Array([1, 2, 3, 4]))).toThrow()
    expect(store.load('page:a')).toHaveLength(1)
    expect(store.headSeq()).toBe(seq)
    a.doc.free()
    store.close()
  })
})

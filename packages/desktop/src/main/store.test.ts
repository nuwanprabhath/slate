import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { COMPACT_IDLE_MS, DocStore } from './store'
import { openDatabase } from './db/openDatabase'
import { testKey } from './db/testModule'
import type { TransportObservation } from '../shared/api'

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-store-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function edits(n: number): { doc: LoroDoc; updates: Uint8Array[] } {
  const doc = new LoroDoc()
  const updates: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const from = doc.oplogVersion()
    doc.getMap('m').set(`k${i}`, i)
    doc.commit()
    updates.push(doc.export({ mode: 'update', from }))
  }
  return { doc, updates }
}

/** `n` text appends to one doc, each exportable on its own, so a test can withhold one. */
function textEdits(words: string[]): Uint8Array[] {
  const doc = new LoroDoc()
  const updates: Uint8Array[] = []
  for (const word of words) {
    const from = doc.oplogVersion()
    doc.getText('t').insert(doc.getText('t').length, word)
    doc.commit()
    updates.push(doc.export({ mode: 'update', from }))
  }
  return updates
}

describe('DocStore', () => {
  it('appends and loads updates in order', () => {
    const store = new DocStore(tempDb())
    store.append('page:1', new Uint8Array([1, 2]))
    store.append('page:1', new Uint8Array([3]))
    expect(store.load('page:1').map((u) => Array.from(u))).toEqual([[1, 2], [3]])
    expect(store.load('page:missing')).toEqual([])
    store.close()
  })

  it('lists doc ids by literal prefix', () => {
    const store = new DocStore(tempDb())
    store.append('notebook:a', new Uint8Array([1]))
    store.append('page:b', new Uint8Array([1]))
    store.append('notebook_x', new Uint8Array([1]))
    expect(store.list('notebook:')).toEqual(['notebook:a'])
    store.close()
  })

  it('compacts automatically and preserves document state', () => {
    vi.useFakeTimers()
    const store = new DocStore(tempDb())
    const { doc, updates } = edits(520)
    for (const u of updates) store.append('page:c', u)
    vi.advanceTimersByTime(COMPACT_IDLE_MS)
    vi.useRealTimers()
    const parts = store.load('page:c')
    expect(parts.length).toBeLessThan(30)
    const restored = new LoroDoc()
    restored.importBatch(parts)
    expect(restored.toJSON()).toEqual(doc.toJSON())
    store.close()
  })

  it('persists across reopen and removes docs', () => {
    const file = tempDb()
    const first = new DocStore(file)
    first.append('page:p', new Uint8Array([9]))
    first.close()
    const second = new DocStore(file)
    expect(second.load('page:p')).toHaveLength(1)
    second.remove('page:p')
    expect(second.load('page:p')).toEqual([])
    expect(second.list('page:')).toEqual([])
    second.close()
  })

  it('stores settings as JSON', () => {
    const store = new DocStore(tempDb())
    expect(store.getSetting('settings')).toBeUndefined()
    store.setSetting('settings', { markdownShortcuts: true })
    expect(store.getSetting('settings')).toEqual({ markdownShortcuts: true })
    store.close()
  })

  it('records and lists audit rows newest first', () => {
    const store = new DocStore(tempDb())
    store.appendAudit({ tool: 'read_page', target: 'p1', outcome: 'ok' })
    store.appendAudit({ tool: 'search', target: 'q', outcome: 'denied' })
    const rows = store.listAudit()
    expect(rows.map((r) => r.tool)).toEqual(['search', 'read_page'])
    expect(rows[0]!.ts).toBeGreaterThan(0)
    store.close()
  })

  it('sees updates written by another connection to the same file', () => {
    const file = tempDb()
    const app = new DocStore(file)
    const cli = new DocStore(file, { compact: false })
    const since = app.maxUpdateId()
    const before = app.dataVersion()
    cli.append('page:x', new Uint8Array([7]))
    expect(app.dataVersion()).not.toBe(before)
    expect(app.updatesSince(since).map((u) => [u.docId, Array.from(u.data)])).toEqual([['page:x', [7]]])
    app.close()
    cli.close()
  })

  it('compacts once appends go quiet, never on the keystroke that crossed the threshold', () => {
    vi.useFakeTimers()
    try {
      const store = new DocStore(tempDb())
      const { updates } = edits(520)
      for (const u of updates) store.append('page:q', u)
      // Compaction rebuilds the whole page on the main thread, which also routes key presses.
      expect(store.load('page:q')).toHaveLength(520)
      vi.advanceTimersByTime(COMPACT_IDLE_MS - 1)
      store.append('page:q', edits(1).updates[0]!)
      vi.advanceTimersByTime(COMPACT_IDLE_MS - 1)
      expect(store.load('page:q')).toHaveLength(521)
      vi.advanceTimersByTime(1)
      expect(store.load('page:q').length).toBeLessThan(30)
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a compaction that fails keeps the rows and throws nothing into the main process', () => {
    vi.useFakeTimers()
    try {
      const store = new DocStore(tempDb())
      for (const u of edits(520).updates) store.append('page:f', u)
      vi.spyOn(store, 'compact').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
      expect(() => vi.advanceTimersByTime(COMPACT_IDLE_MS)).not.toThrow()
      expect(store.load('page:f')).toHaveLength(520)
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pending compaction when closed', () => {
    vi.useFakeTimers()
    try {
      const store = new DocStore(tempDb())
      for (const u of edits(520).updates) store.append('page:z', u)
      store.close()
      expect(() => vi.advanceTimersByTime(COMPACT_IDLE_MS)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('loadSince returns only rows after the given id, or the whole doc once compaction folded them', () => {
    vi.useFakeTimers()
    try {
      const store = new DocStore(tempDb())
      const [u0, u1, ...rest] = edits(522).updates
      store.append('page:s', u0!)
      store.append('page:other', new Uint8Array([9]))
      const first = store.loadSince('page:s', undefined)
      expect(first.full).toBe(true)
      expect(first.parts).toEqual([u0])
      store.append('page:s', u1!)
      const next = store.loadSince('page:s', first.cursor)
      expect(next.full).toBe(false)
      expect(next.parts).toEqual([u1])
      expect(store.loadSince('page:s', next.cursor)).toEqual({ parts: [], full: false, cursor: next.cursor })

      for (const u of rest) store.append('page:s', u)
      vi.advanceTimersByTime(COMPACT_IDLE_MS)
      // Rows after next.cursor are now inside the snapshot: a reader that stopped there must reload.
      const after = store.loadSince('page:s', next.cursor)
      expect(after.full).toBe(true)
      expect(after.parts.length).toBeLessThan(30)

      // A removed and rewritten doc is a different doc: the reader must not merge the old one in.
      store.remove('page:s')
      store.append('page:s', u0!)
      expect(store.loadSince('page:s', after.cursor)).toMatchObject({ parts: [u0], full: true })
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rewrites only the search rows an edit changed, in reading order', () => {
    const file = tempDb()
    const db = openDatabase(file, null)
    const store = new DocStore(db)
    const scope = { pageId: 'p', sectionId: 's', notebookId: 'n' }
    const rows = (texts: string[]) => texts.map((text, ord) => ({ boxId: text.startsWith('b2') ? 'b2' : 'b1', ord, text }))
    const writes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const read = () => store.searchRows(null, null).map((r) => [r.boxId, r.text])
    const lines = Array.from({ length: 50 }, (_, i) => `b1 line ${i}`)
    store.replaceSearchPage(scope, rows([...lines, 'b2 tail']))
    const before = writes()

    // Typing in one line: the other 50 rows (and their trigram entries) stay as they are.
    const typed = [...lines.slice(0, 20), 'b1 line 20 and more', ...lines.slice(21), 'b2 tail']
    store.replaceSearchPage(scope, rows(typed))
    expect(read()).toEqual(rows(typed).map((r) => [r.boxId, r.text]))
    // One row out and one in, plus FTS5's own bookkeeping rows; rewriting the page was over 300.
    expect(writes() - before).toBeLessThan(20)

    // Enter in the middle, many times at one spot, then a line removed: order holds throughout.
    let current = typed
    for (let i = 0; i < 80; i++) {
      current = [...current.slice(0, 10), `b1 new ${i}`, ...current.slice(10)]
      store.replaceSearchPage(scope, rows(current))
    }
    current = [...current.slice(0, 5), ...current.slice(6)]
    store.replaceSearchPage(scope, rows(current))
    expect(read()).toEqual(rows(current).map((r) => [r.boxId, r.text]))

    // A page moved to another section rewrites its scope everywhere.
    store.replaceSearchPage({ ...scope, sectionId: 's2' }, rows(current))
    expect(store.searchRows({ column: 'section_id', id: 's2' }, null)).toHaveLength(current.length)
    store.close()
  })

  it('never compacts a doc whose updates could not all be applied', () => {
    const store = new DocStore(tempDb())
    const [one, two, three, four] = textEdits(['one ', 'two ', 'three ', 'four '])
    // The second row has not arrived yet, so Loro keeps the third and fourth pending.
    for (const u of [one!, three!, four!]) store.append('page:gap', u)
    store.compact('page:gap')
    store.append('page:gap', two!)
    const doc = new LoroDoc()
    doc.importBatch(store.load('page:gap'))
    expect(doc.getText('t').toString()).toBe('one two three four ')
    store.close()
  })

  it('runs beforeCompact so another connection\'s rows arrive before they are deleted', () => {
    const file = tempDb()
    const [first, late] = textEdits(['first ', 'late '])
    const other = new DocStore(file, { compact: false })
    const store = new DocStore(file, { beforeCompact: () => other.append('page:h', late!) })
    store.append('page:h', first!)
    store.compact('page:h')
    const doc = new LoroDoc()
    doc.importBatch(store.load('page:h'))
    expect(doc.getText('t').toString()).toBe('first late ')
    store.close()
    other.close()
  })

  it('never compacts when compact is false', () => {
    const store = new DocStore(tempDb(), { compact: false })
    for (let i = 0; i < 520; i++) store.append('page:n', new Uint8Array([i % 256]))
    expect(store.load('page:n')).toHaveLength(520)
    store.close()
  })
})

describe('DocStore import tables', () => {
  it('round-trips import items and OneNote id mappings', () => {
    const file = tempDb()
    const store = new DocStore(file)
    expect(store.getImportItem('p1')).toBeUndefined()
    store.setImportItem('p1', { lastModified: '2026-01-01T00:00:00Z', status: 'failed', error: 'Graph 503' })
    store.setImportItem('p2', { lastModified: '2026-01-02T00:00:00Z', status: 'done' })
    store.setImportItem('p1', { lastModified: '2026-01-03T00:00:00Z', status: 'done' })
    expect(store.getMapping('nb1')).toBeUndefined()
    store.setMapping('nb1', 'slate-nb')
    store.close()
    const again = new DocStore(file)
    expect(again.getImportItem('p1')).toEqual({ lastModified: '2026-01-03T00:00:00Z', status: 'done' })
    expect(again.getImportItem('p2')).toEqual({ lastModified: '2026-01-02T00:00:00Z', status: 'done' })
    expect(again.getMapping('nb1')).toBe('slate-nb')
    again.close()
  })
})

describe('transport observations (PQ-B5)', () => {
  const obs = (over: Partial<TransportObservation> = {}): TransportObservation => ({
    remote: 'git-ssh:github.com',
    transport: 'ssh',
    kex: 'mlkem768x25519-sha256',
    pq: 'hybrid',
    source: 'probe',
    at: 1000,
    ...over
  })

  function legacyRows(file: string, key: ReturnType<typeof testKey> | null): void {
    // A 0.3.0 database: today's tables without transport_observations, holding rows.
    const first = new DocStore(openDatabase(file, key))
    first.append('page:1', new Uint8Array([1]))
    first.setSetting('k', 'v')
    first.addNotice('hello')
    first.close()
    const db = openDatabase(file, key)
    db.exec('DROP TABLE transport_observations')
    // 0.3.0 predates the schema version, so the migrations have to run on it (B4).
    db.pragma('user_version = 0')
    db.close()
  }

  it.each([
    ['plaintext', null],
    ['encrypted', testKey()]
  ])('T-PQ-B5-01: opening a 0.3.0 %s database creates the table and changes no row', (_name, key) => {
    const file = tempDb()
    legacyRows(file, key)
    const before = openDatabase(file, key)
    before.exec('DROP TABLE IF EXISTS transport_observations')
    before.pragma('user_version = 0')
    const count = (db: ReturnType<typeof openDatabase>): unknown[] =>
      ['snapshots', 'updates', 'settings', 'notices'].map((t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)
    const counts = count(before)
    before.close()
    const store = new DocStore(file, { key })
    expect(store.transportObservations()).toEqual([])
    store.close()
    const after = openDatabase(file, key)
    expect(count(after)).toEqual(counts)
    expect(after.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'transport_observations'").get()).toBeDefined()
    after.close()
  })

  it('T-PQ-B5-02: an observation round-trips and a second one for the same remote replaces it', () => {
    const store = new DocStore(tempDb())
    store.recordTransport(obs())
    store.recordTransport(obs({ remote: 'git-https:github.com', transport: 'tls', kex: null, pq: 'unknown', source: 'test-connection', at: 5 }))
    expect(store.transportObservations()).toEqual(
      expect.arrayContaining([obs(), obs({ remote: 'git-https:github.com', transport: 'tls', kex: null, pq: 'unknown', source: 'test-connection', at: 5 })])
    )
    store.recordTransport(obs({ kex: 'secp384r1', pq: 'classical', at: 2000 }))
    const rows = store.transportObservations().filter((r) => r.remote === 'git-ssh:github.com')
    expect(rows).toEqual([obs({ kex: 'secp384r1', pq: 'classical', at: 2000 })])
    expect(store.transportObservations()).toHaveLength(2)
    store.close()
  })

  it.each([
    'git-https:user@github.com',
    'git-https:user:token@github.com',
    'git-https:github.com/owner/repo',
    'git-https:https://github.com/owner/repo',
    'git-https:github.com?token=abc',
    'git-ssh:git@github.com',
    'github.com',
    'git-ssh:',
    'onedrive:graph.microsoft.com#frag',
    'git-ssh:github.com:22/x'
  ])('T-PQ-B5-03: refuses remote %s so no credential is stored', (remote) => {
    const store = new DocStore(tempDb())
    expect(() => store.recordTransport(obs({ remote }))).toThrow(Error)
    expect(store.transportObservations()).toEqual([])
    store.close()
  })

  it('T-PQ-B5-03: accepts host-level remotes with a port', () => {
    const store = new DocStore(tempDb())
    store.recordTransport(obs({ remote: 'git-https:git.example.com:8443' }))
    expect(store.transportObservations()).toHaveLength(1)
    store.close()
  })
})

describe('DocStore schema versioning and hot path (B4)', () => {
  /** v0.6.7's schema, which had no `user_version`: `git show 28dcd01:packages/desktop/src/main/store.ts`. */
  function v067Database(file: string): void {
    const db = openDatabase(file, null)
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (doc_id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates (doc_id, id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS import_items (id TEXT PRIMARY KEY, last_modified TEXT, status TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS import_map (onenote_id TEXT PRIMARY KEY, slate_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_seen (item_id TEXT PRIMARY KEY, etag TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_synced (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, box_id TEXT NOT NULL, device TEXT NOT NULL, mine TEXT NOT NULL, theirs TEXT NOT NULL, merged TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transport_observations (remote TEXT PRIMARY KEY, transport TEXT NOT NULL, kex TEXT, pq INTEGER NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(page_id UNINDEXED, section_id UNINDEXED, notebook_id UNINDEXED, box_id UNINDEXED, ord UNINDEXED, text, tokenize = 'trigram');
      ALTER TABLE updates ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    `)
    db.prepare('INSERT INTO updates (doc_id, data, origin) VALUES (?, ?, ?)').run('page:old', Buffer.from([4]), 'local')
    db.close()
  }

  function schemaOf(file: string): { version: number; tables: unknown[] } {
    const db = openDatabase(file, null)
    const version = db.pragma('user_version', { simple: true }) as number
    const tables = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    db.close()
    return { version, tables }
  }

  it('T-B4-01: a v0.6.7 database and a fresh one reach the same schema version with the same tables', () => {
    const upgradedFile = tempDb()
    v067Database(upgradedFile)
    const upgraded = new DocStore(upgradedFile)
    // The migration runs on the old file without touching what it held.
    expect(upgraded.load('page:old').map((u) => Array.from(u))).toEqual([[4]])
    upgraded.close()
    const freshFile = tempDb()
    new DocStore(freshFile).close()
    expect(schemaOf(upgradedFile).version).toBeGreaterThan(0)
    expect(schemaOf(upgradedFile)).toEqual(schemaOf(freshFile))
  })

  it('T-B4-01: a second open of the same database runs no migration', () => {
    const file = tempDb()
    new DocStore(file).close()
    const before = schemaOf(file)
    const again = new DocStore(file)
    again.append('page:1', new Uint8Array([1]))
    again.close()
    expect(schemaOf(file)).toEqual(before)
  })

  it('T-B4-02: 1,000 appends prepare each statement once and count the doc\'s rows once', () => {
    vi.useFakeTimers()
    try {
      const db = openDatabase(tempDb(), null)
      const store = new DocStore(db)
      const prepare = vi.spyOn(db, 'prepare')
      for (let i = 0; i < 1_000; i++) store.append('page:spy', new Uint8Array([i % 256]))
      const sql = prepare.mock.calls.map((c) => c[0])
      expect(sql.filter((s) => /count\(\*\)/i.test(s))).toHaveLength(1)
      expect(sql).toHaveLength(new Set(sql).size)
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('T-B4-03: opening prunes audit and notices back to their caps, newest kept', () => {
    const file = tempDb()
    const first = new DocStore(file)
    for (let i = 0; i < 10_050; i++) first.appendAudit({ tool: 't', target: `a${i}`, outcome: 'ok' })
    for (let i = 0; i < 1_050; i++) first.addNotice(`n${i}`)
    first.close()
    const second = new DocStore(file)
    const audit = second.listAudit(20_000)
    expect(audit).toHaveLength(10_000)
    expect(audit[0]!.target).toBe('a10049')
    expect(audit[audit.length - 1]!.target).toBe('a50')
    second.close()
    const db = openDatabase(file, null)
    const notices = db.prepare('SELECT message FROM notices ORDER BY id').all() as Array<{ message: string }>
    expect(notices).toHaveLength(1_000)
    expect(notices[0]!.message).toBe('n50')
    db.close()
  })

  it('T-B4-04: only a compaction that finished resets the append counter', () => {
    vi.useFakeTimers()
    try {
      const file = tempDb()
      const compacted: string[] = []
      const store = new DocStore(file, { beforeCompact: (id) => compacted.push(id) })
      const updates = textEdits(Array.from({ length: 521 }, (_, i) => `w${i} `))
      const withheld = updates[1]!
      for (const [i, u] of updates.entries()) if (i !== 1) store.append('page:gap', u)
      vi.advanceTimersByTime(COMPACT_IDLE_MS)
      // The withheld row leaves updates pending, so that compaction bailed and the rows stand.
      expect(compacted).toEqual(['page:gap'])
      expect(store.load('page:gap')).toHaveLength(520)

      // The counter was not reset by the bail: the next append reschedules and this one folds.
      store.append('page:gap', withheld)
      vi.advanceTimersByTime(COMPACT_IDLE_MS)
      expect(compacted).toEqual(['page:gap', 'page:gap'])
      expect(store.load('page:gap').length).toBeLessThan(30)

      // ...and that one did reset it: a handful of further appends compact nothing.
      for (const u of textEdits(['a ', 'b ', 'c '])) store.append('page:gap', u)
      vi.advanceTimersByTime(COMPACT_IDLE_MS)
      expect(compacted).toHaveLength(2)
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DocStore change tracking (B3)', () => {
  it('T-B3-01: changedDocs returns only the docs appended to since the cursor, oldest change first', () => {
    const store = new DocStore(tempDb())
    store.append('page:a', new Uint8Array([1]))
    store.append('page:b', new Uint8Array([2]))
    const first = store.changedDocs(0)
    expect(first.ids).toEqual(['page:a', 'page:b'])
    expect(store.changedDocs(first.seq).ids).toEqual([])
    store.append('page:a', new Uint8Array([3]))
    const second = store.changedDocs(first.seq)
    expect(second.ids).toEqual(['page:a'])
    expect(second.seq).toBeGreaterThan(first.seq)
    store.close()
  })

  it('T-B3-01: a sequence never goes backwards, so a stored cursor cannot force a rescan', () => {
    const store = new DocStore(tempDb())
    store.append('page:a', new Uint8Array([1]))
    const { seq } = store.changedDocs(0)
    store.remove('page:a')
    expect(store.changedDocs(seq)).toEqual({ ids: [], seq })
    store.close()
  })

  it('T-B3-02: an update the sync engine appends counts as a change, because a restore must be pushed', () => {
    const store = new DocStore(tempDb())
    store.append('page:a', new Uint8Array([1]))
    const { seq } = store.changedDocs(0)
    store.append('page:a', new Uint8Array([2]), 'remote')
    expect(store.changedDocs(seq).ids).toEqual(['page:a'])
    store.close()
  })

  it('T-B3-03: a database upgraded from v0.6.7 reports no changed docs, so its first sync scans in full', () => {
    const file = tempDb()
    const old = new DocStore(file)
    old.append('page:a', new Uint8Array([1]))
    old.close()
    const db = openDatabase(file, null)
    db.exec('DROP TABLE doc_heads')
    db.pragma('user_version = 1')
    db.close()
    const store = new DocStore(file)
    expect(store.changedDocs(0)).toEqual({ ids: [], seq: 0 })
    expect(store.list('')).toEqual(['page:a'])
    store.close()
  })

  it('T-B3-04: unsyncedBlobs is one query and names only what the scope has not marked', () => {
    const store = new DocStore(tempDb())
    store.markBlobSynced('one.png')
    store.markBlobSynced('scope:two.png')
    expect(store.unsyncedBlobs(['one.png', 'two.png'])).toEqual(['two.png'])
    expect(store.unsyncedBlobs(['one.png', 'two.png'], 'scope:')).toEqual(['one.png'])
    store.close()
  })

  it('T-B3-05: syncMetaKeys lists the keys under a prefix and nothing else', () => {
    const store = new DocStore(tempDb())
    const bytes = new Uint8Array([1])
    for (const key of ['git:r:blob:a.png', 'git:r:blob:b.png', 'git:r:pushed:page:a', 'other:blob:c.png']) store.setSyncMeta(key, bytes)
    expect(store.syncMetaKeys('git:r:blob:')).toEqual(['git:r:blob:a.png', 'git:r:blob:b.png'])
    store.close()
  })
})

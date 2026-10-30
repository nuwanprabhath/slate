import type { KeyHandle } from '@slate/native'
import { openDatabase, type Database } from './db/openDatabase'
import { LoroDoc } from 'loro-crdt'
import type { ImportRecord } from '@slate/importer'
import type { ConflictRecord } from '@slate/sync'
import type { PqLevel, TransportObservation } from '../shared/api'

const COMPACT_THRESHOLD = 500
/**
 * Compaction rebuilds the whole doc on the main thread, which also routes the window's key presses,
 * so it waits for this long without an append to that doc rather than stalling a keystroke.
 */
export const COMPACT_IDLE_MS = 3_000

export interface AuditRow {
  id: number
  ts: number
  tool: string
  target: string
  outcome: string
}

/** How far a `loadSince` reader has read one doc. */
export interface DocCursor {
  lastId: number
  removals: number
}

export interface SearchRow {
  boxId: string
  ord: number
  text: string
}

const PQ_STORED: Record<PqLevel, number> = { hybrid: 1, classical: 0, unknown: -1 }
/** `<scheme>:<host>[:<port>]` and nothing else: userinfo, path, query and fragment never match. */
const REMOTE = /^[a-z][a-z0-9-]*:[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/

/** Local document store: Loro snapshots + append-only update rows, WAL-journaled. */
export class DocStore {
  private db: Database.Database

  /** `compact: false` is for the MCP CLI: only the app compacts, so the two never race on it. */
  private readonly options: { compact?: boolean }
  private readonly compactTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per doc, the highest update id the last compaction folded into the snapshot (`loadSince`). */
  private readonly compactedThrough = new Map<string, number>()
  private readonly removals = new Map<string, number>()

  /** The key is used to open the connection and not kept (§15 N9). */
  constructor(fileOrDb: string | Database.Database, options: { compact?: boolean; key?: KeyHandle | null } = {}) {
    this.db = typeof fileOrDb === 'string' ? openDatabase(fileOrDb, options.key ?? null) : fileOrDb
    this.options = { compact: options.compact }
    this.db.exec(`
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
    `)
    const columns = this.db.prepare('PRAGMA table_info(updates)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'origin')) this.db.exec(`ALTER TABLE updates ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'`)
  }

  /** Sync bookkeeping: strings and version-vector bytes share one table. */
  getSyncMeta(key: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as { value: Buffer } | undefined
    return row ? new Uint8Array(row.value) : undefined
  }

  setSyncMeta(key: string, value: Uint8Array): void {
    this.db
      .prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, Buffer.from(value))
  }

  syncSeen(itemId: string, eTag: string): boolean {
    return this.db.prepare('SELECT 1 FROM sync_seen WHERE item_id = ? AND etag = ?').get(itemId, eTag) !== undefined
  }

  markSyncSeen(itemId: string, eTag: string): void {
    this.db
      .prepare('INSERT INTO sync_seen (item_id, etag) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET etag = excluded.etag')
      .run(itemId, eTag)
  }

  blobSynced(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM blob_synced WHERE name = ?').get(name) !== undefined
  }

  markBlobSynced(name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO blob_synced (name) VALUES (?)').run(name)
  }

  addConflict(c: ConflictRecord): void {
    this.db
      .prepare('INSERT INTO conflicts (id, page_id, box_id, device, mine, theirs, merged, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.pageId, c.boxId, c.device, c.mine, c.theirs, c.merged, c.at)
  }

  listConflicts(pageId?: string): ConflictRecord[] {
    const sql = 'SELECT id, page_id AS pageId, box_id AS boxId, device, mine, theirs, merged, at FROM conflicts'
    const rows = pageId === undefined ? this.db.prepare(`${sql} ORDER BY at`).all() : this.db.prepare(`${sql} WHERE page_id = ? ORDER BY at`).all(pageId)
    return rows as ConflictRecord[]
  }

  removeConflict(id: string): void {
    this.db.prepare('DELETE FROM conflicts WHERE id = ?').run(id)
  }

  /** Upsert the last key exchange seen for a remote; `remote` must be host-level so no credential is stored. */
  recordTransport(o: TransportObservation): void {
    if (!REMOTE.test(o.remote)) throw new Error('A transport observation names a host only: no user, path, query or token')
    this.db
      .prepare(
        'INSERT INTO transport_observations (remote, transport, kex, pq, source, at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(remote) DO UPDATE SET transport = excluded.transport, kex = excluded.kex, pq = excluded.pq, source = excluded.source, at = excluded.at'
      )
      .run(o.remote, o.transport, o.kex, PQ_STORED[o.pq], o.source, o.at)
  }

  transportObservations(): TransportObservation[] {
    const rows = this.db.prepare('SELECT remote, transport, kex, pq, source, at FROM transport_observations ORDER BY remote').all() as Array<
      Omit<TransportObservation, 'pq'> & { pq: number }
    >
    return rows.map((r) => ({ ...r, pq: r.pq === 1 ? 'hybrid' : r.pq === 0 ? 'classical' : 'unknown' }))
  }

  addNotice(message: string): void {
    this.db.prepare('INSERT INTO notices (ts, message) VALUES (?, ?)').run(Date.now(), message)
  }

  /** Per update row: 'local' (this app or an agent) or 'remote' (another device, through sync). */
  origins(docId: string): string[] {
    return (this.db.prepare('SELECT origin FROM updates WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ origin: string }>).map((r) => r.origin)
  }

  /** Checkpoint of a OneNote page import. */
  getImportItem(id: string): ImportRecord | undefined {
    const row = this.db.prepare('SELECT last_modified, status, error FROM import_items WHERE id = ?').get(id) as
      | { last_modified: string; status: ImportRecord['status']; error: string | null }
      | undefined
    if (!row) return undefined
    return { lastModified: row.last_modified, status: row.status, ...(row.error !== null ? { error: row.error } : {}) }
  }

  setImportItem(id: string, record: ImportRecord): void {
    this.db
      .prepare(
        `INSERT INTO import_items (id, last_modified, status, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_modified = excluded.last_modified, status = excluded.status, error = excluded.error`,
      )
      .run(id, record.lastModified, record.status, record.error ?? null)
  }

  /** The Slate id (notebook id or tree id) a OneNote notebook, group, section or page was imported as. */
  getMapping(onenoteId: string): string | undefined {
    return (this.db.prepare('SELECT slate_id FROM import_map WHERE onenote_id = ?').get(onenoteId) as { slate_id: string } | undefined)?.slate_id
  }

  setMapping(onenoteId: string, slateId: string): void {
    this.db
      .prepare('INSERT INTO import_map (onenote_id, slate_id) VALUES (?, ?) ON CONFLICT(onenote_id) DO UPDATE SET slate_id = excluded.slate_id')
      .run(onenoteId, slateId)
  }

  appendAudit(entry: { tool: string; target: string; outcome: string }): void {
    this.db.prepare('INSERT INTO audit (ts, tool, target, outcome) VALUES (?, ?, ?, ?)').run(Date.now(), entry.tool, entry.target, entry.outcome)
  }

  listAudit(limit = 200): AuditRow[] {
    return this.db.prepare('SELECT id, ts, tool, target, outcome FROM audit ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[]
  }

  updatesSince(id: number): Array<{ id: number; docId: string; data: Uint8Array }> {
    const rows = this.db.prepare('SELECT id, doc_id, data FROM updates WHERE id > ? ORDER BY id').all(id) as Array<{ id: number; doc_id: string; data: Buffer }>
    return rows.map((r) => ({ id: r.id, docId: r.doc_id, data: new Uint8Array(r.data) }))
  }

  maxUpdateId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM updates').get() as { m: number }).m
  }

  /** Changes whenever ANOTHER connection commits to this database file. */
  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number
  }

  list(prefix: string): string[] {
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%'
    const rows = this.db
      .prepare(
        `SELECT doc_id FROM snapshots WHERE doc_id LIKE ? ESCAPE '\\'
         UNION SELECT doc_id FROM updates WHERE doc_id LIKE ? ESCAPE '\\' ORDER BY doc_id`,
      )
      .all(like, like) as Array<{ doc_id: string }>
    return rows.map((r) => r.doc_id)
  }

  load(docId: string): Uint8Array[] {
    const snapshot = this.db.prepare('SELECT data FROM snapshots WHERE doc_id = ?').get(docId) as { data: Buffer } | undefined
    const updates = this.db.prepare('SELECT data FROM updates WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ data: Buffer }>
    return [...(snapshot ? [snapshot.data] : []), ...updates.map((u) => u.data)].map((b) => new Uint8Array(b))
  }

  /**
   * The doc's rows after `cursor`, for a reader that keeps the doc in memory. `full` when the reader has
   * nothing yet, or a compaction or removal changed rows it had read: then `parts` is the whole doc and
   * the reader starts over.
   */
  loadSince(docId: string, cursor: DocCursor | undefined): { parts: Uint8Array[]; cursor: DocCursor; full: boolean } {
    return this.db.transaction(() => {
      const { last } = this.db.prepare('SELECT MAX(id) AS last FROM updates WHERE doc_id = ?').get(docId) as { last: number | null }
      const folded = this.compactedThrough.get(docId) ?? 0
      const removals = this.removals.get(docId) ?? 0
      const next = { lastId: Math.max(last ?? 0, folded, cursor?.lastId ?? 0), removals }
      if (!cursor || cursor.removals !== removals || folded > cursor.lastId) return { parts: this.load(docId), cursor: next, full: true }
      const rows = this.db.prepare('SELECT data FROM updates WHERE doc_id = ? AND id > ? ORDER BY id').all(docId, cursor.lastId) as Array<{ data: Buffer }>
      return { parts: rows.map((r) => new Uint8Array(r.data)), cursor: next, full: false }
    })()
  }

  append(docId: string, update: Uint8Array, origin: 'local' | 'remote' = 'local'): void {
    this.db.prepare('INSERT INTO updates (doc_id, data, origin) VALUES (?, ?, ?)').run(docId, Buffer.from(update), origin)
    if (this.options.compact === false) return
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE doc_id = ?').get(docId) as { n: number }
    if (n < COMPACT_THRESHOLD) return
    clearTimeout(this.compactTimers.get(docId))
    this.compactTimers.set(
      docId,
      setTimeout(() => {
        this.compactTimers.delete(docId)
        // Only an optimisation: on failure (a busy database) the rows stay, and the next append tries again.
        try {
          this.compact(docId)
        } catch {
          return
        }
      }, COMPACT_IDLE_MS),
    )
  }

  compact(docId: string): void {
    this.db.transaction(() => {
      const parts = this.load(docId)
      if (parts.length === 0) return
      const { last } = this.db.prepare('SELECT MAX(id) AS last FROM updates WHERE doc_id = ?').get(docId) as { last: number | null }
      if (last !== null) this.compactedThrough.set(docId, last)
      const doc = new LoroDoc()
      doc.importBatch(parts)
      const snapshot = doc.export({ mode: 'snapshot' })
      this.db
        .prepare('INSERT INTO snapshots (doc_id, data) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data')
        .run(docId, Buffer.from(snapshot))
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(docId)
    })()
  }

  remove(docId: string): void {
    clearTimeout(this.compactTimers.get(docId))
    this.compactTimers.delete(docId)
    this.removals.set(docId, (this.removals.get(docId) ?? 0) + 1)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(docId)
    })()
  }

  /**
   * The search index's rows for one page: one per text block, in reading order. Only the rows between
   * the unchanged first and last ones are rewritten: an edit re-indexes on the main thread, and
   * rewriting every trigram of a long page there stalled typing. Rows a rewrite puts between two kept
   * ones get an `ord` between theirs, so `ord` only orders a page's rows.
   */
  replaceSearchPage(page: { pageId: string; sectionId: string; notebookId: string }, rows: SearchRow[]): void {
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT INTO search (page_id, section_id, notebook_id, box_id, ord, text) VALUES (?, ?, ?, ?, ?, ?)')
      const old = this.db
        .prepare('SELECT rowid AS id, section_id AS sectionId, notebook_id AS notebookId, box_id AS boxId, ord, text FROM search WHERE page_id = ? ORDER BY ord')
        .all(page.pageId) as Array<SearchRow & { id: number; sectionId: string; notebookId: string }>
      const same = (a: SearchRow, b: SearchRow) => a.boxId === b.boxId && a.text === b.text
      let head = 0
      while (head < old.length && head < rows.length && same(old[head]!, rows[head]!)) head++
      let tail = 0
      while (tail < old.length - head && tail < rows.length - head && same(old[old.length - 1 - tail]!, rows[rows.length - 1 - tail]!)) tail++
      const added = rows.slice(head, rows.length - tail)
      const low = head > 0 ? old[head - 1]!.ord : (old[0]?.ord ?? 0) - added.length - 1
      const high = tail > 0 ? old[old.length - tail]!.ord : low + added.length + 1
      const step = (high - low) / (added.length + 1)
      const moved = old.some((r) => r.sectionId !== page.sectionId || r.notebookId !== page.notebookId)
      // Repeated inserts at one spot halve the gap each time: renumber before it runs out of precision.
      if (moved || old.length === 0 || step < 1e-6) {
        this.db.prepare('DELETE FROM search WHERE page_id = ?').run(page.pageId)
        rows.forEach((r, ord) => insert.run(page.pageId, page.sectionId, page.notebookId, r.boxId, ord, r.text))
        return
      }
      const remove = this.db.prepare('DELETE FROM search WHERE rowid = ?')
      for (const r of old.slice(head, old.length - tail)) remove.run(r.id)
      added.forEach((r, i) => insert.run(page.pageId, page.sectionId, page.notebookId, r.boxId, low + step * (i + 1), r.text))
    })()
  }

  removeSearchPage(pageId: string): void {
    this.db.prepare('DELETE FROM search WHERE page_id = ?').run(pageId)
  }

  clearSearch(): void {
    this.db.prepare('DELETE FROM search').run()
  }

  setSearchPageScope(pageId: string, sectionId: string, notebookId: string): void {
    this.db.prepare('UPDATE search SET section_id = ?, notebook_id = ? WHERE page_id = ? AND (section_id != ? OR notebook_id != ?)').run(sectionId, notebookId, pageId, sectionId, notebookId)
  }

  hasSearchRows(): boolean {
    return this.db.prepare('SELECT 1 FROM search LIMIT 1').get() !== undefined
  }

  /** Rows in scope, narrowed by an FTS5 trigram phrase when `phrase` is given (it needs 3+ characters). */
  searchRows(scope: { column: 'section_id' | 'notebook_id'; id: string } | null, phrase: string | null): Array<SearchRow & { pageId: string }> {
    const where: string[] = []
    const params: string[] = []
    if (phrase !== null) {
      where.push('search MATCH ?')
      params.push(`text:"${phrase.replace(/"/g, '""')}"`)
    }
    if (scope) {
      where.push(`${scope.column} = ?`)
      params.push(scope.id)
    }
    const sql = `SELECT page_id AS pageId, box_id AS boxId, ord, text FROM search ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY page_id, ord`
    return this.db.prepare(sql).all(...params) as Array<SearchRow & { pageId: string }>
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  close(): void {
    for (const t of this.compactTimers.values()) clearTimeout(t)
    this.compactTimers.clear()
    this.db.close()
  }
}

import Database from 'better-sqlite3'
import { LoroDoc } from 'loro-crdt'

const COMPACT_THRESHOLD = 500

export interface AuditRow {
  id: number
  ts: number
  tool: string
  target: string
  outcome: string
}

/** Local document store: Loro snapshots + append-only update rows, WAL-journaled. */
export class DocStore {
  private db: Database.Database

  /** `compact: false` is for the MCP CLI: only the app compacts, so the two never race on it. */
  constructor(file: string, private readonly options: { compact?: boolean } = {}) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (doc_id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates (doc_id, id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);
    `)
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

  append(docId: string, update: Uint8Array): void {
    this.db.prepare('INSERT INTO updates (doc_id, data) VALUES (?, ?)').run(docId, Buffer.from(update))
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE doc_id = ?').get(docId) as { n: number }
    if (n >= COMPACT_THRESHOLD && this.options.compact !== false) this.compact(docId)
  }

  compact(docId: string): void {
    this.db.transaction(() => {
      const parts = this.load(docId)
      if (parts.length === 0) return
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
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(docId)
    })()
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
    this.db.close()
  }
}

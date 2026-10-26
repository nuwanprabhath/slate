// @ts-check
import plugin from './plugin.mjs'
import { at, FIXTURE, ruleTester } from './ruleTester.mjs'
import sqlTextIsLiteral from './sql-text-is-literal.mjs'

const DB = "import type { Database } from '@slate/native'\ndeclare const db: Database.Database\n"
const typed = (/** @type {string} */ code) => ({ filename: FIXTURE, code })

// The rule itself, with types: only better-sqlite3 receivers count.
ruleTester({ typed: true }).run('slate/sql-text-is-literal (types)', /** @type {any} */ (sqlTextIsLiteral), {
  valid: [
    typed(`${DB}db.prepare('SELECT doc_id FROM snapshots WHERE doc_id = ?').get('x')`),
    typed(`${DB}db.exec(\`CREATE TABLE IF NOT EXISTS t (a TEXT)\`)\ndb.pragma('journal_mode = WAL')`),
    // Not SQL: a RegExp, and a method that happens to share the name (index.ts's migration.prepare).
    typed('declare const re: RegExp, s: string\nexport const m = re.exec(s)\ndeclare const migration: { prepare(pw: string): void }\nmigration.prepare(s)'),
  ],
  invalid: [
    // The shape audit Z-8 warns about: a value spliced into SQL text.
    { ...typed(`${DB}declare const title: string\ndb.prepare(\`SELECT * FROM search WHERE text = '\${title}'\`).all()`), errors: [{ messageId: 'literal' }] },
    { ...typed(`${DB}declare const key: Buffer\ndb.pragma(\`key = "x'\${key.toString('hex')}'"\`)`), errors: [{ messageId: 'literal' }] },
    { ...typed(`${DB}declare const table: string\ndb.exec('DELETE FROM ' + table)`), errors: [{ messageId: 'literal' }] },
    { ...typed(`${DB}const stmt = db.prepare('SELECT 1')\ndeclare const sql: string\nexport const s = stmt.database.prepare(sql)`), errors: [{ messageId: 'literal' }] },
    // Red team 6a: a structurally typed db (typed lint used to accept what the per-edit hook flagged), and bind.
    { ...typed('export const findByTitle = (db: { prepare(s: string): unknown }, t: string) => db.prepare(`SELECT * FROM search WHERE text = \'${t}\'`)'), errors: [{ messageId: 'literal' }] },
    { ...typed(`${DB}declare const sql: string\nexport const rows = db.prepare.bind(db)(sql)`), errors: [{ messageId: 'literal' }] },
    // Red team re-run 6a: a neutral receiver name and a structural type; the SQL text gives it away.
    { ...typed('export const find = (conn: { prepare(s: string): unknown }, t: string) => conn.prepare(`SELECT * FROM search WHERE text = \'${t}\'`)'), errors: [{ messageId: 'literal' }] },
    { ...typed("export const drop = (h: { exec(s: string): void }, t: string) => h.exec('DELETE FROM ' + t)"), errors: [{ messageId: 'literal' }] },
    // Red team G2-9: text joined from an array, or concatenated, starting as SQL.
    { ...typed("export const find = (conn: { prepare(s: string): unknown }, t: string) => conn.prepare(['SELECT * FROM search WHERE text = ', t].join(''))"), errors: [{ messageId: 'literal' }] },
    { ...typed("export const find = (conn: { prepare(s: string): unknown }, t: string) => conn.prepare(`SELECT * FROM t WHERE a = '`.concat(t, `'`))"), errors: [{ messageId: 'literal' }] },
    { ...typed("export const find = (conn: { exec(s: string): void }, t: string) => conn.exec(['DROP TABLE', t].join(' ').trim())"), errors: [{ messageId: 'literal' }] },
    // A Statement-typed receiver with a neutral name.
    { ...typed(`${DB}const q = db.prepare('SELECT 1')\nconst other = q.database\ndeclare const s: string\nexport const r = other.prepare(s)`), errors: [{ messageId: 'literal' }] },
  ],
})

// Its scope: main only, and the reviewed builders of tools/guards/allowlists/sql-dynamic.json.
ruleTester().run('slate/sql-text-is-literal (scope)', /** @type {any} */ (plugin.rules?.['sql-text-is-literal']), {
  valid: [
    at('packages/desktop/src/main/store.ts', 'declare const db: { prepare(s: string): { all(): unknown } }, sql: string\ndb.prepare(sql).all()'),
    at('packages/desktop/src/main/store.test.ts', 'declare const db: { exec(s: string): void }, sql: string\ndb.exec(sql)'),
    at('packages/editor/src/x.ts', 'declare const db: { exec(s: string): void }, sql: string\ndb.exec(sql)'),
  ],
  invalid: [
    { ...at('packages/desktop/src/main/search/searchIndex.ts', 'declare const db: { exec(s: string): void }, sql: string\ndb.exec(sql)'), errors: [{ messageId: 'literal' }] },
    // Red team re-run R4: the MCP and importer packages run in main as well.
    { ...at('packages/mcp/src/docs.ts', 'declare const db: { exec(s: string): void }, sql: string\ndb.exec(sql)'), errors: [{ messageId: 'literal' }] },
  ],
})

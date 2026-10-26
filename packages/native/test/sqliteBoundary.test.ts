// Guard for audit C3 criteria 1 and 2 across the whole repository: one SQLite binding (SQLCipher in
// @slate/native), reached only through openDatabase.ts, and no key material in SQL text.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = join(__dirname, '..', '..', '..')
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'release', 'build', '.build', 'prebuilds', 'fips', 'test-results', 'playwright-report', '.git', '.claude', 'docs'])
const SOURCE = /\.(?:[cm]?[jt]sx?)$/

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sources(join(dir, e.name), out)
    } else if (SOURCE.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

/** The only places that may hold the SQLite binding itself. */
const BINDING_OWNERS = [`packages${sep}native${sep}`, join('packages', 'desktop', 'src', 'main', 'db', 'openDatabase.ts')]
const OTHER_SQLITE = /(?:from|require\(|import\()\s*['"](?:better-sqlite3(?:-multiple-ciphers)?|sqlite3|node:sqlite|@slate\/native\/sqlite[^'"]*)['"]/
const BINDING_USE = /\bdatabaseClass\b|\.sqlite\b(?=\s*[,)])|native\.sqlite\b/

export function bindingViolations(files: Array<[string, string]>): string[] {
  const out: string[] = []
  for (const [rel, text] of files) {
    if (OTHER_SQLITE.test(text)) out.push(`${rel}: imports another SQLite binding`)
    if (!BINDING_OWNERS.some((o) => rel === o || rel.startsWith(o)) && BINDING_USE.test(text)) out.push(`${rel}: reaches the SQLite binding directly (use openDatabase)`)
  }
  return out
}

/** A key pragma's name in any spelling SQLite accepts: schema prefix, quotes or brackets, then `=` or `(`. */
const KEY_NAME = String.raw`(?:\w+\.)?["'\x60\[]?(?:hex|text)?(?:re)?key["'\x60\]]?\s*(?:=|\()`
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/)*`
/**
 * Review L3: key pragmas in any spelling (comments, quotes, brackets, `key(...)`), and since review M1
 * no ATTACH, DETACH or sqlcipher_* function in SQL text at all: the module's importPlaintextDatabase is
 * the only way to attach or export. The run-time authorizer refuses all of them too (sqlite.test.ts).
 */
const KEY_SQL = [
  new RegExp(String.raw`\bpragma\s*\(\s*[\x60'"]` + GAP + KEY_NAME, 'i'),
  new RegExp(String.raw`\bPRAGMA` + GAP + `(?:\\s|\\/\\*)` + '?' + GAP + KEY_NAME, 'i'),
  /\bATTACH\s+(?:DATABASE\s+)?(?:['"\x60]|\$\{|\?)/i,
  /\bDETACH\s+(?:DATABASE\s+)?['"\x60\w]/i,
  /\bsqlcipher_\w+\s*\(/i,
]

/**
 * Review L1, closed by C4: LK is unwrapped inside the module, so no production code turns JavaScript key
 * bytes into a database key. The C3 bridge (db/keyHandle.ts, withDbKey) and C4's test import
 * (importTestDbKey) are gone: since review C4 M1 the module has no such path, and tests bring a known key
 * in the way local-keys.json does (packages/desktop/test/vaultKeys.ts).
 */
const KEY_BRIDGE_USERS: string[] = []

export function keyBridgeViolations(files: Array<[string, string]>): string[] {
  return files
    .filter(([rel, text]) => /\b(?:withDbKey|dbKeyHandle|importTestDbKey)\b/.test(text) && !KEY_BRIDGE_USERS.includes(rel))
    .map(([rel]) => `${rel}: brings JavaScript key bytes into the module (LK is unwrapped there: vault/localKeys.ts)`)
}

/** Tests that show the refusal itself: they put a key pragma in SQL on purpose and expect SQLITE_AUTH. */
const REFUSAL_TESTS = [join('packages', 'native', 'test', 'sqlite.test.ts'), join('packages', 'desktop', 'src', 'main', 'db', 'openDatabase.test.ts')]

export function keySqlViolations(files: Array<[string, string]>): string[] {
  const out: string[] = []
  for (const [rel, text] of files) for (const re of KEY_SQL) if (re.test(text)) out.push(`${rel}: ${re.exec(text)![0]}`)
  return out
}

const files: Array<[string, string]> = sources(join(repo, 'packages'))
  .concat(sources(join(repo, 'scripts')), sources(join(repo, 'bin')))
  .filter((f) => !f.endsWith(`${sep}sqliteBoundary.test.ts`))
  .map((f) => [relative(repo, f), readFileSync(f, 'utf8')])

describe('C3 guard: the SQLite binding and its keys', () => {
  it('scans the repository', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(([rel]) => rel.endsWith(join('db', 'openDatabase.ts')))).toBe(true)
  })

  it('criterion 1: no other SQLite binding, and only openDatabase.ts reaches the one in @slate/native', () => {
    expect(bindingViolations(files)).toEqual([])
  })

  it('criterion 2: no SQL text carries a key (key pragmas, ATTACH … KEY other than \'\')', () => {
    // packages/native owns the binding (its C names sqlcipher_* functions); the run-time authorizer guards it.
    expect(keySqlViolations(files.filter(([rel]) => !REFUSAL_TESTS.includes(rel) && !rel.startsWith(join('packages', 'native') + sep)))).toEqual([])
  })

  it('review L1 (C4): no production file brings JavaScript key bytes into the module; the C3 bridge is gone', () => {
    expect(keyBridgeViolations(files)).toEqual([])
    expect(files.some(([rel]) => rel.endsWith(join('db', 'keyHandle.ts')))).toBe(false)
    expect(keyBridgeViolations([['packages/desktop/src/main/sync/x.ts', 'withDbKey(bytes, (h) => h)']])).toHaveLength(1)
    expect(keyBridgeViolations([['packages/desktop/src/main/services.ts', 'importTestDbKey(bytes)']])).toHaveLength(1)
  })

  it('the guards catch the bad patterns', () => {
    expect(bindingViolations([['packages/desktop/src/main/x.ts', "import Database from 'better-sqlite3-multiple-ciphers'"]])).toHaveLength(1)
    expect(bindingViolations([['packages/desktop/src/main/x.ts', "import { databaseClass } from '@slate/native'"]])).toHaveLength(1)
    expect(bindingViolations([['packages/mcp/src/x.ts', "const D = require('node:sqlite')"]])).toHaveLength(1)
    expect(bindingViolations([[join('packages', 'desktop', 'src', 'main', 'db', 'openDatabase.ts'), "import { databaseClass } from '@slate/native'"]])).toEqual([])
    for (const bad of [
      "db.pragma(`key = \"x'${hex}'\"`)", "db.pragma('rekey = ?')", "db.exec(`PRAGMA main.hexkey = '00'`)", "db.exec(`ATTACH DATABASE 'a.db' AS a KEY 'secret'`)",
      'db.exec(`ATTACH DATABASE ${f} AS a KEY ${k}`)', "db.exec(`ATTACH DATABASE ${f} AS a\n  KEY ${k}`)", "db.exec(`ATTACH ${sqlString(f)} AS plain KEY ''`)",
      "db.exec('DETACH DATABASE plain')", "db.prepare(\"SELECT sqlcipher_export('main', 'plain')\").get()", "db.exec(`PRAGMA key('x')`)", "db.pragma(\"key('abc')\")",
      'db.exec(`PRAGMA "key" = 1`)', 'db.exec(`PRAGMA [key] = 1`)', 'db.exec(`PRAGMA/**/key = 1`)', 'db.exec(`PRAGMA /* c */ main.\x60rekey\x60 = 1`)',
    ]) {
      expect(keySqlViolations([['x.ts', bad]]), bad).toHaveLength(1)
    }
    expect(keySqlViolations([['x.ts', 'out.importPlaintextDatabase(plainFile)']])).toEqual([])
    expect(keySqlViolations([['x.ts', '// the export attaches this file, and nothing may wait in a -wal beside it']])).toEqual([])
    expect(keySqlViolations([['x.ts', "db.pragma('cipher_memory_security = ON')"]])).toEqual([])
  })
})

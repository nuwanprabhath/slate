import { describe, expect, it } from 'vitest'
import { erasableNames } from '../../packages/desktop/src/main/privacy/erase'
import { isTestFile, read, walk } from './repo'

/**
 * Erase all (GDPR Art. 17) removes the data folder's entries by name (`erasableNames` in main/privacy/erase.ts), so a
 * file main starts writing there escapes it unless that list learns its name. Every name main puts in the data folder
 * is found here and must be erasable, or be in EXCLUDED with the reason it may stay. See
 * docs/architecture/golden-paths.md#privacy.
 */

const MAIN = 'packages/desktop/src/main'
const FIX = 'add it to ERASED_FILES or ERASED_DIRS (or the DATABASE pattern) in main/privacy/erase.ts, or, if it may outlive erase all, to EXCLUDED in tools/guards/eraseCoverage.test.ts with the reason; see docs/architecture/golden-paths.md#privacy'

/** Data-folder names erase all leaves on purpose. */
const EXCLUDED: Record<string, string> = {
  'slate.lock': 'held by the running process, which erase all relaunches; it holds no data',
  'policy.json': 'POLICY_FILE is read from the app resources (profilePeek.ts), never written to the data folder',
  'mcp.sock': 'the AI socket the running app listens on; it carries no data and the server removes it when it closes',
}

/** Data-folder joins whose name the scan cannot work out, by `file: argument`, with why erase all covers them. */
const DYNAMIC: Record<string, string> = {
  'index.ts: f': 'loops over VAULT_FILE, PENDING_FILE, PREV_FILE, PREUNLOCK_FILE, MIGRATION_FILE (each a *_FILE constant)',
  'privacy/erase.ts: name': "erase all's own removal of what erasableNames picked",
  'privacy/dataRights.ts: file': "SEALED_FILES: msal-cache.bin and files inside git-sync/, which ERASED_DIRS removes whole",
  'db/migrateToEncrypted.ts: f': 'removes slate.db* and temp copies erasableNames matches (DATABASE)',
  'db/migrateToEncrypted.ts: d': 'removes blobs (ERASED_DIRS) and Chromium caches (clearBrowserStorage)',
  'vault/migration.ts: f': 'path(f), read(f) and the loops take *_FILE constants and the bound database name (DATABASE)',
  'vault/migration.ts: dbFile': 'slate-<8 hex>.db, matched by DATABASE',
  'vault/unlock.ts: f': 'path(f) takes *_FILE constants',
  'vault/unlock.ts: opened.db': 'the bound database name slate-<8 hex>.db, matched by DATABASE',
  'vault/pqUpgrade.ts: f': 'path(d, f) takes PQ_CANDIDATE_FILE and the vault *_FILE constants',
}

/** Files that are scaffolding for tests or CLIs, not the app's own data folder. */
const NOT_THE_APP = new Set([`${MAIN}/vault/testVault.ts`, `${MAIN}/db/testModule.ts`, `${MAIN}/onenote/importCli.ts`])

const DATA_DIR = String.raw`(?:(?:[\w]+\.)*(?:dataDir|userData)|app\.getPath\('userData'\))`

/**
 * Every string constant in `texts` (`const NAME = 'x'` or "x", exported or not), with one step of aliasing
 * (`const A = B`), so `join(dataDir, NAME)` resolves to the name whatever the constant is called.
 */
export function fileConstants(texts: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of texts) for (const m of t.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2/g)) out.set(m[1]!, m[3]!)
  for (const t of texts) for (const m of t.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*$/gm)) if (out.has(m[2]!) && !out.has(m[1]!)) out.set(m[1]!, out.get(m[2]!)!)
  return out
}

/**
 * What `text` puts in the data folder. `names`: every `*_FILE` constant, and the first segment of every
 * `join`/`resolve` onto the data folder that is a string literal or a constant `constants` resolves, plus the
 * encrypted database name. `dynamic`: each such argument this scan cannot work out (a template literal, a
 * parameter, a loop variable, a property); the guard fails on each unless DYNAMIC gives the reason it is covered.
 *
 * Not seen at all (review by hand): a data-folder path built in another variable first (`const p = dataDir;
 * join(p, …)`), string concatenation (`dataDir + '/x'`), and names that come from data at run time.
 */
export function dataFolderRefs(text: string, constants: ReadonlyMap<string, string>): { names: string[]; dynamic: string[] } {
  const names = new Set<string>()
  const dynamic: string[] = []
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*_FILE\s*=\s*(['"])([^'"]+)\1/g)) names.add(m[2]!)
  const call = new RegExp(String.raw`\b(?:join|resolve)\(\s*${DATA_DIR}\s*,\s*('[^']*'|"[^"]*"|` + '`[^`]*`' + String.raw`|[\w$.]+)`, 'g')
  for (const m of text.matchAll(call)) {
    const arg = m[1]!
    if (/^['"]/.test(arg)) names.add(arg.slice(1, -1))
    else if (constants.has(arg)) names.add(constants.get(arg)!)
    else dynamic.push(arg)
  }
  // `slate-${…}.db`: an encrypted database; stands for every one of them.
  for (const m of text.matchAll(/`slate-\$\{[^}]+\}(\.db)`/g)) names.add(`slate-0123abcd${m[1]!}`)
  return { names: [...names], dynamic }
}

/** The names alone (fixtures). */
export const dataFolderNames = (text: string): string[] => dataFolderRefs(text, fileConstants([text])).names

/** The temp names a migration writes beside its output database (`${outFile}.tmp`), with each journal of them. */
export function migrationTempNames(text: string, outFile = 'slate-0123abcd.db'): string[] {
  const suffixes = [...text.matchAll(/`\$\{outFile\}([^`$]+)`/g)].map((m) => m[1]!)
  const journals = [...text.matchAll(/`\$\{tmp\}(-[a-z]+)`/g)].map((m) => m[1]!)
  return [...new Set(suffixes)].flatMap((s) => [`${outFile}${s}`, ...journals.map((j) => `${outFile}${s}${j}`)])
}

const uncovered = (names: readonly string[]): string[] => {
  const erasable = new Set(erasableNames(names, null))
  return names.filter((n) => !erasable.has(n) && !(n in EXCLUDED))
}

describe('erase coverage helpers (fixtures)', () => {
  it('finds file constants, names joined onto the data folder and encrypted database names', () => {
    const src = [
      "export const VAULT_FILE = 'vault.json'",
      "const cache = join(dataDir, 'msal-cache.bin')",
      "log.configure({ dir: join(app.getPath('userData'), 'logs', 'x.log') })",
      "const c = join(this.deps.dataDir, 'git-sync')",
      "join(resourcesPath, 'fips')",
      'const db = `slate-${id.slice(0, 8)}.db`',
    ].join('\n')
    expect(dataFolderNames(src).sort()).toEqual(['git-sync', 'logs', 'msal-cache.bin', 'slate-0123abcd.db', 'vault.json'])
  })

  it('also reads resolve(), a name constant not called *_FILE, a double-quoted *_FILE, and refuses a name it cannot work out (security review of correct)', () => {
    const src = [
      "const CACHE_NAME = 'secret-cache.json'",
      'export const OTHER_FILE = "other.json"',
      "resolve(dataDir, 'resolved.json')",
      'join(dataDir, CACHE_NAME)',
      'join(userData, `cache-${id}.json`)',
      'join(dataDir, name)',
    ].join('\n')
    const refs = dataFolderRefs(src, fileConstants([src]))
    expect(refs.names.sort()).toEqual(['other.json', 'resolved.json', 'secret-cache.json'])
    expect(refs.dynamic).toEqual(['`cache-${id}.json`', 'name'])
  })

  it('works out a migration temp file and its journals', () => {
    const src = 'const tmp = `${outFile}.tmp`\nconst enc = `${outFile}.enc.tmp`\nfor (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`])'
    expect(migrationTempNames(src, 'x.db')).toEqual(['x.db.tmp', 'x.db.tmp-journal', 'x.db.tmp-wal', 'x.db.enc.tmp', 'x.db.enc.tmp-journal', 'x.db.enc.tmp-wal'])
  })

  it('fails a name erase all does not know (the temp copies erase all once left behind, review R4)', () => {
    expect(uncovered(['vault.json', 'new-cache.bin'])).toEqual(['new-cache.bin'])
  })
})

describe('erase all covers every name main writes into the data folder', () => {
  const files = walk(MAIN, ['.ts']).filter((f) => !isTestFile(f) && !NOT_THE_APP.has(f))
  const constants = fileConstants(files.map(read))
  const refs = files.map((f) => ({ file: f, ...dataFolderRefs(read(f), constants) }))
  const names = [...new Set(refs.flatMap((r) => r.names))].sort()
  const dynamic = refs.flatMap((r) => r.dynamic.map((arg) => `${r.file.slice(MAIN.length + 1)}: ${arg}`))

  it('every name joined onto the data folder that this scan cannot work out says why it is covered', () => {
    expect([...new Set(dynamic)].filter((d) => !(d in DYNAMIC)).map((d) => `${d}: a data-folder name the scan cannot read; use a *_FILE constant or a literal, or add it to DYNAMIC in tools/guards/eraseCoverage.test.ts with why erase all still removes it`)).toEqual([])
    expect(Object.keys(DYNAMIC).filter((d) => !dynamic.includes(d)).map((d) => `${d}: no longer in the code; drop it from DYNAMIC`)).toEqual([])
  })

  it('finds the names it must (a scan that finds nothing proves nothing)', () => {
    expect(names).toEqual(expect.arrayContaining(['vault.json', 'local-keys.json', 'msal-cache.bin', 'update-result.json', 'logs', 'security-log', 'blobs', 'git-sync', 'fips', 'slate.db', 'slate-0123abcd.db']))
  })

  it('every *_FILE constant and every literal joined onto the data folder is erased, or excluded with a reason', () => {
    expect(uncovered(names).map((n) => `${n}: erase all would leave it; ${FIX}`)).toEqual([])
  })

  it('every temp file migrateToEncrypted.ts writes is erased (it may be a plaintext copy of the notes)', () => {
    const temps = migrationTempNames(read(`${MAIN}/db/migrateToEncrypted.ts`))
    expect(temps.length).toBeGreaterThanOrEqual(4)
    expect(uncovered(temps).map((n) => `${n}: erase all would leave it; ${FIX}`)).toEqual([])
  })

  it('every exclusion is still a name main writes', () => {
    expect(Object.keys(EXCLUDED).filter((n) => !names.includes(n)).map((n) => `${n}: no longer written to the data folder; drop it from EXCLUDED`)).toEqual([])
  })
})

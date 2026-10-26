import { describe, expect, it } from 'vitest'
import { isTestFile, read, walk } from './repo'

/**
 * C9 (audit §4.7, §7.3 C9 criterion 2): a key rotation, a format upgrade or a FIPS conversion runs only through the
 * resumable migration runner (`Migration` in vault/migration.ts), whose staged pair, compare-and-swap and
 * `migration.json` make every step recoverable. Nothing else builds a rotated header, moves a key into history,
 * writes the vault header to disk or the remote, or emits the rotation's audit events.
 * Accepted path: add a step to `Migration` (prepareRekey, runRekey, afterSync) and its crash test in rekey.test.ts.
 */
interface Rule {
  what: string
  pattern: RegExp
  /** Repo-relative files allowed to contain it (the definition and the runner). */
  allowed: readonly string[]
  /** How many sites the allowed files may hold in all, when it is an audit event (one site). */
  sites?: number
}

const VAULT = 'packages/desktop/src/main/vault'
export const RULES: readonly Rule[] = [
  { what: 'a rotated header (rekeyHeader)', pattern: /\brekeyHeader\(/g, allowed: [`${VAULT}/header.ts`, `${VAULT}/migration.ts`] },
  { what: 'history pruning (pruneHistory)', pattern: /\bpruneHistory\(/g, allowed: [`${VAULT}/header.ts`, `${VAULT}/migration.ts`] },
  { what: 'a key moved into history (historySeal, historyRewrap)', pattern: /\.history(Seal|Rewrap)\(/g, allowed: [`${VAULT}/header.ts`, `${VAULT}/selftest/post.ts`] },
  { what: "a rotated header's compare-and-swap (commitRekeyedHeader)", pattern: /\bcommitRekeyedHeader\(/g, allowed: [`${VAULT}/remoteVault.ts`, `${VAULT}/migration.ts`] },
  // Review C9 M4/M5: a remote header is written at one site, casWriteHeader: a true compare-and-swap over the exact
  // header last seen there. The update and rekey paths call it too.
  { what: 'a remote header write (writeHeader; use casWriteHeader)', pattern: /\.writeHeader\(/g, allowed: [`${VAULT}/remoteVault.ts`], sites: 1 },
  {
    what: 'a vault header written to disk (vault.json, its staged or pending copy)',
    pattern: /(writeJsonAtomic|renameSync)\([^\n]*\b(REJOIN_)?VAULT_FILE\)|writeJsonAtomic\([^\n]*\bPENDING_FILE\)/g,
    allowed: [`${VAULT}/migration.ts`, `${VAULT}/unlock.ts`, `${VAULT}/vaultCheck.ts`, `${VAULT}/testVault.ts`],
  },
  { what: 'the vault.key.rotated event', pattern: /securityEvent\.keyRotated\(/g, allowed: [`${VAULT}/migration.ts`], sites: 1 },
  { what: 'the vault.profile.changed event', pattern: /securityEvent\.profileChanged\(/g, allowed: [`${VAULT}/migration.ts`], sites: 1 },
]

const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every use of a rule outside its allowed files, and every event emitted at more sites than its one. */
export function rekeyProblems(files: ReadonlyArray<{ rel: string; text: string }>, rules: readonly Rule[] = RULES): string[] {
  const problems: string[] = []
  for (const rule of rules) {
    let sites = 0
    for (const { rel, text } of files) {
      const n = [...code(text).matchAll(rule.pattern)].length
      if (n === 0) continue
      if (!rule.allowed.includes(rel)) problems.push(`${rel}: ${rule.what} outside the migration runner; add a step to Migration (vault/migration.ts) with its crash test`)
      else sites += n
    }
    if (rule.sites !== undefined && sites > rule.sites) problems.push(`${rule.what} is at ${sites} sites; it has exactly one`)
  }
  return problems
}

/** The lock's key-closing steps in index.ts that do not first discard a prepared key change (`migration.discard()`). */
export function lockDiscards(index: string): string[] {
  const steps = [...index.matchAll(/\b(closeKeys|closeKeyRing):\s*\(\)\s*=>\s*(\{[\s\S]*?\n\s*\}|[^\n]*)/g)]
  const problems = steps.filter((m) => !/migration\.discard\(\)/.test(m[2] ?? '')).map((m) => `${m[1]}: call migration.discard() before the keys close`)
  return steps.length === 0 ? ['no closeKeys step found in index.ts'] : problems
}

const sources = (): Array<{ rel: string; text: string }> =>
  ['packages/desktop/src', 'packages/sync/src', 'packages/mcp/src']
    .flatMap((dir) => walk(dir, ['.ts', '.tsx'], (rel) => isTestFile(rel)))
    .filter((rel) => !isTestFile(rel))
    .map((rel) => ({ rel, text: read(rel) }))

describe('C9: key changes only through the resumable migration runner', () => {
  it('no other code builds a rotated header, moves a key into history, writes the header or emits the rotation events', () => {
    expect(rekeyProblems(sources())).toEqual([])
  })

  it('review C9 M3: every lock (and the fail-closed path) discards a prepared key change before the keys close', () => {
    const index = code(read('packages/desktop/src/main/index.ts'))
    expect(lockDiscards(index)).toEqual([])
    expect(lockDiscards('closeKeys: () => svc.keyRing?.close(),\ncloseKeyRing: () => {\n  ring?.close()\n}')).toHaveLength(2)
  })

  it('the detection fails on the patterns it exists for (self-test)', () => {
    const planted = [
      { rel: 'packages/desktop/src/main/index.ts', text: "const made = await rekeyHeader({ kind: 'rotate' })\nsecurityEvent.keyRotated({ fromEpoch: 0, toEpoch: 1 })" },
      { rel: 'packages/desktop/src/main/sync/syncService.ts', text: 'await remote.writeHeader(h, v)\nawait writeJsonAtomic(join(dataDir, VAULT_FILE), header)' },
      { rel: `${VAULT}/vaultCheck.ts`, text: 'await remote.writeHeader(local, snap.version)' },
      { rel: `${VAULT}/unlock.ts`, text: 'n.historySeal(kek, iv, aad, ct, mk, ctx, aad2)' },
      { rel: `${VAULT}/migration.ts`, text: 'securityEvent.profileChanged({ from, to })\nsecurityEvent.profileChanged({ from, to })' },
    ]
    const found = rekeyProblems(planted)
    expect(found.filter((p) => p.startsWith('packages/desktop/src/main/index.ts'))).toHaveLength(2)
    expect(found.filter((p) => p.startsWith('packages/desktop/src/main/sync/syncService.ts'))).toHaveLength(2)
    expect(found.some((p) => p.startsWith(`${VAULT}/unlock.ts`))).toBe(true)
    expect(found.some((p) => p.startsWith(`${VAULT}/vaultCheck.ts`) && p.includes('writeHeader'))).toBe(true)
    expect(found.some((p) => p.includes('vault.profile.changed event is at 2 sites'))).toBe(true)
    // A second remote write beside casWriteHeader, even in remoteVault.ts, is refused.
    expect(rekeyProblems([{ rel: `${VAULT}/remoteVault.ts`, text: 'return remote.writeHeader(h, v)\nawait remote.writeHeader(next, snap.version)' }]).some((p) => p.includes('writeHeader') && p.includes('2 sites'))).toBe(true)
    // A comment naming them is not a use.
    expect(rekeyProblems([{ rel: 'packages/desktop/src/main/index.ts', text: '// rekeyHeader( and .writeHeader( are the runner\'s' }])).toEqual([])
  })
})

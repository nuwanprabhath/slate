import { describe, expect, it } from 'vitest'
import { read, walk } from './repo'

/**
 * Review C9 C1 (and the phase 11 reviews after it): a crash test of a key change (`runRekey`, `rejoin`) that unlocks
 * afterwards only with the secret it already knew passes while the other secret deletes the notes. Accepted path:
 * end the test with `expectNotesSurviveCrash(dir, { old, next: [...], notes, opts })` from vault/testVault.ts, which
 * unlocks with the old secret and every new one, alone and in both orders, and counts the notes each time.
 */
const KEY_CHANGE = /\b(runRekey|rejoin)\(/
const CRASH = /Injected crash before/
const HELPER = /\bexpectNotesSurviveCrash\(\s*[^,]+,\s*\{[\s\S]*\bold\b[\s\S]*\bnext\b/

/** Files whose key-change crash tests check both secrets another way, and why. */
const EXEMPT: Record<string, string> = {
  'packages/desktop/src/main/vault/rekeyCrashConvert.test.ts':
    'The fips latch stops Argon2id once the fips password has run, so the old password is tried in phase 1 and the new one in phase 2 on separate copies; both assert the note.',
}

/** The source of every it/test body in `text`: from the callback's `{` to its matching `}` (braces balance in code). */
export function testBodies(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?<![\w.])(it|test)(\.\w+)*(\([^)]*\))?\(/g)) {
    const arrow = text.slice(m.index).search(/=>\s*\{|function\s*\([^)]*\)\s*\{/)
    if (arrow < 0) continue
    const open = text.indexOf('{', m.index + arrow)
    let depth = 0
    let i = open
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) break
    }
    out.push(text.slice(open, i + 1))
  }
  return out
}

/** Crash tests of a key change in `text` that do not end with the old-and-new-secret check. */
export function crashProblems(rel: string, text: string): string[] {
  if (EXEMPT[rel]) return []
  return testBodies(text)
    .filter((b) => CRASH.test(b) && KEY_CHANGE.test(b) && !HELPER.test(b))
    .map(
      (b) =>
        `${rel}: a crash test of a key change (${b.slice(0, 60).replace(/\s+/g, ' ')}…) must call expectNotesSurviveCrash(dir, { old, next: [...], notes, opts }) from vault/testVault.ts, so the old and the new secret both unlock and the notes are counted (review C9 C1)`,
    )
}

describe('crash tests of a key change unlock with the old and the new secret (review C9 C1)', () => {
  it('every runRekey/rejoin crash test in main calls expectNotesSurviveCrash', () => {
    const files = walk('packages/desktop/src/main', ['.test.ts'])
    const problems = files.flatMap((f) => crashProblems(f, read(f)))
    expect(files.filter((f) => /rekey|migration/.test(f)).length).toBeGreaterThan(3)
    expect(problems).toEqual([])
  })

  it('fails on the crash loop review C9 C1 found, which unlocked only with the password it kept (self-test)', () => {
    const bad = [
      'for (const step of REKEY_STEPS) {',
      '  it(`a crash before ${step} recovers`, async () => {',
      '    const m = new Migration(deps({ crashAt: step }))',
      "    await m.prepareRekey(ring, 'rotate', secretBytes(PASSWORD))",
      '    await expect(m.runRekey(ring)).rejects.toThrow(`Injected crash before ${step}`)',
      "    expect(await noteAfterUnlock(PASSWORD)).toBe('SECRET-NOTE')",
      '  })',
      '}',
    ].join('\n')
    expect(crashProblems('x/rekey.test.ts', bad)).toHaveLength(1)
    const oldOnly = bad.replace("expect(await noteAfterUnlock(PASSWORD)).toBe('SECRET-NOTE')", 'await expectNotesSurviveCrash(dataDir, { old, notes, opts: weak })')
    expect(crashProblems('x/rekey.test.ts', oldOnly)).toHaveLength(1)
    const good = bad.replace("expect(await noteAfterUnlock(PASSWORD)).toBe('SECRET-NOTE')", 'await expectNotesSurviveCrash(dataDir, { old, next: [rk], notes, opts: weak })')
    expect(crashProblems('x/rekey.test.ts', good)).toEqual([])
  })
})

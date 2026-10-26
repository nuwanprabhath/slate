import { describe, expect, it } from 'vitest'
import { APP_ENV_VARS, PLATFORM_ENV_VARS, TEST_HOOK_VARS } from '../../packages/desktop/src/main/testHooks'
import { allowlist, isTestFile, read, walk } from './repo'

/**
 * Every environment variable src/main reads is a decision: a test hook (TEST_HOOK_VARS, which a
 * packaged app scrubs) or a variable a packaged app obeys, with its reason in
 * tools/guards/allowlists/env-vars.json. Only testHooks.ts touches process.env, so the names are all
 * visible as `env('NAME')` (or `env.NAME` on an `envSnapshot()` handed to a pure function).
 */
// The sanctioned homes: main's reader, and sync's whole-env pass-through to git.
const HOMES = new Set(['packages/desktop/src/main/testHooks.ts', 'packages/sync/src/childEnv.ts'])
const READS = [/\benv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g, /\benv\.([A-Z][A-Z0-9_]*)/g]
/** `process.env`, `process['env']`, `process [ "env" ]`: the same detection as slate/env-through-test-hooks. */
export const PROCESS_ENV = /\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|from\s+['"](?:node:)?process['"]/

// Every package that runs in the main process (red team G2-7).
const sources = ['packages/desktop/src/main', 'packages/sync/src', 'packages/mcp/src', 'packages/importer/src'].flatMap((d) => walk(d, ['.ts'])).filter((f) => !isTestFile(f)).concat(['packages/native/index.ts'])

function readsUnderMain(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of sources) {
    const text = read(file)
    for (const re of READS) for (const m of text.matchAll(re)) found.set(m[1]!, [...(found.get(m[1]!) ?? []), file])
  }
  return found
}

describe('environment variables read by main', () => {
  const documented = allowlist('env-vars')
  const hooks = new Set<string>(TEST_HOOK_VARS)
  const known = [...APP_ENV_VARS, ...PLATFORM_ENV_VARS] as readonly string[]

  it('only testHooks.ts touches process.env', () => {
    const direct = sources.filter((f) => !HOMES.has(f) && PROCESS_ENV.test(read(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    expect(direct.map((f) => `${f}: read through env() or envSnapshot() from src/main/testHooks.ts`)).toEqual([])
  })

  it('the detection sees every spelling the red team used (self-test)', () => {
    for (const s of ['vars = process.env', "process['env']['SLATE_X']", 'Object.entries(process.env)', 'process [ "env" ]', 'const { env } = process', "import { env } from 'node:process'"]) expect(PROCESS_ENV.test(s), s).toBe(true)
    expect(PROCESS_ENV.test('process.platform')).toBe(false)
  })

  it('are test hooks or documented (tools/guards/allowlists/env-vars.json)', () => {
    const unknown = [...readsUnderMain()].filter(([name]) => !hooks.has(name) && !(name in documented))
    expect(
      unknown.map(([name, files]) => `${name} (${[...new Set(files)].join(', ')}): add it to TEST_HOOK_VARS in src/main/testHooks.ts if it weakens or redirects the app, else to APP_ENV_VARS or PLATFORM_ENV_VARS there and to env-vars.json with its reason`),
    ).toEqual([])
  })

  it('every APP_ENV_VARS and PLATFORM_ENV_VARS name has its reason, and no test hook is listed as an app variable', () => {
    expect(known.filter((name) => !(name in documented))).toEqual([])
    expect(TEST_HOOK_VARS.filter((name) => name in documented || known.includes(name))).toEqual([])
  })

  it('env-vars.json has no entry nothing reads', () => {
    const read = readsUnderMain()
    expect(Object.keys(documented).filter((name) => !read.has(name) && !known.includes(name))).toEqual([])
  })
})

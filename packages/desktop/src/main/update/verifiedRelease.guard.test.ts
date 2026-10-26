import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// VerifiedRelease is a compile-time brand: only a cast can forge one. verifier.ts makes it after the
// signature checks; test files may stub it. Anywhere else a cast would skip verification (review R3).
const src = join(__dirname, '..', '..')
const CAST = /\bas\s+(?:unknown\s+as\s+)?VerifiedRelease\b|<VerifiedRelease>/

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('VerifiedRelease is only made by the verifier (review R3)', () => {
  it('no production file casts to VerifiedRelease outside verifier.ts', () => {
    const all = files(src)
    const casting = all.filter((f) => CAST.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f))
    // The detector finds the one legitimate cast, so it is not vacuous.
    expect(casting).toContain(join('main', 'update', 'verifier.ts'))
    expect(casting.filter((f) => f !== join('main', 'update', 'verifier.ts') && !/\.test\.tsx?$/.test(f))).toEqual([])
  })
})

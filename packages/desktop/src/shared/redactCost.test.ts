import { describe, expect, it } from 'vitest'
import { redactString } from './redact'

// FX-3 (finding M3): redactString's cost must not grow with the length of what a caller hands it.
// A long field is reachable: syncService logs a failed git command's whole stderr, which
// packages/sync/src/gitRunner.ts collects without a limit, and a remote's `remote:` lines are part of it.
// Before the bound, the scheme://user:pass@ rule rescanned the rest of the string from every word
// boundary (`[a-z0-9+.-]*` runs across `.`), and the PEM rule's lazy `[\s\S]*?` scanned to the end
// from every unclosed BEGIN line: both quadratic.

const KIB = 1024

/** Repeated PEM header lines with no END line. */
const pemHeaders = (size: number): string => '-----BEGIN PRIVATE KEY-----\n'.repeat(Math.ceil(size / 28)).slice(0, size)

/** 21-character alphanumeric runs (one short of a base64 run) joined by `.`. */
const dottedRuns = (size: number): string => {
  const run = 'aB3dE5gH7jK9mN1pQ3sT5'
  return `${run}.`.repeat(Math.ceil(size / 22)).slice(0, size)
}

/** The fastest of three calls, so one scheduling stall does not decide the ratio. */
function bestOf3(input: string): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    redactString(input)
    best = Math.min(best, performance.now() - t)
  }
  return best
}

describe('T-FX3-01: redactString cost does not grow with the input (M3)', () => {
  for (const [name, make] of [
    ['repeated PEM header lines', pemHeaders],
    ['21-character runs joined by dots', dottedRuns],
  ] as const) {
    it(`${name}: 1 MiB costs under forty times 64 KiB`, () => {
      const small = make(64 * KIB)
      const large = make(1024 * KIB)
      bestOf3(small) // warm the JIT so the small case is not charged for compilation
      const ratio = bestOf3(large) / Math.max(bestOf3(small), 0.05)
      expect(ratio, `1 MiB / 64 KiB cost ratio for ${name}`).toBeLessThan(40)
    }, 300_000)
  }
})

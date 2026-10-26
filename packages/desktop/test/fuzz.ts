// A small, deterministic property-test kit for the T-FUZZ suites (audit §6.4): a seeded PRNG, arbitrary
// JSON, the structural mutations an attacker editing a vault file has, and random bytes, plus the settings the
// fast-check properties next to them share (C11). Seed 0x51a7e and 2000 runs by default; the nightly soak sets
// SLATE_FUZZ_RUNS=200000 (and SLATE_FUZZ_SEED to vary it). A failure message carries the run and its seed, and
// fast-check's the shrunk counterexample, so it can become a fixed case.

const fromEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isSafeInteger(v) && v > 0 ? v : fallback
}

export const FUZZ_SEED = fromEnv('SLATE_FUZZ_SEED', 0x51a7e)
export const FUZZ_RUNS = fromEnv('SLATE_FUZZ_RUNS', 2000)

/** fast-check's parameters for every T-FUZZ property: deterministic in CI, the soak's run count at night. */
export const fcParams = { numRuns: FUZZ_RUNS, seed: FUZZ_SEED, endOnFailure: true } as const

/** A vitest timeout that grows with the run count, so the soak is not cut off at 5 s a test. */
export const fuzzTimeout = (msPer1000Runs = 5_000): number => Math.max(5_000, Math.ceil((FUZZ_RUNS / 1000) * msPer1000Runs))

/** mulberry32: a fast 32-bit generator, fully determined by the seed. */
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!
  }
  bool(): boolean {
    return this.next() < 0.5
  }
  bytes(max: number, min = 0): Uint8Array {
    const out = new Uint8Array(this.int(min, max))
    for (let i = 0; i < out.length; i++) out[i] = this.int(0, 255)
    return out
  }
  string(max = 12): string {
    const n = this.int(0, max)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.pick([this.int(0x20, 0x7e), this.int(0, 0x1f), this.int(0x80, 0xffff)]))
    return s
  }
}

/** Runs `prop` FUZZ_RUNS times with its own generator per run; the run index and seed are in any failure. */
export function forAll(name: string, prop: (rng: Rng, run: number) => void, runs = FUZZ_RUNS, seed = FUZZ_SEED): void {
  for (let run = 0; run < runs; run++) {
    const rng = new Rng(seed + run)
    try {
      prop(rng, run)
    } catch (e) {
      throw new Error(`${name}: run ${run} (seed ${seed}) failed: ${(e as Error).message}`, { cause: e })
    }
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** Arbitrary JSON up to `depth`, with the awkward values a hostile file holds. */
export function jsonValue(rng: Rng, depth = 6): Json {
  const leaf = (): Json =>
    rng.pick<() => Json>([
      () => null,
      () => rng.bool(),
      () => rng.int(-1000, 1000),
      () => rng.pick([-0, 2 ** 53, -1, 1e21, 0.5, Number.MAX_SAFE_INTEGER, -(2 ** 31)]),
      () => rng.string(),
      () => rng.pick(['', '\u0000', 'slate-vault', 'argon2id', 'pbkdf2-hmac-sha512', 'aes-256-gcm', 'fips-140-3', 'standard']),
    ])()
  if (depth <= 0 || rng.next() < 0.4) return leaf()
  if (rng.bool()) return Array.from({ length: rng.int(0, 4) }, () => jsonValue(rng, depth - 1))
  const o: { [k: string]: Json } = {}
  for (let i = rng.int(0, 5); i > 0; i--) o[rng.pick([rng.string(8), 'format', 'version', 'kdf', 'wraps', 'check', 'profile'])] = jsonValue(rng, depth - 1)
  return o
}

export type Mutation = { op: 'delete'; at: number } | { op: 'add'; key: string; value: Json } | { op: 'replace'; at: number; value: unknown }

/** One structural mutation of a JSON object: delete a key, add one, or replace a value (T-FUZZ-02). */
export function mutation(rng: Rng): Mutation {
  const special: unknown[] = [-0, 2 ** 53, -1, 1e21, 0.5, '', '\u0000', 'A'.repeat(70_000)]
  return rng.pick<() => Mutation>([
    () => ({ op: 'delete', at: rng.int(0, 1000) }),
    () => ({ op: 'add', key: rng.string(12), value: jsonValue(rng, 2) }),
    () => ({ op: 'replace', at: rng.int(0, 1000), value: rng.bool() ? jsonValue(rng, 2) : rng.pick(special) }),
  ])()
}

/** Applies `m` at the top level, or one level down when `deep` (kdf, wraps) so nested fields are hit too. */
export function apply(obj: Record<string, unknown>, m: Mutation, rng?: Rng): Record<string, unknown> {
  const out = structuredClone(obj)
  let target: Record<string, unknown> = out
  if (rng?.bool()) {
    const nested = Object.keys(out).filter((k) => typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k]))
    if (nested.length) target = out[rng.pick(nested)] as Record<string, unknown>
  }
  const keys = Object.keys(target)
  if (m.op === 'delete' && keys.length) delete target[keys[m.at % keys.length]!]
  if (m.op === 'add') target[m.key] = m.value
  if (m.op === 'replace' && keys.length) target[keys[m.at % keys.length]!] = m.value
  return out
}

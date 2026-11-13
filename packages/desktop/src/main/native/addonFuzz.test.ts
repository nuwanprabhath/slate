// T-F1B: the N-API boundary under generated values. Every function the real slate_native.node exports is
// called with wrong types, offset and shared views, detached and empty buffers, hostile handles and awkward
// strings. A call returns its documented type or throws an SCC_ error; the process survives, no handle
// leaks, and the module never enters its error state. Needs the built addon (`npm run -w @slate/native build`).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadNative, nativeErrorCode, type KeyHandle, type SlateNative } from '@slate/native'
import { fcParams, fuzzTimeout } from '../../../test/fuzz'
import { startCryptoModule } from './cryptoModule'

const target = `${process.platform}-${process.arch}`
const nativeDir = join(__dirname, '../../../../native')
const addonPath = join(nativeDir, 'prebuilds', target, 'slate_native.node')
const modulesDir = join(nativeDir, 'fips', target)
const moduleFile = process.platform === 'darwin' ? ('fips.dylib' as const) : ('fips.so' as const)
const tmp = mkdtempSync(join(tmpdir(), 'slate-addon-fuzz-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// A quarter of the run count, as T-FUZZ-08 divides: a call is a native round trip, not a pure function.
const RUNS = Math.max(300, Math.floor(fcParams.numRuns / 4))
const params = { ...fcParams, numRuns: RUNS }

type Fn = (...a: unknown[]) => unknown
type Kind = 'h' | 'b' | 'bn' | 's' | 'iter' | 'mem' | 'passes' | 'n' | 'badMs' | 'off' | 'level' | 'bool' | 'usage'
type Ret = 'handle' | 'bytes' | 'bytesOrNull' | 'bool' | 'num' | 'zero' | 'status' | 'asyncHandle'
interface Row {
  args: Kind[]
  ret: Ret
  /** A call that is known to succeed (every byte slot a plain Uint8Array), for the shared-view property. */
  good?: (r: Run) => unknown[]
}

// One-way or process-wide functions: calling them under generated values would change the process for the
// rest of the file (or end it), so they are not in the table. Each has its own test elsewhere.
const NOT_CALLABLE: Record<string, string> = {
  init: 'starts the module once; beforeAll did it',
  postGate: 'one-way: every service refuses until a self-test passes',
  postBegin: 'opens a self-test session; only vault/selftest/post.ts does',
  postEnd: 'closes it and, on false, enters the error state',
  enterErrorState: 'one-way: every service throws SCC_12 afterwards',
  requireApprovedKeys: 'one-way: refuses the legacy services for the process',
  hardenProcess: 'changes the process (non-dumpable, no core file)',
  zeroizeAll: 'destroys every key, including other tests in this process',
  sqlite: 'an object, covered by packages/native/test/sqliteBoundary.test.ts',
}

/** Per-run bookkeeping: every handle made or returned goes in `made` and is destroyed at the end. */
class Run {
  made: KeyHandle[] = []
  constructor(readonly native: SlateNative) {}
  key(usage: 'data' | 'master' | 'db' | 'kek'): KeyHandle {
    const h = this.native.keyRandom(usage)
    this.made.push(h)
    return h
  }
  bytes(n: number, fill = 7): Uint8Array {
    return new Uint8Array(n).fill(fill)
  }
  cleanup(): void {
    for (const h of this.made) {
      try {
        this.native.keyDestroy(h)
      } catch {
        // already destroyed by the call under test
      }
    }
    this.made = []
  }
}

const rows: Record<string, Row> = {
  status: { args: [], ret: 'status' },
  keyRandom: { args: ['usage'], ret: 'handle' },
  keyDestroy: { args: ['h'], ret: 'zero' },
  kbkdf: { args: ['h', 's', 'b', 'usage'], ret: 'handle', good: (r) => [r.key('master'), 'slate/fuzz', r.bytes(8)] },
  hkdfLegacy: { args: ['h', 'b', 's', 'usage'], ret: 'handle', good: (r) => [r.key('master'), r.bytes(8), 'slate/fuzz'] },
  pbkdf2: { args: ['b', 'b', 'iter'], ret: 'handle', good: (r) => [r.bytes(8), r.bytes(16), 1000] },
  pbkdf2Async: { args: ['b', 'b', 'iter'], ret: 'asyncHandle', good: (r) => [r.bytes(8), r.bytes(16), 1000] },
  argon2id: { args: ['b', 'b', 'mem', 'passes'], ret: 'handle', good: (r) => [r.bytes(8), r.bytes(16), 32, 1] },
  argon2idAsync: { args: ['b', 'b', 'mem', 'passes'], ret: 'asyncHandle', good: (r) => [r.bytes(8), r.bytes(16), 32, 1] },
  hkdfFromSecret: { args: ['b', 'b', 's'], ret: 'handle', good: (r) => [r.bytes(32), r.bytes(8), 'slate/fuzz'] },
  kbkdfFromSecret: { args: ['b', 's', 'b', 'bool'], ret: 'handle', good: (r) => [r.bytes(32), 'slate/fuzz', r.bytes(8), false] },
  pbkdf2Calibrate: { args: ['badMs'], ret: 'num' },
  nameSivEncode: { args: ['h', 'h', 'b'], ret: 'bytes', good: (r) => [r.key('data'), r.key('data'), r.bytes(16)] },
  nameSivDecode: { args: ['h', 'h', 'b'], ret: 'bytesOrNull' },
  recoveryDecode: { args: ['b'], ret: 'handle' },
  hkdfFromRecovery: { args: ['h', 'b', 's'], ret: 'handle' },
  kbkdfFromRecovery: { args: ['h', 's', 'b', 'bool'], ret: 'handle' },
  gcmSeal: { args: ['h', 'bn', 'b', 'b'], ret: 'bytes', good: (r) => [r.key('data'), null, r.bytes(4), r.bytes(20)] },
  gcmSealIvInAad: { args: ['h', 'b', 'off', 'b'], ret: 'bytes', good: (r) => [r.key('data'), r.bytes(32), 4, r.bytes(20)] },
  gcmOpen: { args: ['h', 'b', 'b', 'b'], ret: 'bytes' },
  gcmSealKey: { args: ['h', 'h', 'bn', 'b'], ret: 'bytes' },
  gcmOpenKey: { args: ['h', 'b', 'b', 'b', 'usage'], ret: 'handle' },
  rewrapKey: { args: ['h', 'b', 'b', 'b', 'h', 'b'], ret: 'bytes' },
  historySeal: { args: ['h', 'b', 'b', 'b', 'h', 'b', 'b'], ret: 'bytes' },
  historyRewrap: { args: ['h', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'h', 'b', 'b'], ret: 'bytes' },
  historyOpen: { args: ['h', 'b', 'b', 'b', 'b'], ret: 'handle' },
  hmacSha256: { args: ['h', 'b'], ret: 'bytes', good: (r) => [r.key('data'), r.bytes(20)] },
  aesEcbBlock: { args: ['h', 'b', 'bool'], ret: 'bytes' },
  aesCtr: { args: ['h', 'b', 'b'], ret: 'bytes', good: (r) => [r.key('data'), r.bytes(16), r.bytes(20)] },
  sha256: { args: ['b'], ret: 'bytes', good: (r) => [r.bytes(20)] },
  randomBytes: { args: ['n'], ret: 'bytes', good: () => [16] },
  mldsaVerify: { args: ['level', 'b', 'b', 'b', 'b'], ret: 'bool' },
}

// ---- generators. Specs are plain data, turned into live values inside the property, because the addon
// cleanses or detaches what it is given and a value must never be shared between runs. ----

type Spec = Record<string, unknown> & { k: string }
const sizes = fc.oneof(
  fc.constantFrom(0, 1, 12, 16, 20, 32, 48, 64, 65, 127, 128, 129),
  fc.nat(300),
)
const bytesSpec: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 12, arbitrary: fc.record({ k: fc.constant('u8'), len: sizes, off: fc.constant(0), fill: fc.nat(255) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('u8'), len: sizes, off: fc.integer({ min: 1, max: 9 }), fill: fc.nat(255) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('sab'), len: sizes, off: fc.nat(8) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('detached'), len: sizes }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constantFrom('u16', 'i8', 'u8c', 'f64', 'buffer', 'dataview', 'ab', 'sabRaw', 'array', 'string', 'null', 'undef', 'number', 'object'), len: sizes }) },
)
const strSpec: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ k: fc.constant('str'), len: fc.oneof(fc.constantFrom(0, 1, 126, 127, 128, 129, 130), fc.nat(300)), nulAt: fc.constantFrom(-1, -1, -1, 0, 3, 126, 127), wide: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('null', 'undef', 'number', 'u8', 'object'), len: fc.constant(4) }) },
)
const hostileNumbers: unknown[] = [NaN, -0, 0, -1, 1.5, Infinity, -Infinity, 2 ** 31, 2 ** 32, 2 ** 32 + 1, 2 ** 53, '1', '', null, undefined, true, {}, [1], 1n]
const rawNumber = fc.constantFrom(...hostileNumbers)
const handleSpec: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 10, arbitrary: fc.record({ k: fc.constant('live'), i: fc.nat(3) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('plus32'), i: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('dead') }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('raw'), v: rawNumber }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('raw'), v: fc.double({ noNaN: false }) }) },
)
// Costly draws stay bounded: a valid call is cheap; a costly value is always invalid and refused before work.
const numSpec = (valid: fc.Arbitrary<number>, invalid: fc.Arbitrary<unknown>): fc.Arbitrary<Spec> =>
  fc.oneof({ weight: 3, arbitrary: valid.map((v) => ({ k: 'raw', v })) }, { weight: 2, arbitrary: invalid.map((v) => ({ k: 'raw', v })) }, { weight: 1, arbitrary: rawNumber.map((v) => ({ k: 'raw', v })) })
const kindArb: Record<Kind, fc.Arbitrary<Spec>> = {
  h: handleSpec,
  b: bytesSpec,
  bn: bytesSpec,
  s: strSpec,
  iter: numSpec(fc.integer({ min: 1000, max: 1200 }), fc.constantFrom(0, 999, 10_000_001, 2 ** 32 + 1000, 1000.5, 2 ** 40)),
  // Valid memory is 32..64 KiB; the module's upper bound is 4 GiB of KiB, which is never drawn.
  mem: numSpec(fc.integer({ min: 32, max: 64 }), fc.constantFrom(0, 31, 2 ** 32 + 1, 32.5, 2 ** 40)),
  passes: numSpec(fc.constant(1), fc.constantFrom(0, 17, 1.5, 2 ** 32 + 1)),
  // randomBytes' upper bound is large; a valid draw is at most 4 KiB.
  n: numSpec(fc.integer({ min: 0, max: 4096 }), fc.constantFrom(-1, 1.5, 2 ** 32, 2 ** 40)),
  // pbkdf2Calibrate runs its KDF for `ms` milliseconds when valid: only refused values are drawn here.
  badMs: numSpec(fc.constantFrom(99, 10_001, 0, 100.5), fc.constantFrom(-1, 2 ** 32 + 100)),
  off: numSpec(fc.integer({ min: 0, max: 40 }), fc.constantFrom(-1, 2 ** 32, 1.5)),
  level: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(65, 87).map((v) => ({ k: 'raw', v })) }, { weight: 2, arbitrary: fc.constantFrom(0, 64, 66, 88, 65.5, 2 ** 32 + 65).map((v) => ({ k: 'raw', v })) }, { weight: 1, arbitrary: rawNumber.map((v) => ({ k: 'raw', v })) }),
  bool: fc.oneof(fc.constantFrom(true, false), rawNumber).map((v) => ({ k: 'raw', v })),
  usage: fc.oneof(fc.constantFrom('data', 'master', 'db', 'kek', undefined, null), fc.constantFrom('', 'DATA', 'password', 'dat\0a', 'x'.repeat(200)), rawNumber).map((v) => ({ k: 'raw', v })),
}

function bytesOf(s: Spec): unknown {
  const len = s.len as number
  const off = (s.off as number | undefined) ?? 0
  switch (s.k) {
    case 'u8':
      return new Uint8Array(new ArrayBuffer(off + len + 3), off, len).fill(s.fill as number)
    case 'sab':
      return new Uint8Array(new SharedArrayBuffer(off + len + 3), off, len)
    case 'sabRaw':
      return new SharedArrayBuffer(len)
    case 'detached': {
      const view = new Uint8Array(len)
      structuredClone(view.buffer, { transfer: [view.buffer] })
      return view
    }
    case 'u16':
      return new Uint16Array(len)
    case 'i8':
      return new Int8Array(len)
    case 'u8c':
      return new Uint8ClampedArray(len)
    case 'f64':
      return new Float64Array(len)
    case 'buffer':
      return Buffer.alloc(len)
    case 'dataview':
      return new DataView(new ArrayBuffer(len))
    case 'ab':
      return new ArrayBuffer(len)
    case 'array':
      return Array.from({ length: len }, () => 1)
    case 'string':
      return 'x'.repeat(len)
    case 'null':
      return null
    case 'undef':
      return undefined
    case 'number':
      return len
    default:
      return {}
  }
}

/** A string of exactly `len` UTF-8 bytes (a two-byte letter at the end when `wide`), with U+0000 at `nulAt`. */
function stringOf(s: Spec): unknown {
  if (s.k !== 'str') return bytesOf({ ...s, k: s.k })
  const len = s.len as number
  let str = len > 0 && s.wide ? 'a'.repeat(len - 1) + 'é'.slice(0, 0) : 'a'.repeat(len)
  if (s.wide && len >= 2) str = 'a'.repeat(len - 2) + 'é'
  const at = s.nulAt as number
  if (at >= 0 && at < str.length) str = str.slice(0, at) + '\0' + str.slice(at + 1)
  return str
}

function materialize(kind: Kind, s: Spec, run: Run, dead: KeyHandle, live: KeyHandle[]): unknown {
  switch (kind) {
    case 'h':
      if (s.k === 'live') return live[s.i as number]
      if (s.k === 'plus32') return 2 ** 32 + (live[s.i as number] as unknown as number)
      if (s.k === 'dead') return dead
      return s.v
    case 'b':
      return bytesOf(s)
    case 'bn':
      return bytesOf(s)
    case 's':
      return stringOf(s)
    default:
      void run
      return s.v
  }
}

function checkReturn(ret: Ret, value: unknown, run: Run): void {
  switch (ret) {
    case 'handle': {
      expect(typeof value).toBe('number')
      expect(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffffffff).toBe(true)
      run.made.push(value as KeyHandle)
      return
    }
    case 'bytes':
      expect(value).toBeInstanceOf(Uint8Array)
      return
    case 'bytesOrNull':
      expect(value === null || value instanceof Uint8Array).toBe(true)
      return
    case 'bool':
      expect(typeof value).toBe('boolean')
      return
    case 'num':
      expect(typeof value).toBe('number')
      return
    case 'zero':
      expect(value).toBe(0)
      return
    case 'status':
      expect(typeof (value as { liveHandles: unknown }).liveHandles).toBe('number')
      return
    case 'asyncHandle':
      return
  }
}

/** Calls `name` and returns `'ok'` or the SCC code it threw; anything else fails the test. */
async function callChecked(native: SlateNative, name: string, args: unknown[], run: Run): Promise<string> {
  const row = rows[name]!
  const fn = (native as unknown as Record<string, Fn>)[name]!
  try {
    let value = fn.apply(native, args)
    if (row.ret === 'asyncHandle') {
      expect(value).toBeInstanceOf(Promise)
      value = await (value as Promise<unknown>)
      checkReturn('handle', value, run)
    } else checkReturn(row.ret, value, run)
    return 'ok'
  } catch (e) {
    const code = nativeErrorCode(e)
    if (code === null) throw new Error(`${name}(${args.length} args) threw a non-SCC error: ${String(e)}`, { cause: e })
    return code
  }
}

describe('T-F1B: the N-API boundary under generated values', () => {
  let native: SlateNative
  let startLive: number

  beforeAll(() => {
    const started = startCryptoModule({
      load: () => loadNative(addonPath),
      requireFips: true,
      modulesDir,
      configFile: join(tmp, 'user', 'fips', 'openssl-fips.cnf'),
      moduleFile,
    })
    if (!started.native) throw new Error(`the addon did not start: ${String(started.status.problem)}`)
    native = started.native
    startLive = native.status().liveHandles
  })

  const settled = (): void => {
    const s = native.status()
    expect(s.errorState).toBe(false)
    expect(s.liveHandles).toBe(startLive)
  }

  it('T-F1B-01: the table has one row for every export, and every other export says why it is not called', () => {
    // The addon registers its functions non-enumerable, so Object.keys would see only `sqlite`.
    const exported = Object.getOwnPropertyNames(native).sort()
    expect([...Object.keys(rows), ...Object.keys(NOT_CALLABLE)].sort()).toEqual(exported)
    for (const why of Object.values(NOT_CALLABLE)) expect(why.length).toBeGreaterThan(10)
    expect(Object.keys(rows).filter((k) => typeof (native as unknown as Record<string, unknown>)[k] !== 'function')).toEqual([])
  })

  it(
    'T-F1B-02: any export, called with generated values, returns its documented type or throws an SCC_ code, and leaks no handle',
    async () => {
      const names = Object.keys(rows)
      const arb = fc.constantFrom(...names).chain((name) => {
        const kinds = rows[name]!.args
        return fc.tuple(fc.constant(name), fc.tuple(...kinds.map((k) => kindArb[k])), fc.nat(kinds.length + 1), fc.constantFrom(0, 0, 0, 1, 1, 2))
      })
      await fc.assert(
        fc.asyncProperty(arb, async ([name, specs, drop, extra]) => {
          const run = new Run(native)
          try {
            const live = [run.key('kek'), run.key('master'), run.key('data'), run.key('db')]
            const dead = run.key('data')
            native.keyDestroy(dead)
            const kinds = rows[name]!.args
            let args = specs.map((s, i) => materialize(kinds[i]!, s, run, dead, live))
            // Mostly the full argument list; sometimes fewer (argc is checked), sometimes more (ignored).
            if (drop % 7 === 0) args = args.slice(0, Math.max(0, args.length - 1 - (drop % (kinds.length + 1))))
            for (let i = 0; i < extra; i++) args.push(i === 0 ? 1 : new Uint8Array(1))
            await callChecked(native, name, args, run)
          } finally {
            run.cleanup()
          }
          settled()
        }),
        params,
      )
    },
    fuzzTimeout(),
  )

  it(
    'T-F1B-03: a view over a SharedArrayBuffer is refused in every byte slot of every call that otherwise succeeds',
    async () => {
      const goodRows = Object.entries(rows).filter(([, r]) => r.good && r.args.some((k) => k === 'b' || k === 'bn'))
      expect(goodRows.length).toBeGreaterThanOrEqual(14)
      const arb = fc.tuple(fc.nat(goodRows.length - 1), fc.nat(10), fc.constantFrom(0, 1, 8, 20, 32, 64), fc.nat(8))
      await fc.assert(
        fc.asyncProperty(arb, async ([which, slotPick, len, off]) => {
          const [name, row] = goodRows[which]!
          // Control: the same call with plain buffers succeeds, so a refusal below is the view's doing.
          const control = new Run(native)
          try {
            expect(await callChecked(native, name, row.good!(control), control)).toBe('ok')
          } finally {
            control.cleanup()
          }
          const run = new Run(native)
          try {
            const args = row.good!(run)
            const slots = args.flatMap((a, i) => (a instanceof Uint8Array ? [i] : []))
            const slot = slots[slotPick % slots.length]!
            const size = (args[slot] as Uint8Array).length
            // A shared view of the length the slot needs, and of arbitrary lengths and offsets.
            const shared = len === 0 || slotPick % 2 === 0 ? size : len
            args[slot] = new Uint8Array(new SharedArrayBuffer(off + shared + 1), off, shared)
            const code = await callChecked(native, name, args, run)
            expect(code, `${name} slot ${slot} accepted a SharedArrayBuffer view`).toMatch(/^SCC_/)
          } finally {
            run.cleanup()
          }
          settled()
        }),
        params,
      )
    },
    fuzzTimeout(),
  )

  it('T-F1B-04 (review N1): offset views are read from their offset, and detached or shared buffers are refused', () => {
    const run = new Run(native)
    try {
      const whole = new Uint8Array([9, 9, 9, 1, 2, 3, 9])
      const view = whole.subarray(3, 6)
      expect(Array.from(native.sha256(view))).toEqual(Array.from(native.sha256(new Uint8Array([1, 2, 3]))))
      const shared = new Uint8Array(new SharedArrayBuffer(8))
      expect(() => native.sha256(shared)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
      const ab = new Uint8Array(8)
      structuredClone(ab.buffer, { transfer: [ab.buffer] })
      expect(ab.length).toBe(0)
      // A zero-length view is a valid empty input, not an error.
      expect(native.sha256(ab)).toBeInstanceOf(Uint8Array)
      expect(() => native.sha256(new Uint16Array(4) as unknown as Uint8Array)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
      expect(() => native.sha256(new ArrayBuffer(4) as unknown as Uint8Array)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
      expect(() => native.sha256(Buffer.alloc(4) as unknown as Uint8Array)).not.toThrow()
    } finally {
      run.cleanup()
    }
    settled()
  })

  it('T-F1B-05 (review N2): a handle is exactly an integer in [1, 2^32 - 1]; 2^32 + h, 1.5, NaN and -0 never reach key h', () => {
    const run = new Run(native)
    try {
      const h = run.key('data')
      const data = new Uint8Array(4)
      expect(native.hmacSha256(h, data)).toBeInstanceOf(Uint8Array)
      const hn = h as unknown as number
      for (const bad of [2 ** 32 + hn, hn + 0.5, 1.5, NaN, -0, 0, -1, Infinity, String(hn), null, undefined, 2 ** 53 + hn]) {
        expect(() => native.hmacSha256(bad as unknown as KeyHandle, data)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
        expect(() => native.keyDestroy(bad as unknown as KeyHandle)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
      }
      // None of those destroyed key h.
      expect(native.hmacSha256(h, data)).toBeInstanceOf(Uint8Array)
      native.keyDestroy(h)
      expect(() => native.hmacSha256(h, data)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
      expect(() => native.keyDestroy(h)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SCC_/) }))
    } finally {
      run.cleanup()
    }
    settled()
  })

  it('T-F1B-06 (review L1): a label is read whole: up to 128 bytes (SCC_MAX_LABEL), refused at 129, and with an embedded U+0000', () => {
    const run = new Run(native)
    // Whatever the call returns is tracked, so a wrongly accepted label cannot leak a handle into the next test.
    const derive = (label: string, via: 'kbkdf' | 'hkdf'): string => {
      try {
        run.made.push(via === 'kbkdf' ? native.kbkdf(run.made[0]!, label, new Uint8Array(4)) : native.hkdfLegacy(run.made[0]!, new Uint8Array(4), label))
        return 'ok'
      } catch (e) {
        return nativeErrorCode(e) ?? 'not-scc'
      }
    }
    try {
      run.key('master')
      const bytes = (s: string): number => new TextEncoder().encode(s).length
      const label = (n: number): string => 'a'.repeat(n)
      const accepted = [label(1), label(127), label(128), 'é'.repeat(64), 'é'.repeat(63) + 'a']
      const refused = [label(129), label(300), 'é'.repeat(64) + 'a', 'ab\0cd', '\0', label(10) + '\0', label(127) + '\0']
      expect(accepted.map(bytes).every((n) => n <= 128)).toBe(true)
      expect(refused.every((l) => bytes(l) > 128 || l.includes('\0'))).toBe(true)
      for (const via of ['kbkdf', 'hkdf'] as const) {
        expect(accepted.map((l) => derive(l, via))).toEqual(accepted.map(() => 'ok'))
        for (const l of refused) expect(derive(l, via), `${via} ${bytes(l)} bytes`).toMatch(/^SCC_/)
      }
      // A label cut short would give the 128-byte label the same key as its 127-byte prefix.
      const k1 = native.kbkdf(run.made[0]!, label(127), new Uint8Array(4))
      const k2 = native.kbkdf(run.made[0]!, label(128), new Uint8Array(4))
      run.made.push(k1, k2)
      expect(k1).not.toBe(k2)
    } finally {
      run.cleanup()
    }
    settled()
  })

  it('T-F1B-07 (review L2): a count is an integer in range; NaN, Infinity, fractions and 2^32 + n are refused before any work', async () => {
    const pw = (): Uint8Array => new Uint8Array(8).fill(1)
    const salt = (): Uint8Array => new Uint8Array(16).fill(2)
    const refuse = expect.objectContaining({ code: expect.stringMatching(/^SCC_/) })
    for (const iters of [999, 1000.5, NaN, Infinity, -Infinity, 2 ** 32 + 1000, 10_000_001, -0, '1000' as unknown as number]) {
      expect(() => native.pbkdf2(pw(), salt(), iters)).toThrow(refuse)
      await expect(native.pbkdf2Async(pw(), salt(), iters)).rejects.toEqual(refuse)
    }
    for (const mem of [31, 32.5, NaN, Infinity, 2 ** 32 + 32, -0]) expect(() => native.argon2id(pw(), salt(), mem, 1)).toThrow(refuse)
    for (const passes of [0, 17, 1.5, NaN, Infinity, 2 ** 32 + 1]) expect(() => native.argon2id(pw(), salt(), 32, passes)).toThrow(refuse)
    for (const ms of [99, 10_001, NaN, 100.5, Infinity, 2 ** 32 + 100]) expect(() => native.pbkdf2Calibrate(ms)).toThrow(refuse)
    for (const n of [-1, 1.5, NaN, Infinity, 2 ** 32]) expect(() => native.randomBytes(n)).toThrow(refuse)
    // A valid call right after the refusals still works: nothing is left half-done.
    const run = new Run(native)
    try {
      run.made.push(native.pbkdf2(pw(), salt(), 1000))
      run.made.push(await native.pbkdf2Async(pw(), salt(), 1000))
      run.made.push(native.argon2id(pw(), salt(), 32, 1))
    } finally {
      run.cleanup()
    }
    settled()
  })

  it('T-F1B-08 (FX-28): a flag is exactly true or false; null, numbers, strings and objects are refused with SCC_1 in every boolean slot', () => {
    const run = new Run(native)
    const refuse = expect.objectContaining({ code: 'SCC_1' })
    try {
      const key = run.key('data')
      const block = run.bytes(16, 248)
      // The soak's counterexample (seed 1, 200000 runs): null where aesEcbBlock reads its direction.
      expect(() => native.aesEcbBlock(key, run.bytes(16, 248), null as unknown as boolean)).toThrow(refuse)
      // Truthy and falsy values alike: nothing is coerced into a direction or an approved flag.
      const notBooleans = [...hostileNumbers.filter((v) => typeof v !== 'boolean'), 'true', 'false', Object(true), new Uint8Array(1)]
      expect(notBooleans.length).toBeGreaterThanOrEqual(22)
      for (const bad of notBooleans) {
        const flag = bad as boolean
        expect(() => native.aesEcbBlock(key, run.bytes(16, 248), flag), `aesEcbBlock ${String(bad)}`).toThrow(refuse)
        // The secret is cleansed by the call, so each call gets its own.
        expect(() => native.kbkdfFromSecret(run.bytes(32), 'slate/fuzz', run.bytes(8), flag), `kbkdfFromSecret ${String(bad)}`).toThrow(refuse)
        expect(() => native.kbkdfFromRecovery(key, 'slate/fuzz', run.bytes(8), flag), `kbkdfFromRecovery ${String(bad)}`).toThrow(refuse)
        // init reads its arguments before it looks at the module, so a refused flag never restarts it.
        expect(() => native.init(join(tmp, 'none.cnf'), tmp, flag), `init ${String(bad)}`).toThrow(refuse)
      }
      // A real flag still picks the direction: the refusals changed nothing for a valid call.
      const sealed = native.aesEcbBlock(key, block, true)
      expect(Array.from(sealed)).not.toEqual(Array.from(block))
      expect(Array.from(native.aesEcbBlock(key, sealed, false))).toEqual(Array.from(block))
    } finally {
      run.cleanup()
    }
    settled()
  })
})

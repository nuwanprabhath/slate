import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { argon2id } from 'hash-wasm'
import { passwordKeyMatches, samePasswordKey } from '../../../test/vaultKeys'
import { calibrateKdf, calibratePbkdf2, defaultKdf, deriveKek, validateKdf, type Argon2idParams as KdfParams, type Pbkdf2Params } from './kdf'
import { destroyKey, vaultNative } from './native'
import { secretBytes } from '../../shared/secret'

const salt16 = Buffer.alloc(16, 7).toString('base64')
const kdf = (over: Partial<KdfParams> = {}): KdfParams => ({
  alg: 'argon2id',
  memoryKiB: 65536,
  passes: 2,
  parallelism: 1,
  salt: salt16,
  ...over,
})
const weakKdf = (over: Partial<KdfParams> = {}): KdfParams => kdf({ memoryKiB: 64, passes: 1, ...over })

describe('validateKdf', () => {
  it('accepts the floor and the default', () => {
    expect(() => validateKdf(kdf())).not.toThrow()
    expect(() => validateKdf(defaultKdf())).not.toThrow()
  })
  it.each<[string, Partial<KdfParams>]>([
    ['memory below floor', { memoryKiB: 65535 }],
    ['memory above ceiling', { memoryKiB: 1024 * 1024 + 1 }],
    ['passes below floor', { passes: 1 }],
    ['passes above ceiling', { passes: 11 }],
    ['parallelism 2', { parallelism: 2 }],
    ['short salt', { salt: Buffer.alloc(15).toString('base64') }],
    ['long salt', { salt: Buffer.alloc(65).toString('base64') }],
    ['non-canonical salt', { salt: salt16.replace(/=+$/, '') + '!' }],
    ['float memory', { memoryKiB: 65536.5 }],
    ['other alg', { alg: 'argon2i' as 'argon2id' }],
  ])('refuses %s', (_, over) => {
    expect(() => validateKdf(kdf(over))).toThrow()
  })
  it('refuses tiny test parameters unless explicitly allowed, and ceilings always', () => {
    expect(() => validateKdf(weakKdf())).toThrow()
    expect(() => validateKdf(weakKdf(), { allowWeakForTests: true })).not.toThrow()
    expect(() => validateKdf(weakKdf({ passes: 11 }), { allowWeakForTests: true })).toThrow()
    expect(() => validateKdf(weakKdf({ parallelism: 2 }), { allowWeakForTests: true })).toThrow()
  })
  it('defaultKdf is 256 MiB x 4 with a fresh salt', () => {
    const a = defaultKdf()
    expect(a).toMatchObject({ alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1 })
    expect(Buffer.from(a.salt, 'base64')).toHaveLength(16)
    expect(defaultKdf().salt).not.toBe(a.salt)
  })
})

describe('deriveKek', () => {
  it('refuses weak parameters without the test flag', async () => {
    await expect(deriveKek(secretBytes('pw'), weakKdf())).rejects.toThrow()
  })
  it('C7: takes the password as bytes and leaves them to their owner (the module wipes its own copy)', async () => {
    const pw = secretBytes('correct horse battery')
    const copy = Array.from(pw)
    const kek = await deriveKek(pw, weakKdf(), { allowWeakForTests: true })
    expect(Array.from(pw)).toEqual(copy)
    expect(samePasswordKey(await deriveKek(pw, weakKdf(), { allowWeakForTests: true }), kek)).toBe(true)
  })
  it('is deterministic, NFC-normalised and salt-dependent', async () => {
    const o = { allowWeakForTests: true }
    const a = await deriveKek(secretBytes('caf\u00e9'), weakKdf(), o)
    expect(typeof a).toBe('number')
    expect(samePasswordKey(await deriveKek(secretBytes('caf\u00e9'), weakKdf(), o), a)).toBe(true)
    // NFD (e + combining acute) is the same password once normalised.
    expect(samePasswordKey(await deriveKek(secretBytes('cafe\u0301'), weakKdf(), o), a)).toBe(true)
    const other = weakKdf({ salt: Buffer.alloc(16, 8).toString('base64') })
    expect(samePasswordKey(await deriveKek(secretBytes('caf\u00e9'), other, o), a)).toBe(false)
  })
  // Reference vector from the Argon2 reference implementation's src/test.c (phc-winner-argon2,
  // version 0x13): argon2id t=2 m=2^16 p=1, "password"/"somesalt", 32-byte output. This is also the
  // one real-cost derivation, proving the module derives at the 64 MiB floor off the main thread.
  it('matches the reference argon2id vector at 64 MiB in the module', async () => {
    // The vector's salt is 8 bytes, under our 16-byte floor; memory and passes are real.
    const params = kdf({ salt: Buffer.from('somesalt').toString('base64') })
    const out = await deriveKek(secretBytes('password'), params, { allowWeakForTests: true })
    expect(passwordKeyMatches(out, Buffer.from('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7', 'hex'))).toBe(true)
    destroyKey(out)
  }, 30_000)
})

// Audit C4 criterion 5 and T-KAT-02: the module's Argon2id equals hash-wasm (kept as a devDependency for
// exactly this) on the POST vector and at the default parameters.
describe('T-KAT-02: native Argon2id equals hash-wasm', () => {
  const viaHashWasm = async (password: string, salt: Uint8Array, memoryKiB: number, passes: number) =>
    argon2id({ password, salt, iterations: passes, memorySize: memoryKiB, parallelism: 1, hashLength: 32, outputType: 'binary' })

  it('on the POST vector (slate-kat-password, salt 0x5a x 16, 32 KiB, t = 3)', async () => {
    const salt = new Uint8Array(16).fill(0x5a)
    const want = await viaHashWasm('slate-kat-password', salt, 32, 3)
    expect(Buffer.from(want).toString('hex')).toBe('688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812')
    const got = await vaultNative().argon2idAsync(new TextEncoder().encode('slate-kat-password'), salt, 32, 3)
    expect(passwordKeyMatches(got, want)).toBe(true)
    destroyKey(got)
  })

  it('at the default parameters (256 MiB, t = 4), through deriveKek', async () => {
    const params = defaultKdf()
    expect(params).toMatchObject({ memoryKiB: 262144, passes: 4 })
    const want = await viaHashWasm('correct horse battery', Buffer.from(params.salt, 'base64'), params.memoryKiB, params.passes)
    const got = await deriveKek(secretBytes('correct horse battery'), params)
    expect(passwordKeyMatches(got, want)).toBe(true)
    destroyKey(got)
  }, 120_000)
})

describe('calibrateKdf', () => {
  it('keeps the default when fast, lowers memory but stays above the floors when slow', async () => {
    expect(await calibrateKdf(async () => 900)).toMatchObject({ memoryKiB: 262144, passes: 4 })
    const slow = await calibrateKdf(async () => 4000)
    expect(() => validateKdf(slow)).not.toThrow()
    expect(slow.memoryKiB).toBeLessThan(262144)
  })
})

describe('allowWeakForTests', () => {
  it('is never passed by production code', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(p, 'utf8')
          // The declaration and pass-through sites read `opts`; only a literal `true` would weaken it.
          if (/allowWeakForTests\s*:\s*true/.test(src)) offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '..'))
    expect(offenders).toEqual([])
  })
})

describe('PBKDF2-HMAC-SHA-512, the fips-140-3 password KDF (audit §4.1, SP 800-132)', () => {
  const salt32 = Buffer.alloc(32, 0x5a).toString('base64')
  const pb = (over: Partial<Pbkdf2Params> = {}): Pbkdf2Params => ({ alg: 'pbkdf2-hmac-sha512', iterations: 600_000, salt: salt32, ...over })

  it('Appendix A: KEK_pw is PBKDF2-HMAC-SHA-512("slate-kat-password", 5a x 32, 1000, 32)', async () => {
    const kek = await deriveKek(secretBytes('slate-kat-password'), pb({ iterations: 1000 }), { allowWeakForTests: true })
    expect(passwordKeyMatches(kek, Buffer.from('13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079', 'hex'))).toBe(true)
    destroyKey(kek)
  })

  it('T-FUZZ-03 (v2): accepted iff 600,000 <= c <= 10,000,000, for every integer tried across the safe range', () => {
    const tries = [-(2 ** 53) + 1, -1, 0, 1, 999, 1000, 599_999, 600_000, 600_001, 9_999_999, 10_000_000, 10_000_001, 2 ** 31, 2 ** 53 - 1]
    let x = 0x51a7e
    for (let i = 0; i < 2000; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0
      tries.push(x % 20_000_001)
    }
    for (const c of tries) {
      const ok = c >= 600_000 && c <= 10_000_000
      const run = () => validateKdf(pb({ iterations: c }))
      expect(ok ? run : () => expect(run).toThrow(), String(c)).not.toThrow()
    }
  })

  it('refuses a short, long or non-canonical salt and a fractional count; the test floor is 1000', () => {
    for (const salt of [Buffer.alloc(15).toString('base64'), Buffer.alloc(65).toString('base64'), salt32.slice(0, -1) + '!']) expect(() => validateKdf(pb({ salt }))).toThrow()
    expect(() => validateKdf(pb({ iterations: 600_000.5 }))).toThrow()
    expect(() => validateKdf(pb({ iterations: 1000 }), { allowWeakForTests: true })).not.toThrow()
    expect(() => validateKdf(pb({ iterations: 999 }), { allowWeakForTests: true })).toThrow()
  })

  it('calibratePbkdf2: the module times about a second, within the range, with a fresh 32-byte salt', () => {
    const a = calibratePbkdf2()
    const b = calibratePbkdf2()
    expect(() => validateKdf(a)).not.toThrow()
    expect(Buffer.from(a.salt, 'base64')).toHaveLength(32)
    expect(a.salt).not.toBe(b.salt)
  })
})

describe('review C5 L1: PBKDF2 runs off the main thread', () => {
  it('deriveKek for pbkdf2 yields to the event loop while it derives (a timer fires), and gives the same key', async () => {
    const kdf: Pbkdf2Params = { alg: 'pbkdf2-hmac-sha512', iterations: 1_000_000, salt: Buffer.alloc(32, 0x5a).toString('base64') }
    let ticked = false
    setTimeout(() => (ticked = true), 0)
    const kek = await deriveKek(secretBytes('slate-kat-password'), kdf)
    expect(ticked).toBe(true)
    const again = await deriveKek(secretBytes('slate-kat-password'), kdf)
    expect(samePasswordKey(kek, again)).toBe(true)
    destroyKey(kek)
    destroyKey(again)
  })

  it('a count above the ceiling from an unverified header is refused before any derivation starts', async () => {
    const kdf: Pbkdf2Params = { alg: 'pbkdf2-hmac-sha512', iterations: 10_000_001, salt: Buffer.alloc(32, 1).toString('base64') }
    await expect(deriveKek(secretBytes('x'), kdf)).rejects.toThrow('Key derivation parameters are too large')
  })
})

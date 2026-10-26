// The real slate_native.node under ELECTRON_RUN_AS_NODE (audit C2 verification list): the round
// trip through the secure heap, and T-POST-06 (a tampered provider or module-mac refuses to start).
// Skipped when the addon has not been built (`npm run -w @slate/native build`); CI's native job builds it.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isApprovedKey, loadNative, nativeErrorCode, type KeyHandle, type SlateNative } from '@slate/native'
import { roundTrip, startCryptoModule } from './cryptoModule'
import { fipsConfigText } from './fipsConfig'

const target = `${process.platform}-${process.arch}`
const nativeDir = join(__dirname, '../../../../native')
const addonPath = join(nativeDir, 'prebuilds', target, 'slate_native.node')
const modulesDir = join(nativeDir, 'fips', target)
const moduleFile = process.platform === 'darwin' ? ('fips.dylib' as const) : ('fips.so' as const)
const haveAddon = existsSync(addonPath)
const haveProvider = existsSync(join(modulesDir, moduleFile))
const haveCc = (() => {
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const tmp = mkdtempSync(join(tmpdir(), 'slate-native-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// Needs the built addon (npm run -w @slate/native build:addon); a checkout without OpenSSL skips it.
describe.skipIf(!haveAddon)('slate_native.node in the main process', () => {
  let native: SlateNative

  it('loads under ELECTRON_RUN_AS_NODE, starts the module and round-trips gcmSealKey/gcmOpenKey', () => {
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(process.versions.electron).toBeTruthy()
    const started = startCryptoModule({
      load: () => loadNative(addonPath),
      requireFips: haveProvider,
      modulesDir,
      configFile: join(tmp, 'user', 'fips', 'openssl-fips.cnf'),
      moduleFile,
    })
    expect(started.status).toMatchObject({ available: true, problem: null, errorState: false, approvedMode: haveProvider })
    if (haveProvider) expect(started.status.version).toBe('3.1.2')
    expect(started.status.libcrypto).toMatch(/^OpenSSL 3\.5\./)
    native = started.native!
    // Criterion 3: the note-data context holds fips + base only (dev builds: default only, no claim).
    expect(native.status().defaultContextProviders.split(',').sort()).toEqual(haveProvider ? ['base', 'fips'] : ['default'])

    const aad = new TextEncoder().encode('header')
    const kek = native.hkdfFromSecret(native.randomBytes(32), new Uint8Array(0), 'slate/test/round-trip')
    const key = native.keyRandom('master')
    const wrapped = native.gcmSealKey(kek, key, null, aad)
    expect(wrapped).toBeInstanceOf(Uint8Array)
    expect(wrapped.length).toBe(12 + 32 + 16)
    const back = native.gcmOpenKey(kek, wrapped.subarray(0, 12), aad, wrapped.subarray(12))
    expect(back).not.toBe(key)
    // Both handles hold the same master key: a subkey of one opens what a subkey of the other sealed.
    const [a, b] = [native.hkdfLegacy(key, new Uint8Array(0), 'slate/test/probe'), native.hkdfLegacy(back, new Uint8Array(0), 'slate/test/probe')]
    const pt = new TextEncoder().encode('slate round trip')
    const sealed = native.gcmSeal(b, null, aad, pt)
    expect(Array.from(native.gcmOpen(a, sealed.subarray(0, 12), aad, sealed.subarray(12)))).toEqual(Array.from(pt))
    for (const h of [kek, key, back, a, b]) native.keyDestroy(h)
    expect(native.status().liveHandles).toBe(0)
    expect(roundTrip(native)).toBe(true)
  })

  it('refuses a tampered wrapped key with SCC_11 and leaks no handle', () => {
    const aad = new Uint8Array(0)
    const kek = native.keyRandom('kek')
    const key = native.keyRandom('db')
    const wrapped = native.gcmSealKey(kek, key, null, aad)
    wrapped[20]! ^= 1
    const live = native.status().liveHandles
    let code: string | null = null
    try {
      native.gcmOpenKey(kek, wrapped.subarray(0, 12), aad, wrapped.subarray(12))
    } catch (e) {
      code = nativeErrorCode(e)
    }
    expect(code).toBe('SCC_11')
    expect(native.status().liveHandles).toBe(live)
    native.keyDestroy(kek)
    native.keyDestroy(key)
  })

  it('H1: an input over the 256 MiB cap is refused with SCC_14, never authenticated as len mod 2^32', () => {
    const k = native.keyRandom()
    const aad = new TextEncoder().encode('hdr')
    const sealed = native.gcmSeal(k, null, aad, new TextEncoder().encode('hello'))
    const iv = sealed.subarray(0, 12)
    // The review's forgery: ct || 2^32 attacker bytes || tag. V8's sandbox may refuse a 4 GiB buffer;
    // then one byte over the cap stands in (the old code answered SCC_11 or accepted it).
    let forged: Uint8Array
    try {
      forged = new Uint8Array(5 + 2 ** 32 + 16)
    } catch {
      forged = new Uint8Array(5 + 256 * 2 ** 20 + 16)
    }
    forged.set(sealed.subarray(12, 17), 0)
    forged.set(sealed.subarray(17), forged.length - 16)
    expect(() => native.gcmOpen(k, iv, aad, forged)).toThrow(expect.objectContaining({ code: 'SCC_14' }))
    expect(() => native.gcmSeal(k, null, aad, new Uint8Array(256 * 2 ** 20 + 1))).toThrow(expect.objectContaining({ code: 'SCC_14' }))
    native.keyDestroy(k)
  })

  it('M3: the production binding cannot import raw key bytes, and refuses to wrap a key with itself', () => {
    expect('keyImport' in native).toBe(false)
    const k = native.keyRandom()
    expect(() => native.gcmSealKey(k, k, null, new Uint8Array(0))).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    native.keyDestroy(k)
  })

  it('L1: a KDF label or info with a NUL, or longer than 128 bytes, is refused instead of truncated', () => {
    const k = native.keyRandom()
    const ctx = new Uint8Array(16)
    const plain = native.kbkdf(k, 'slate/enc', ctx)
    expect(() => native.kbkdf(k, 'slate/enc\u0000other', ctx)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.kbkdf(k, 'x'.repeat(129), ctx)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.kbkdf(k, '', ctx)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.hkdfLegacy(k, new Uint8Array(0), 'slate/v1/sync\u0000x')).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.hkdfLegacy(k, new Uint8Array(0), 'y'.repeat(129))).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    // Exactly 128 bytes is fine, and distinct labels derive distinct keys.
    const a = native.kbkdf(k, 'a'.repeat(127) + 'b', ctx)
    const b = native.kbkdf(k, 'a'.repeat(127) + 'c', ctx)
    const probe = new Uint8Array(32)
    expect(Array.from(native.hmacSha256(a, probe))).not.toEqual(Array.from(native.hmacSha256(b, probe)))
    for (const h of [k, plain, a, b]) native.keyDestroy(h)
  })

  it('L2: KDF costs must be integers within bounds; NaN, negative, fractional, huge or Infinity fail fast with SCC_1', () => {
    const salt = new Uint8Array(32).fill(0x5a)
    const pw = () => new TextEncoder().encode('slate-kat-password')
    for (const iter of [Number.NaN, -1, 1.5, 999, 10_000_001, 1e12, Number.POSITIVE_INFINITY, '1000' as unknown as number]) {
      const started = Date.now()
      expect(() => native.pbkdf2(pw(), salt, iter), String(iter)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
      expect(Date.now() - started).toBeLessThan(1000)
    }
    for (const [mem, passes] of [[2 ** 32 - 1, 3], [16, 3], [32, 0], [32, 1000], [32.5, 3], [Number.NaN, 3]] as const) {
      expect(() => native.argon2id(pw(), salt.subarray(0, 16), mem, passes), `${mem}/${passes}`).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    }
    native.keyDestroy(native.pbkdf2(pw(), salt, 1000))
  })

  it('L3: the password is wiped on every error path, whichever later argument is wrong', () => {
    const salt = new Uint8Array(32).fill(0x5a)
    const calls: Array<(pw: Uint8Array) => unknown> = [
      (pw) => native.pbkdf2(pw, 'notbytes' as unknown as Uint8Array, 1000),
      (pw) => native.pbkdf2(pw, salt, 'x' as unknown as number),
      (pw) => (native.pbkdf2 as unknown as (p: Uint8Array) => unknown)(pw),
      (pw) => native.argon2id(pw, 'notbytes' as unknown as Uint8Array, 32, 3),
      (pw) => native.argon2id(pw, salt.subarray(0, 16), 'x' as unknown as number, 1),
      (pw) => native.argon2id(pw, salt.subarray(0, 16), 32, 'y' as unknown as number),
      (pw) => (native.argon2id as unknown as (p: Uint8Array, s: Uint8Array) => unknown)(pw, salt.subarray(0, 16)),
    ]
    for (const [i, call] of calls.entries()) {
      // Off the V8 heap (> 64 bytes), so the wipe reaches the array the caller holds.
      const pw = new Uint8Array(96).fill(0x41)
      expect(() => call(pw), String(i)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
      expect(pw.every((b) => b === 0), `call ${i} left the password in memory`).toBe(true)
    }
  })

  it('re-review note: a password in a SharedArrayBuffer is refused and still wiped', () => {
    const salt = new Uint8Array(32).fill(0x5a)
    for (const call of [(pw: Uint8Array) => native.pbkdf2(pw, salt, 1000), (pw: Uint8Array) => native.argon2id(pw, salt.subarray(0, 16), 32, 1)]) {
      const pw = new Uint8Array(new SharedArrayBuffer(96)).fill(0x41)
      expect(() => call(pw)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
      expect(pw.every((b) => b === 0)).toBe(true)
    }
  })

  it('notes N1/N2: SharedArrayBuffer views and handles that are not exact uint32 values are refused', () => {
    const k = native.keyRandom()
    const sab = new Uint8Array(new SharedArrayBuffer(16))
    expect(() => native.sha256(sab)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.hmacSha256(k, sab)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    for (const bad of [k + 2 ** 32, -1, 1.5, Number.NaN, 0, '1']) {
      expect(() => native.hmacSha256(bad as unknown as KeyHandle, new Uint8Array(1)), String(bad)).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    }
    native.keyDestroy(k)
  })

  it('note N3: a second environment (a worker thread) cannot load the addon', async () => {
    const { Worker } = await import('node:worker_threads')
    const w = new Worker(
      "const { parentPort, workerData } = require('node:worker_threads'); try { require(workerData); parentPort.postMessage('loaded') } catch (e) { parentPort.postMessage(String(e && e.message)) }",
      { eval: true, workerData: addonPath },
    )
    const msg = await new Promise<unknown>((resolve) => w.once('message', resolve))
    await w.terminate()
    expect(msg).toMatch(/one environment/)
  })

  // Needs the FIPS provider built beside the addon.
  it.skipIf(!haveProvider)('note N7: in approved mode the IV for GCM comes from the module DRBG only (SCC_16)', () => {
    const k = native.keyRandom()
    const kek = native.keyRandom('kek')
    const iv = new Uint8Array(12)
    expect(() => native.gcmSeal(k, iv, new Uint8Array(0), new Uint8Array(4))).toThrow(expect.objectContaining({ code: 'SCC_16' }))
    expect(() => native.gcmSealKey(kek, native.keyRandom('db'), iv, new Uint8Array(0))).toThrow(expect.objectContaining({ code: 'SCC_16' }))
    expect(native.gcmSeal(k, null, new Uint8Array(0), new Uint8Array(4)).length).toBe(12 + 4 + 16)
    native.keyDestroy(k)
    native.keyDestroy(kek)
  })

  it('note N8: keys from non-approved functions (Argon2id, legacy HKDF) live in their own handle namespace', () => {
    const pw = new TextEncoder().encode('slate-kat-password')
    const fromArgon = native.argon2id(pw, new Uint8Array(16).fill(0x5a), 32, 1)
    // C4: a password KEK derives nothing itself; the master key it unwraps inherits its namespace.
    const wrappedMaster = native.gcmSealKey(fromArgon, native.keyRandom('master'), null, new Uint8Array(0))
    const master = native.gcmOpenKey(fromArgon, wrappedMaster.subarray(0, 12), new Uint8Array(0), wrappedMaster.subarray(12))
    const derived = native.kbkdf(master, 'slate/v2/sync', new Uint8Array(16))
    const legacy = native.hkdfLegacy(native.keyRandom(), new Uint8Array(0), 'slate/v1/sync')
    const fresh = native.keyRandom()
    expect([fromArgon, derived, legacy].map(isApprovedKey)).toEqual([false, false, false])
    expect(isApprovedKey(fresh)).toBe(haveProvider)
    // The namespace bit is part of the handle: flipping it names no key.
    expect(() => native.keyDestroy(((fromArgon ^ 0x80000000) >>> 0) as KeyHandle)).toThrow(expect.objectContaining({ code: 'SCC_8' }))
    native.zeroizeAll()
  })

  // C4 (review C2 R2, C3 L1/L2): every handle carries one usage, and the module refuses cross-use (SCC_17).
  it('C4 usage flags: a password KEK wraps and unwraps only a master key, never a data key (C2 review R2)', () => {
    const aad = new TextEncoder().encode('usage')
    const pwKek = native.pbkdf2(new TextEncoder().encode('password'), new Uint8Array(16).fill(1), 1000)
    const data = native.keyRandom()
    const db = native.keyRandom('db')
    const master = native.keyRandom('master')
    expect(() => native.gcmSealKey(pwKek, data, null, aad)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.gcmSealKey(pwKek, db, null, aad)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    const wrapped = native.gcmSealKey(pwKek, master, null, aad)
    expect(() => native.gcmOpenKey(pwKek, wrapped.subarray(0, 12), aad, wrapped.subarray(12), 'data')).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    const back = native.gcmOpenKey(pwKek, wrapped.subarray(0, 12), aad, wrapped.subarray(12))
    // A password KEK is a KEK only: no data service, no key derivation, no database.
    expect(() => native.gcmSeal(pwKek, null, aad, new Uint8Array(4))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.hmacSha256(pwKek, aad)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.hkdfLegacy(pwKek, new Uint8Array(0), 'slate/v1/sync')).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.kbkdf(pwKek, 'slate/v2/sync', new Uint8Array(16))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    // The unwrapped key is a master key: it derives subkeys and does nothing else.
    expect(() => native.gcmSeal(back, null, aad, new Uint8Array(4))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.aesEcbBlock(back, new Uint8Array(16), true)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    const sub = native.hkdfLegacy(back, new Uint8Array(0), 'slate/v1/sync')
    expect(native.gcmSeal(sub, null, aad, new Uint8Array(4)).length).toBe(32)
    // Subkeys and file keys are never wrapped under a master key or a password KEK.
    expect(() => native.gcmSealKey(back, sub, null, aad)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    native.zeroizeAll()
  })

  it('C4 usage flags: a database key keys SQLCipher and is wrapped under a KEK, and nothing else', () => {
    const aad = new TextEncoder().encode('lk')
    const wrap = native.hkdfLegacy(native.keyRandom('master'), new Uint8Array(0), 'slate/v1/local-wrap', 'kek')
    const lk = native.keyRandom('db')
    expect(() => native.gcmSeal(lk, null, aad, new Uint8Array(4))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.hkdfLegacy(lk, new Uint8Array(0), 'slate/v1/sync')).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    const sealed = native.gcmSealKey(wrap, lk, null, aad)
    expect(() => native.gcmOpenKey(wrap, sealed.subarray(0, 12), aad, sealed.subarray(12), 'master')).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    const back = native.gcmOpenKey(wrap, sealed.subarray(0, 12), aad, sealed.subarray(12), 'db')
    expect(() => native.hmacSha256(back, aad)).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    native.zeroizeAll()
  })

  it('C4: gcmSealIvInAad draws the IV in the module and authenticates it inside the AAD (SLE envelopes)', () => {
    const k = native.keyRandom()
    const aad = new TextEncoder().encode('SLE1\u0000' + 's'.repeat(16) + 'n'.repeat(12) + '|docs/x')
    const sealed = native.gcmSealIvInAad(k, aad, 21, new TextEncoder().encode('body'))
    const iv = sealed.subarray(0, 12)
    // The caller's 12 bytes at the offset were replaced by the module's IV.
    expect(Array.from(iv)).not.toEqual(Array.from(aad.subarray(21, 33)))
    const bound = aad.slice()
    bound.set(iv, 21)
    expect(new TextDecoder().decode(native.gcmOpen(k, iv, bound, sealed.subarray(12)))).toBe('body')
    expect(() => native.gcmOpen(k, iv, aad, sealed.subarray(12))).toThrow(expect.objectContaining({ code: 'SCC_11' }))
    const again = native.gcmSealIvInAad(k, aad, 21, new TextEncoder().encode('body'))
    expect(Array.from(again.subarray(0, 12))).not.toEqual(Array.from(iv))
    expect(() => native.gcmSealIvInAad(k, aad, aad.length - 11, new Uint8Array(1))).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    expect(() => native.gcmSealIvInAad(native.keyRandom('master'), aad, 21, new Uint8Array(1))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    native.zeroizeAll()
  })

  it('C4: hkdfFromSecret derives a password-class KEK from caller bytes (RFC 5869) and wipes them', () => {
    const secret = new Uint8Array(32).fill(7)
    const salt = new TextEncoder().encode('e6be7b8b-3bf4-47af-add3-f30ad364caac')
    const kek = native.hkdfFromSecret(secret, salt, 'slate/v1/recovery')
    expect(Array.from(secret)).toEqual(new Array(32).fill(0))
    expect(isApprovedKey(kek)).toBe(false)
    // Same bytes in, same key out: what it wraps under one derivation opens under another.
    const master = native.keyRandom('master')
    const aad = new Uint8Array(0)
    const sealed = native.gcmSealKey(kek, master, null, aad)
    const again = native.hkdfFromSecret(new Uint8Array(32).fill(7), salt, 'slate/v1/recovery')
    expect(() => native.gcmOpenKey(again, sealed.subarray(0, 12), aad, sealed.subarray(12))).not.toThrow()
    expect(() => native.gcmSeal(kek, null, aad, new Uint8Array(1))).toThrow(expect.objectContaining({ code: 'SCC_17' }))
    expect(() => native.hkdfFromSecret(new Uint8Array(32), salt, '')).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    native.zeroizeAll()
  })

  /** The recovery-key text format (vault/recovery.ts), written out independently: base32 of the key, then SHA-256's first 20 bits. */
  function recoveryText(key: Uint8Array): string {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const bits = [...key].map((b) => b.toString(2).padStart(8, '0')).join('') + '0000'
    const check = [...createHash('sha256').update(key).digest().subarray(0, 3)].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, 20)
    const chars = (bits + check).match(/.{5}/g)!.map((g) => ALPHABET[parseInt(g, 2)]).join('')
    return chars.match(/.{4}/g)!.join('-')
  }

  it('C7: recoveryDecode turns the typed recovery key into a handle, and only hkdfFromRecovery uses it', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const secret = randomBytes(32)
    const salt = enc('e6be7b8b-3bf4-47af-add3-f30ad364caac')
    const text = enc(recoveryText(secret))
    const before = native.status().liveHandles
    const rc = native.recoveryDecode(text)
    // The typed bytes are wiped, and the decoded secret never comes back to JavaScript.
    expect(Array.from(text)).toEqual(new Array(text.length).fill(0))
    expect(native.status().liveHandles).toBe(before + 1)
    const kek = native.hkdfFromRecovery(rc, salt, 'slate/v1/recovery')
    expect(isApprovedKey(kek)).toBe(false)
    // The same KEK as HKDF over the secret's bytes (the creation path, hkdfFromSecret).
    const master = native.keyRandom('master')
    const sealed = native.gcmSealKey(native.hkdfFromSecret(new Uint8Array(secret), salt, 'slate/v1/recovery'), master, null, new Uint8Array(0))
    expect(() => native.gcmOpenKey(kek, sealed.subarray(0, 12), new Uint8Array(0), sealed.subarray(12))).not.toThrow()
    // Case, spaces, dashes and the look-alikes O/I/L are read as the user means them.
    const loose = recoveryText(secret).toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(() => native.keyDestroy(native.recoveryDecode(enc(`  ${loose}\n`)))).not.toThrow()
    // A recovery handle does nothing else: no AEAD, no HMAC, no wrap, no KDF, no database.
    const code = (fn: () => unknown) => {
      try {
        fn()
        return null
      } catch (e) {
        return nativeErrorCode(e)
      }
    }
    expect(code(() => native.gcmSeal(rc, null, new Uint8Array(0), new Uint8Array(1)))).toBe('SCC_17')
    expect(code(() => native.hmacSha256(rc, new Uint8Array(1)))).toBe('SCC_17')
    expect(code(() => native.kbkdf(rc, 'slate/test', new Uint8Array(0)))).toBe('SCC_17')
    expect(code(() => native.gcmSealKey(rc, native.keyRandom('master'), null, new Uint8Array(0)))).toBe('SCC_17')
    expect(code(() => native.hkdfFromRecovery(native.keyRandom(), salt, 'slate/v1/recovery'))).toBe('SCC_17')
    native.keyDestroy(rc)
    expect(code(() => native.hkdfFromRecovery(rc, salt, 'slate/v1/recovery'))).toBe('SCC_8')
    native.zeroizeAll()
  })

  /** The JavaScript decoder recoveryDecode replaced (vault/recovery.ts before C7), kept as the oracle for what a typed key may look like. */
  function oldDecodeAccepts(text: string): boolean {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const chars = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
    if (chars.length !== 56 || [...chars].some((c) => !ALPHABET.includes(c))) return false
    let bits = 0n
    for (const c of chars.slice(0, 52)) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(c))
    if ((bits & 0xfn) !== 0n) return false
    const key = Buffer.from((bits >> 4n).toString(16).padStart(64, '0'), 'hex')
    return recoveryText(key).replace(/-/g, '').slice(52) === chars.slice(52)
  }

  it('C7 (review L1): recoveryDecode accepts every separator the old JavaScript decoder did (\\s and -), and refuses what it refused', () => {
    const key = randomBytes(32)
    const groups = recoveryText(key).split('-')
    // Every code point JavaScript's \s matches, plus other dashes and a few look-alikes it refused.
    const separators = [...'\t\n\v\f\r                  　﻿-', '–', '—', '_', '.', '​']
    const disagree: string[] = []
    for (const sep of separators) {
      const text = groups.join(sep)
      const want = oldDecodeAccepts(text)
      let got = true
      try {
        native.keyDestroy(native.recoveryDecode(new TextEncoder().encode(text)))
      } catch {
        got = false
      }
      if (got !== want) disagree.push(`U+${sep.codePointAt(0)!.toString(16).padStart(4, '0')}: old ${String(want)}, native ${String(got)}`)
    }
    expect(disagree).toEqual([])
    expect(oldDecodeAccepts(groups.join(' '))).toBe(true)
  })

  it('C7 (re-review L): a separator must be whole UTF-8; a broken sequence never swallows the next character', () => {
    const groups = recoveryText(randomBytes(32)).split('-')
    const enc = new TextEncoder()
    const join = (sep: number[]) => {
      const parts = groups.map((g) => enc.encode(g))
      const out: number[] = []
      parts.forEach((p, i) => out.push(...(i === 0 ? [] : sep), ...p))
      return new Uint8Array(out)
    }
    // A truncated U+2000…U+200A, U+3000 or BOM followed by an ASCII byte, in place of each dash.
    for (const sep of [[0xe2, 0x80, 0x5a], [0xe2, 0x80], [0xe3, 0x80, 0x41], [0xef, 0xbb, 0x30], [0xc2, 0x41], [0xe2, 0x81, 0x1f]]) {
      expect(() => native.recoveryDecode(join(sep)), sep.map((b) => b.toString(16)).join(' ')).toThrow(expect.objectContaining({ code: 'SCC_1' }))
    }
    expect(() => native.keyDestroy(native.recoveryDecode(join([0xe2, 0x80, 0x8a])))).not.toThrow()
  })

  it('C7: recoveryDecode refuses a key with a typo, a wrong checksum, the wrong length or padding bits (SCC_1), and wipes the text', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const good = recoveryText(randomBytes(32))
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    const before = native.status().liveHandles
    for (const bad of [flip(good, 0), flip(good, good.length - 1), good.slice(0, -1), `${good}A`, good.replace(/-/g, 'U'), '', 'x'.repeat(300), `${good.slice(0, 63)}1${good.slice(64)}`]) {
      const bytes = enc(bad)
      expect(() => native.recoveryDecode(bytes), bad).toThrow(expect.objectContaining({ code: 'SCC_1' }))
      expect(bytes.every((b) => b === 0)).toBe(true)
    }
    expect(native.status().liveHandles).toBe(before)
  })

  it('C4: argon2idAsync derives off the main thread, equals argon2id, and wipes the password at once', async () => {
    const salt = new Uint8Array(16).fill(0x5a)
    const pw = new TextEncoder().encode('slate-kat-password')
    const pending = native.argon2idAsync(pw, salt, 32, 3)
    expect(Array.from(pw)).toEqual(new Array(pw.length).fill(0))
    const viaAsync = await pending
    const viaSync = native.argon2id(new TextEncoder().encode('slate-kat-password'), salt, 32, 3)
    expect(isApprovedKey(viaAsync)).toBe(false)
    const master = native.keyRandom('master')
    const sealed = native.gcmSealKey(viaAsync, master, null, new Uint8Array(0))
    expect(() => native.gcmOpenKey(viaSync, sealed.subarray(0, 12), new Uint8Array(0), sealed.subarray(12))).not.toThrow()
    await expect(native.argon2idAsync(new Uint8Array(4), salt, 31, 1)).rejects.toMatchObject({ code: 'SCC_1' })
    native.zeroizeAll()
  })

  // Review C4 M1: usage flags alone let a data key wrap a key and then gcmOpen it, export a vault's master key
  // under a password the caller chose, and launder approval through a re-wrap. Each of those probes is refused
  // here; the longer route the re-review found (M1-R) is the pinned C4 residual below, closed by C5.
  const code = (fn: () => unknown): string | null => {
    try {
      fn()
    } catch (e) {
      return nativeErrorCode(e)
    }
    return null
  }

  it('C4 M1: a data key wraps and unwraps no key, so LK or a subkey cannot be exported through gcmSealKey + gcmOpen', () => {
    const aad = new TextEncoder().encode('m1')
    const k = native.keyRandom()
    const mk = native.keyRandom('master')
    const sub = native.hkdfLegacy(mk, new Uint8Array(0), 'slate/v1/sync')
    for (const victim of [native.keyRandom('db'), sub, native.keyRandom()]) expect(code(() => native.gcmSealKey(k, victim, null, aad))).toBe('SCC_17')
    const sealed = native.gcmSeal(k, null, aad, new Uint8Array(32))
    for (const usage of ['data', 'db', 'master', 'kek'] as const) expect(code(() => native.gcmOpenKey(k, sealed.subarray(0, 12), aad, sealed.subarray(12), usage)), usage).toBe('SCC_17')
    native.zeroizeAll()
  })

  it('C4 M1: a KEK is derived only from a master key for local-wrap, wraps only a fresh db key, and encrypts nothing', () => {
    const aad = new TextEncoder().encode('lk')
    const mk = native.keyRandom('master')
    expect(code(() => native.hkdfLegacy(mk, new Uint8Array(0), 'slate/v1/sync', 'kek'))).toBe('SCC_17')
    expect(code(() => native.kbkdf(native.hkdfLegacy(mk, new Uint8Array(0), 'slate/v1/sync'), 'slate/v2/local-wrap', new Uint8Array(16), 'kek'))).toBe('SCC_17')
    const kek = native.hkdfLegacy(mk, new Uint8Array(0), 'slate/v1/local-wrap', 'kek')
    expect(code(() => native.gcmSeal(kek, null, aad, new Uint8Array(4)))).toBe('SCC_17')
    expect(code(() => native.gcmSealIvInAad(kek, new Uint8Array(40), 21, new Uint8Array(4)))).toBe('SCC_17')
    expect(code(() => native.hmacSha256(kek, aad))).toBe('SCC_17')
    const w = native.gcmSealKey(kek, native.keyRandom('db'), null, aad)
    // A KEK opens no data: the wrap of a key never comes back as bytes.
    expect(code(() => native.gcmOpen(kek, w.subarray(0, 12), aad, w.subarray(12)))).toBe('SCC_17')
    const lk = native.gcmOpenKey(kek, w.subarray(0, 12), aad, w.subarray(12))
    // An unwrapped key is in use, never fresh: it cannot be wrapped again, under this KEK or another.
    expect(code(() => native.gcmSealKey(kek, lk, null, aad))).toBe('SCC_17')
    expect(code(() => native.gcmSealKey(native.keyRandom('kek'), lk, null, aad))).toBe('SCC_17')
    native.zeroizeAll()
  })

  it('C4 M1: the master key a vault unwrapped cannot be exported under a password KEK the caller chose (it only unwraps to a handle)', () => {
    const aad = new Uint8Array(0)
    const salt = new Uint8Array(16).fill(3)
    const vaultKek = native.pbkdf2(new TextEncoder().encode('the vault password'), salt, 1000)
    const fresh = native.keyRandom('master')
    const w = native.gcmSealKey(vaultKek, fresh, null, aad)
    const mk = native.gcmOpenKey(vaultKek, w.subarray(0, 12), aad, w.subarray(12))
    const chosen = native.pbkdf2(new TextEncoder().encode('a password the attacker knows'), salt, 1000)
    expect(code(() => native.gcmSealKey(chosen, mk, null, aad))).toBe('SCC_17')
    // A fresh master key stops being wrappable at its first use (createVault computes `check` last).
    native.keyDestroy(native.hkdfLegacy(fresh, new Uint8Array(0), 'slate/v1/check'))
    expect(code(() => native.gcmSealKey(chosen, fresh, null, aad))).toBe('SCC_17')
    native.zeroizeAll()
  })

  it('C4 M1: rewrapKey moves a wrap between KEKs of one kind, needs the old KEK, and hands out no handle', () => {
    const aad = new TextEncoder().encode('a')
    const aad2 = new TextEncoder().encode('b')
    const pw1 = native.hkdfFromSecret(native.randomBytes(32), new Uint8Array(0), 'slate/test/one')
    const pw2 = native.hkdfFromSecret(native.randomBytes(32), new Uint8Array(0), 'slate/test/two')
    const w = native.gcmSealKey(pw1, native.keyRandom('master'), null, aad)
    const live = native.status().liveHandles
    const moved = native.rewrapKey(pw1, w.subarray(0, 12), aad, w.subarray(12), pw2, aad2)
    expect(native.status().liveHandles).toBe(live)
    expect(moved.length).toBe(60)
    native.keyDestroy(native.gcmOpenKey(pw2, moved.subarray(0, 12), aad2, moved.subarray(12)))
    expect(code(() => native.rewrapKey(pw2, w.subarray(0, 12), aad, w.subarray(12), pw1, aad))).toBe('SCC_11')
    expect(code(() => native.rewrapKey(pw1, w.subarray(0, 12), aad, w.subarray(12), native.keyRandom('kek'), aad))).toBe('SCC_17')
    expect(code(() => native.rewrapKey(native.keyRandom(), w.subarray(0, 12), aad, w.subarray(12), native.keyRandom(), aad))).toBe('SCC_17')
    native.zeroizeAll()
  })

  it('C4 M1: a non-approved key does not come back approved through a direct re-wrap', () => {
    const aad = new Uint8Array(0)
    const approvedMk = native.keyRandom('master')
    const approvedKek = native.kbkdf(approvedMk, 'slate/v2/local-wrap', new Uint8Array(16), 'kek')
    const legacyKek = native.hkdfLegacy(native.keyRandom('master'), new Uint8Array(0), 'slate/v1/local-wrap', 'kek')
    // Without the FIPS provider no key is approved, so only the provider build can refuse a laundering.
    expect([isApprovedKey(approvedKek), isApprovedKey(legacyKek)]).toEqual([haveProvider, false])
    // A standard-profile LK: wrapped and unwrapped under the HKDF (non-approved) local-wrap KEK.
    const w = native.gcmSealKey(legacyKek, native.keyRandom('db'), null, aad)
    const legacyLk = native.gcmOpenKey(legacyKek, w.subarray(0, 12), aad, w.subarray(12))
    expect(isApprovedKey(legacyLk)).toBe(false)
    expect(code(() => native.gcmSealKey(approvedKek, legacyLk, null, aad))).toBe('SCC_17')
    // C5: a database key's wrap never moves at all (review C4 M1-R), approved or not.
    expect(code(() => native.rewrapKey(legacyKek, w.subarray(0, 12), aad, w.subarray(12), approvedKek, aad))).toBe('SCC_17')
    native.zeroizeAll()
  })

  // Review C4 M1-R, pinned call for call while it was the accepted residual (POAM-09) and closed by C5: a
  // database key never moves between KEKs, so the real LK cannot reach a KEK whose bytes JavaScript knows,
  // and the ring's non-approved LK cannot come back approved.
  it('C4 residual (closed by C5): in-process code holding the MK handle exports LK and launders approval in five calls', () => {
    const aad = new TextEncoder().encode('slate-lk/v1|vault|device')
    // The victim: a vault's MK and its LK, wrapped in local-keys.json under K_localwrap.
    const realMk = native.keyRandom('master')
    const realKek = native.hkdfLegacy(realMk, new Uint8Array(0), 'slate/v1/local-wrap', 'kek')
    const realWrap = native.gcmSealKey(realKek, native.keyRandom('db'), null, aad)
    const ringLk = native.gcmOpenKey(realKek, realWrap.subarray(0, 12), aad, realWrap.subarray(12), 'db')
    // 1. A chosen master key, unwrapped under a PBKDF2 KEK whose bytes JavaScript computes.
    const password = new TextEncoder().encode('chosen password')
    const salt = new Uint8Array(16).fill(9)
    const pwKekBytes = pbkdf2Sync(password, salt, 1000, 32, 'sha512')
    const pwKek = native.pbkdf2(password.slice(), salt, 1000)
    const chosenMk = randomBytes(32)
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', pwKekBytes, iv).setAAD(aad)
    const mkWrap = Buffer.concat([c.update(chosenMk), c.final(), c.getAuthTag()])
    const chosenMaster = native.gcmOpenKey(pwKek, iv, aad, mkWrap)
    // 2. A KEK derived from it, whose bytes JavaScript also computes (here, the HKDF of the chosen bytes).
    const madeUpKek = native.hkdfLegacy(chosenMaster, new Uint8Array(0), 'evil/local-wrap', 'kek')
    expect(hkdfSync('sha256', chosenMk, new Uint8Array(0), 'evil/local-wrap', 32).byteLength).toBe(32)
    // 3. Moving the real wrap under it is refused: there is no KEK-class rewrap any more.
    expect(code(() => native.rewrapKey(realKek, realWrap.subarray(0, 12), aad, realWrap.subarray(12), madeUpKek, aad))).toBe('SCC_17')
    // 4-5. Nor does the real LK reach an approved KEK whose bytes JavaScript knows: not moved, not wrapped again.
    const approvedKek = native.kbkdf(chosenMaster, 'evil/local-wrap', new Uint8Array(16), 'kek')
    expect(code(() => native.rewrapKey(realKek, realWrap.subarray(0, 12), aad, realWrap.subarray(12), approvedKek, aad))).toBe('SCC_17')
    expect(code(() => native.gcmSealKey(approvedKek, ringLk, null, aad))).toBe('SCC_17')
    expect(isApprovedKey(ringLk)).toBe(false)
    native.zeroizeAll()
  })

  it('C4 M1: chosen bytes never become a database key through a data key or a KEK (no import, approved or not)', () => {
    const aad = new Uint8Array(0)
    const chosen = new Uint8Array(32).fill(0x42)
    const data = native.keyRandom()
    const sealed = native.gcmSeal(data, null, aad, chosen)
    expect(code(() => native.gcmOpenKey(data, sealed.subarray(0, 12), aad, sealed.subarray(12), 'db'))).toBe('SCC_17')
    const kek = native.keyRandom('kek')
    expect(code(() => native.gcmSeal(kek, null, aad, chosen))).toBe('SCC_17')
    native.zeroizeAll()
  })

  it('never reuses a destroyed handle (SCC_8)', () => {
    const h = native.keyRandom()
    native.keyDestroy(h)
    const again = native.keyRandom()
    expect(again).not.toBe(h)
    expect(() => native.keyDestroy(h)).toThrow(expect.objectContaining({ code: 'SCC_8' }))
    native.keyDestroy(again)
  })

  it('reports a locked 1 MiB secure heap (criterion 5)', () => {
    const s = native.status()
    expect(typeof s.secureHeapLocked).toBe('boolean')
    const h = native.keyRandom()
    expect(native.status().secureHeapUsed).toBeGreaterThan(s.secureHeapUsed)
    native.keyDestroy(h)
  })
})

/** init in a fresh process: the error state is sticky, so each case needs its own. */
function initInChild(dir: string, env: Record<string, string> = {}): { ok: boolean; code?: string; fipsActive?: boolean; providers?: string; errorState: boolean; servicesRefused?: boolean } {
  const config = join(dir, 'openssl-fips.cnf')
  writeFileSync(config, fipsConfigText(dir))
  const script = join(tmp, 'init-child.cjs')
  writeFileSync(
    script,
    `const n = require(process.argv[2])
let out
try {
  n.init(process.argv[3], process.argv[4], true)
  const s = n.status()
  out = { ok: true, fipsActive: s.fipsActive, providers: s.defaultContextProviders.split(',').sort().join(','), errorState: s.errorState }
} catch (e) {
  let refused = false
  try { n.keyRandom() } catch (e2) { refused = e2.code === 'SCC_12' }
  out = { ok: false, code: e.code, errorState: n.status().errorState, servicesRefused: refused }
}
process.stdout.write(JSON.stringify(out))`,
  )
  const stdout = execFileSync(process.execPath, [script, addonPath, config, dir], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
  return JSON.parse(stdout) as ReturnType<typeof initInChild>
}

function providerCopy(name: string): string {
  const dir = join(tmp, name)
  cpSync(modulesDir, dir, { recursive: true })
  return dir
}

// Needs the built addon (npm run -w @slate/native build:addon); a checkout without OpenSSL skips it.
describe.skipIf(!haveAddon || !haveProvider)('T-POST-06: provider tampering', () => {
  it('an intact copy of resources/fips starts in approved mode', () => {
    expect(initInChild(providerCopy('intact'))).toEqual({ ok: true, fipsActive: true, providers: 'base,fips', errorState: false })
  })

  it('M4: one flipped byte in the provider is refused by the pinned digest before OpenSSL loads it (SCC_15)', () => {
    const dir = providerCopy('flipped')
    const file = join(dir, moduleFile)
    const bytes = readFileSync(file)
    // A byte in the middle of the file: inside the region the module's HMAC covers.
    bytes[bytes.length >> 1]! ^= 0x01
    writeFileSync(file, bytes)
    const r = initInChild(dir)
    expect(r).toMatchObject({ ok: false, code: 'SCC_15', errorState: true, servicesRefused: true })
  })

  // Needs a C compiler to build the substitute provider.
  it.skipIf(!haveCc)('M4: a substituted provider never runs: its constructor does not execute (digest checked before dlopen)', () => {
    const dir = providerCopy('substituted')
    const src = join(tmp, 'evil.c')
    const marker = join(tmp, 'evil-ran.txt')
    writeFileSync(src, `#include <stdio.h>\n__attribute__((constructor)) static void pwn(void) { FILE *f = fopen("${marker}", "w"); if (f) { fputs("ran", f); fclose(f); } }\nint OSSL_provider_init(void) { return 0; }\n`)
    execFileSync('cc', ['-shared', '-fPIC', '-o', join(dir, moduleFile), src])
    const r = initInChild(dir)
    expect(existsSync(marker)).toBe(false)
    expect(r).toMatchObject({ ok: false, code: 'SCC_15', errorState: true, servicesRefused: true })
  })

  // Needs a C compiler to build the substitute provider.
  it.skipIf(!haveCc)('R3: a module = line injected into fipsmodule.cnf is refused before load (SCC_15), the named dylib never runs', () => {
    const dir = providerCopy('cnf-module')
    const src = join(tmp, 'evil-cnf.c')
    const marker = join(tmp, 'evil-cnf-ran.txt')
    const evil = join(tmp, 'evil-cnf.dylib')
    writeFileSync(src, `#include <stdio.h>\n__attribute__((constructor)) static void pwn(void) { FILE *f = fopen("${marker}", "w"); if (f) { fputs("ran", f); fclose(f); } }\nint OSSL_provider_init(void) { return 0; }\n`)
    execFileSync('cc', ['-shared', '-fPIC', '-o', evil, src])
    const cnf = join(dir, 'fipsmodule.cnf')
    writeFileSync(cnf, readFileSync(cnf, 'utf8').replace('[fips_sect]\n', `[fips_sect]\nmodule = ${evil}\n`))
    const r = initInChild(dir)
    expect(existsSync(marker)).toBe(false)
    expect(r).toMatchObject({ ok: false, code: 'SCC_15', errorState: true, servicesRefused: true })
  })

  it('R3: a module key in the runtime config is refused before load (SCC_5)', () => {
    const dir = providerCopy('runtime-module')
    const config = join(dir, 'openssl-fips.cnf')
    writeFileSync(config, fipsConfigText(dir).replace('[base_sect]\n', `[base_sect]\nmodule = ${join(tmp, 'nowhere.dylib')}\n`))
    const script = join(tmp, 'runtime-child.cjs')
    writeFileSync(script, `const n = require(process.argv[2]); try { n.init(process.argv[3], process.argv[4], true); process.stdout.write('ok') } catch (e) { process.stdout.write(String(e.code)) }`)
    expect(execFileSync(process.execPath, [script, addonPath, config, dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })).toBe('SCC_5')
  })

  it('a changed module-mac in fipsmodule.cnf is refused by the config pin before load (SCC_15), error state', () => {
    const dir = providerCopy('mac')
    const cnf = join(dir, 'fipsmodule.cnf')
    const text = readFileSync(cnf, 'utf8')
    const changed = text.replace(/^(module-mac\s*=\s*)([0-9A-F])/m, (_m, head: string, first: string) => head + (first === '0' ? '1' : '0'))
    expect(changed).not.toBe(text)
    writeFileSync(cnf, changed)
    const r = initInChild(dir)
    expect(r).toMatchObject({ ok: false, code: 'SCC_15', errorState: true, servicesRefused: true })
  })
})

// Needs the built addon (npm run -w @slate/native build:addon); a checkout without OpenSSL skips it.
describe.skipIf(!haveAddon || !haveProvider)('criterion 2: no system OpenSSL configuration is consulted', () => {
  it('ignores OPENSSL_CONF and OPENSSL_MODULES from the environment', () => {
    const hostile = join(tmp, 'hostile.cnf')
    // Were libcrypto to read this, the default provider (non-approved algorithms) would join fips + base.
    writeFileSync(hostile, 'openssl_conf = hostile_init\n[hostile_init]\nproviders = hostile_providers\n[hostile_providers]\ndefault = hostile_default\n[hostile_default]\nactivate = 1\n')
    const r = initInChild(providerCopy('env'), { OPENSSL_CONF: hostile, OPENSSL_MODULES: '/nonexistent/slate/modules' })
    expect(r).toEqual({ ok: true, fipsActive: true, providers: 'base,fips', errorState: false })
  })

  it('M1: services called before init refuse with SCC_2, so OPENSSL_CONF never gets a chance to load', () => {
    const dir = providerCopy('pre-init')
    const config = join(dir, 'openssl-fips.cnf')
    writeFileSync(config, fipsConfigText(dir))
    const hostile = join(tmp, 'hostile-pre.cnf')
    writeFileSync(hostile, 'openssl_conf = hostile_init\n[hostile_init]\nproviders = hostile_providers\n[hostile_providers]\ndefault = hostile_default\n[hostile_default]\nactivate = 1\n')
    const script = join(tmp, 'pre-child.cjs')
    writeFileSync(
      script,
      `const n = require(process.argv[2])
const code = (f) => { try { f(); return 'ran' } catch (e) { return e.code } }
const early = code(() => n.randomBytes(4))
const key = code(() => n.keyRandom())
const digest = code(() => n.sha256(new Uint8Array(4)))
n.init(process.argv[3], process.argv[4], true)
const s = n.status()
process.stdout.write(JSON.stringify({ early, key, digest, providers: s.defaultContextProviders.split(',').sort().join(','), fipsActive: s.fipsActive }))`,
    )
    const out = execFileSync(process.execPath, [script, addonPath, config, dir], { env: { ...process.env, OPENSSL_CONF: hostile, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({ early: 'SCC_2', key: 'SCC_2', digest: 'SCC_2', providers: 'base,fips', fipsActive: true })
  })
})

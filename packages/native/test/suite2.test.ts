// C5: the suite-0x02 services of the shipped addon (audit §4.5.2, §4.6, Appendix A) and the closed C4
// residual (review C4 M1-R), checked against node:crypto as the independent reference.
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KeyHandle, SlateNative } from '../index'

const addon = join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node')
const n = createRequire(import.meta.url)(addon) as SlateNative
// This project's other files share the process and init without the provider; init once, tolerate a second file.
try {
  n.init('', '', false)
} catch {
  // Already initialised by another test file in this process.
}

const code = (fn: () => unknown): string | null => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
  return null
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const MK = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const VID = Buffer.from('000000000000400080000000000000aa', 'hex')

/** SP 800-108r1 counter mode, HMAC-SHA-256, one block: [1]32 || Label || 0x00 || Context || [256]32. */
function refKbkdf(key: Uint8Array, label: string, context: Uint8Array): Buffer {
  return createHmac('sha256', key).update(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(label), Buffer.from([0]), context, Buffer.from([0, 0, 1, 0])])).digest()
}

/** Known bytes as a master key, the way a vault header brings one in: wrapped under a PBKDF2 KEK. */
function importMaster(bytes: Uint8Array): KeyHandle {
  const password = randomBytes(16)
  const salt = randomBytes(16)
  const aad = Buffer.from('slate/test/import')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 1000, 32, 'sha512'), iv).setAAD(aad)
  const ct = Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()])
  const kek = n.pbkdf2(new Uint8Array(password), salt, 1000)
  try {
    return n.gcmOpenKey(kek, iv, aad, ct, 'master')
  } finally {
    n.keyDestroy(kek)
  }
}

describe('C5 suite 0x02 in the shipped addon', () => {
  it('Appendix A: the suite-0x02 name of page 00000000-0000-4000-8000-000000000001, and its decode', () => {
    const mk = importMaster(MK)
    const enc = n.kbkdf(mk, 'slate/v2/name-enc', VID)
    const mac = n.kbkdf(mk, 'slate/v2/name-mac', VID)
    const p = Buffer.from('00000000000020008000000000000001', 'hex')
    const name = n.nameSivEncode(enc, mac, p)
    expect(hex(name)).toBe('50e291505985f76efa7aeb45620bd1b830101fd8c6a1b6030c339f4eee5ffe9c')
    expect(hex(n.nameSivDecode(enc, mac, name)!)).toBe(hex(p))
    // The reference construction: SIV = HMAC(K_name_mac, "slate-name/v2" 0x00 || P)[0..16), C = AES-CTR(K_name_enc, SIV, P).
    const siv = createHmac('sha256', refKbkdf(MK, 'slate/v2/name-mac', VID)).update(Buffer.concat([Buffer.from('slate-name/v2\u0000'), p])).digest().subarray(0, 16)
    const ctr = createCipheriv('aes-256-ctr', refKbkdf(MK, 'slate/v2/name-enc', VID), siv)
    expect(hex(name)).toBe(hex(Buffer.concat([siv, ctr.update(p), ctr.final()])))
    for (const k of [mk, enc, mac]) n.keyDestroy(k)
  })

  it('a name that fails the SIV decodes to null and releases nothing; bad shapes are refused', () => {
    const mk = importMaster(randomBytes(32))
    const enc = n.kbkdf(mk, 'slate/v2/name-enc', VID)
    const mac = n.kbkdf(mk, 'slate/v2/name-mac', VID)
    const name = n.nameSivEncode(enc, mac, randomBytes(16))
    for (let bit = 0; bit < 256; bit += 7) {
      const forged = Uint8Array.from(name)
      forged[bit >> 3]! ^= 1 << (bit & 7)
      expect(n.nameSivDecode(enc, mac, forged)).toBeNull()
    }
    expect(code(() => n.nameSivEncode(enc, mac, new Uint8Array(15)))).toBe('SCC_1')
    expect(code(() => n.nameSivDecode(enc, mac, new Uint8Array(31)))).toBe('SCC_1')
    expect(code(() => n.nameSivEncode(enc, enc, new Uint8Array(16)))).toBe('SCC_1')
    expect(code(() => n.nameSivEncode(mk, mac, new Uint8Array(16)))).toBe('SCC_17')
    for (const k of [mk, enc, mac]) n.keyDestroy(k)
  })

  it('kbkdfFromSecret: SP 800-108r1 over the secret, a password-class KEK, and the secret is wiped', () => {
    const secret = randomBytes(32)
    const copy = Buffer.from(secret)
    const kek = n.kbkdfFromSecret(secret, 'slate/v2/recovery', VID, true)
    expect(Array.from(secret)).toEqual(new Array(32).fill(0))
    // It wraps a master key that the reference bytes unwrap.
    const fresh = n.keyRandom('master')
    const w = n.gcmSealKey(kek, fresh, null, new Uint8Array(0))
    const d = createDecipheriv('aes-256-gcm', refKbkdf(copy, 'slate/v2/recovery', VID), w.subarray(0, 12))
    d.setAuthTag(w.subarray(44))
    expect(() => Buffer.concat([d.update(w.subarray(12, 44)), d.final()])).not.toThrow()
    expect(code(() => n.gcmSeal(kek, null, new Uint8Array(0), new Uint8Array(1)))).toBe('SCC_17')
    expect(code(() => n.kbkdfFromSecret(new Uint8Array(15), 'slate/v2/recovery', VID, true))).toBe('SCC_1')
    expect(code(() => n.kbkdfFromSecret(new Uint8Array(32), 'slate/v2/recovery', VID, undefined as unknown as boolean))).toBe('SCC_1')
    expect(n.kbkdfFromSecret(new Uint8Array(32).fill(7), 'slate/v2/recovery', VID, false) & 0x80000000).not.toBe(0)
    n.keyDestroy(kek)
    n.keyDestroy(fresh)
  })

  it('review C5 L1: pbkdf2Async derives off the main thread, equals pbkdf2, and wipes the password at once', async () => {
    const salt = new Uint8Array(32).fill(0x5a)
    const pw = new TextEncoder().encode('slate-kat-password')
    const pending = n.pbkdf2Async(pw, salt, 1000)
    expect(Array.from(pw)).toEqual(new Array(pw.length).fill(0))
    const viaAsync = await pending
    const viaSync = n.pbkdf2(new TextEncoder().encode('slate-kat-password'), salt, 1000)
    const master = n.keyRandom('master')
    const sealed = n.gcmSealKey(viaAsync, master, null, new Uint8Array(0))
    n.keyDestroy(n.gcmOpenKey(viaSync, sealed.subarray(0, 12), new Uint8Array(0), sealed.subarray(12)))
    await expect(n.pbkdf2Async(new Uint8Array(4), salt, 10_000_001)).rejects.toMatchObject({ code: 'SCC_1' })
    for (const k of [viaAsync, viaSync, master]) n.keyDestroy(k)
  })

  it('pbkdf2Calibrate: iterations for about the target time, inside the fips-140-3 range', () => {
    const it1 = n.pbkdf2Calibrate(1000)
    expect(Number.isSafeInteger(it1)).toBe(true)
    expect(it1).toBeGreaterThanOrEqual(600_000)
    expect(it1).toBeLessThanOrEqual(10_000_000)
    expect(code(() => n.pbkdf2Calibrate(50))).toBe('SCC_1')
  })

  it('review C4 M1-R closed: rewrapKey moves password-class wraps only, never a database key', () => {
    const aad = new Uint8Array(0)
    const mk = n.keyRandom('master')
    const realKek = n.kbkdf(mk, 'slate/v2/local-wrap', VID, 'kek')
    const w = n.gcmSealKey(realKek, n.keyRandom('db'), null, aad)
    const other = n.kbkdf(importMaster(randomBytes(32)), 'evil/local-wrap', VID, 'kek')
    expect(code(() => n.rewrapKey(realKek, w.subarray(0, 12), aad, w.subarray(12), other, aad))).toBe('SCC_17')
    n.zeroizeAll()
  })

  it('criterion 2: after requireApprovedKeys no non-approved service runs (child process: the latch is one-way)', () => {
    const r = spawnSync(process.execPath, [join(__dirname, 'latchServicesChild.mjs')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      hkdfLegacy: 'SCC_16',
      hkdfFromSecret: 'SCC_16',
      argon2id: 'SCC_16',
      argon2idAsync: 'SCC_16',
      aesEcbBlock: 'SCC_16',
      kbkdf: 'ran',
      pbkdf2: 'ran',
      nameSiv: 'ran',
    })
  })
})

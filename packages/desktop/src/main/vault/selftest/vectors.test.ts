// The self-test's known answers, recomputed outside the module (node:crypto, hash-wasm) from their definitions
// in vectors.ts, so a typo in a vector, or a vector that only the module agrees with, fails here (T-KAT style).
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { argon2id } from 'hash-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refHkdf, refKbkdf, refVid } from '../../../../test/vaultKeys'
import { KAT, KAT_VAULT_ID } from './vectors'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const gcm = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array) => {
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(aad)
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])
}
const ctr = (key: Uint8Array, icb: Uint8Array, data: Uint8Array) => {
  const c = createCipheriv('aes-256-ctr', key, icb)
  return Buffer.concat([c.update(data), c.final()])
}
const vid = refVid(KAT_VAULT_ID)
const mk = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
const kdfMk = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i)
const v2 = (label: string) => refKbkdf(mk, `slate/v2/${label}`, vid)
const v1 = (info: string) => refHkdf(mk, new Uint8Array(0), `slate/v1/${info}`)
const packed = (uuid: string) => {
  const p = Buffer.from(uuid.replace(/-/g, ''), 'hex')
  p[6] = (2 << 4) | (p[6]! & 0x0f) // page
  return p
}

describe('self-test vectors (recomputed with node:crypto and hash-wasm)', () => {
  it('the transport: MK = 20..3f wrapped under KBKDF(00..1f, "slate/post/transport", vid)', () => {
    const t = KAT.transport
    expect(hex(gcm(refKbkdf(t.secret(), t.label, vid), t.mkIv, t.mkAad, mk))).toBe(hex(t.mkWrap))
  })

  it('SHA-256, HMAC (blob name), AES-ECB (v1 name), CTR and GCM', () => {
    expect(hex(createHash('sha256').update(KAT.sha256.msg).digest())).toBe(hex(KAT.sha256.out))
    expect(createHmac('sha256', v2('name')).update(`blob|${KAT.hmacSha256.name}`).digest('hex')).toBe(KAT.hmacSha256.out)
    const ecb = createCipheriv('aes-256-ecb', v1('name-enc'), null).setAutoPadding(false)
    expect(Buffer.concat([ecb.update(packed(KAT.aesEcb.uuid)), ecb.final()]).toString('hex')).toBe(KAT.aesEcb.name)
    const g = KAT.aesGcm
    expect(hex(ctr(v2('prefs'), g.icb, g.pt))).toBe(hex(g.ctr))
    expect(hex(gcm(v2('prefs'), g.iv, g.aad, g.pt))).toBe(hex(g.ctTag))
  })

  it('both key schedules (probe MACs over K_sync)', () => {
    expect(createHmac('sha256', v2('sync')).update(KAT.probe).digest('hex')).toBe(hex(KAT.kbkdf.out))
    expect(createHmac('sha256', v1('sync')).update(KAT.probe).digest('hex')).toBe(hex(KAT.hkdfV1.out))
  })

  it('the password KDFs (Appendix A) and the keys wrapped under their outputs', async () => {
    const p = KAT.pbkdf2
    const pb = pbkdf2Sync(p.password, p.salt, p.iterations, 32, 'sha512')
    expect(hex(pb)).toBe(hex(p.out))
    expect(hex(gcm(pb, KAT.kdfWrap.iv, KAT.kdfWrap.aad, kdfMk))).toBe(hex(p.wrap))
    const a = KAT.argon2
    const ar = await argon2id({ password: a.password, salt: a.salt, parallelism: 1, iterations: a.passes, memorySize: a.memoryKiB, hashLength: 32, outputType: 'binary' })
    expect(hex(ar)).toBe(hex(a.out))
    expect(hex(gcm(ar, KAT.kdfWrap.iv, KAT.kdfWrap.aad, kdfMk))).toBe(hex(a.wrap))
  })

  it('the recovery key text and the MK sealed under its KEK_rc (POST-RECOVERY)', () => {
    const rk = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const b32 = (bytes: Uint8Array, chars: number) => {
      let bits = 0n
      for (const b of bytes) bits = (bits << 8n) | BigInt(b)
      bits <<= BigInt(chars * 5 - bytes.length * 8)
      return Array.from({ length: chars }, (_, i) => ALPHABET[Number((bits >> BigInt((chars - 1 - i) * 5)) & 31n)]).join('')
    }
    const text = (b32(rk, 52) + b32(createHash('sha256').update(rk).digest().subarray(0, 3), 5).slice(0, 4)).match(/.{4}/g)!.join('-')
    expect(text).toBe(KAT.recovery.text)
    const r = KAT.recovery
    expect(hex(gcm(refKbkdf(rk, 'slate/v2/recovery', vid), r.iv, r.aad, mk))).toBe(hex(r.wrap))
  })

  it('the SLE2 and SLE1 envelopes and the suite-0x02 name', () => {
    const e = KAT.envelope
    const h2 = Buffer.from(e.sle2.subarray(0, 38))
    const salt = e.sle2.subarray(10, 26)
    const aad2 = Buffer.concat([h2, Buffer.from(`|${e.path}`)])
    expect(hex(e.sle2.subarray(38))).toBe(hex(gcm(refKbkdf(v2('sync'), 'slate/v2/remote-file', salt), e.sle2.subarray(26, 38), aad2, e.plaintext)))
    const h1 = Buffer.from(e.sle1.subarray(0, 33))
    const aad1 = Buffer.concat([h1, Buffer.from(`|${e.path}`)])
    expect(hex(e.sle1.subarray(33))).toBe(hex(gcm(refHkdf(v1('sync'), e.sle1.subarray(5, 21), 'slate/v1/remote-file'), e.sle1.subarray(21, 33), aad1, e.plaintext)))
    const p = packed(KAT.nameV2.uuid)
    const siv = createHmac('sha256', v2('name-mac')).update(Buffer.concat([Buffer.from('slate-name/v2'), Buffer.from([0]), p])).digest().subarray(0, 16)
    expect(Buffer.concat([siv, ctr(v2('name-enc'), siv, p)]).toString('hex')).toBe(KAT.nameV2.name)
  })
})

describe('T-KAT-01: cross-implementation vectors', () => {
  // This file recomputes every vector above with node:crypto and hash-wasm. The Appendix A vectors the POST
  // shares with kat.c are also recomputed by the OpenSSL CLI and Python in packages/native/test/crossCheck.sh
  // (CI's native job), which checks each value is the literal kat.c tests: this ties the three together.
  it('the POST vectors that are Appendix A vectors are the ones crossCheck.sh recomputes and kat.c checks', () => {
    const repo = join(__dirname, '../../../../../..')
    const cross = readFileSync(join(repo, 'packages/native/test/crossCheck.sh'), 'utf8')
    const kat = readFileSync(join(repo, 'packages/native/test/kat.c'), 'utf8')
    for (const [name, out] of [['SHA-256', KAT.sha256.out], ['PBKDF2', KAT.pbkdf2.out], ['Argon2id', KAT.argon2.out]] as const) {
      expect(cross, `${name} in crossCheck.sh`).toContain(`W=${hex(out)}`)
      expect(kat, `${name} in kat.c`).toContain(`"${hex(out)}"`)
    }
  })
})

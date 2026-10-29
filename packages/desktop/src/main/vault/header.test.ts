import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KeyHandle } from '@slate/native'
import { spyOnNative, type NativeCalls } from '../../../test/nativeSpy'
import { sameMaster } from '../../../test/vaultKeys'
import { deriveSubkey } from './keyring'
import { destroyKey, toBase64, utf8, vaultNative } from './native'
import { encodeRecovery } from './recovery'
import {
  proveSecret,
  BadHeader,
  WrongSecret,
  buildHeaderV3From,
  canonicalJson,
  changePassword,
  chooseBase,
  createVault,
  floorOf,
  isDowngrade,
  isNewerKeys,
  newRecoveryKey,
  parseHeader,
  parseHeaderV3,
  rekeyHeader,
  RotationRefused,
  scheduleOf,
  unlockWithPassword,
  unlockWithRecovery,
  verifyCheck,
  type VaultHeader,
  type VaultHeaderV3,
} from './header'
import { secretBytes } from '../../shared/secret'

const calls = spyOnNative()

// Cheap Argon2 for unit tests; production headers are refused at these settings (kdf.test.ts).
const weak = { allowWeakForTests: true }
const testKdf = () => ({ memoryKiB: 64, passes: 1 })

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

async function vault(password = 'correct horse battery') {
  return createVault({ password: secretBytes(password), kdf: testKdf() }, weak)
}

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  })
  it('escapes strings like JSON and sorts by UTF-16 code units', () => {
    expect(canonicalJson({ '\u00e9': 1, e: 2, '\u20ac': 3, 'a"\n': true, n: null })).toBe(
      '{"a\\"\\n":true,"e":2,"n":null,"\u00e9":1,"\u20ac":3}',
    )
  })
  it('refuses floats, non-finite numbers and other types', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow()
    expect(() => canonicalJson({ a: Infinity })).toThrow()
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson({ a: 2n } as never)).toThrow()
  })
})

describe('createVault and unlock', () => {
  it('unlocks with the password and the recovery key to the same MK', async () => {
    const { header, mk, recoveryKey } = await vault()
    // C5 criterion 3: a standard vault created now is header v2 with suite 0x02.
    expect(header).toMatchObject({ format: 'slate-vault', version: 2, revision: 1, profile: 'standard', suite: 2, keyEpoch: 0 })
    expect(header.kdf.alg).toBe('argon2id')
    expect(header.wraps.password.alg).toBe('aes-256-gcm')
    expect(parseHeader(clone(header), weak)).toEqual(header)
    expect(sameMaster(await unlockWithPassword(header, secretBytes('correct horse battery'), weak), mk)).toBe(true)
    expect(sameMaster(unlockWithRecovery(header, secretBytes(recoveryKey!)), mk)).toBe(true)
    expect(verifyCheck(header, mk)).toBe(true)
  })

  it('a wrong password and a wrong recovery key both throw WrongSecret', async () => {
    const { header } = await vault()
    await expect(unlockWithPassword(header, secretBytes('wrong horse battery'), weak)).rejects.toThrow(WrongSecret)
    expect(() => unlockWithRecovery(header, secretBytes(encodeRecovery(Buffer.alloc(32, 1))))).toThrow(WrongSecret)
  })

  it('can be created without a recovery slot', async () => {
    const { header, recoveryKey } = await createVault({ password: secretBytes('correct horse battery'), recovery: false, kdf: testKdf() }, weak)
    expect(recoveryKey).toBeNull()
    expect(header.wraps.recovery).toBeUndefined()
    expect(() => unlockWithRecovery(header, secretBytes(encodeRecovery(Buffer.alloc(32))))).toThrow(WrongSecret)
  })

  it('production parsing refuses the weak test KDF', async () => {
    const { header } = await vault()
    expect(() => parseHeader(clone(header))).toThrow(BadHeader)
  })
})

describe('tampering', () => {
  const pw = 'correct horse battery'

  it('every field tampered fails with WrongSecret or BadHeader', async () => {
    const { header, recoveryKey } = await vault(pw)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each case reaches into a deliberately malformed header
    const mutations: [string, (h: Record<string, any>) => void][] = [
      ['format', (h) => (h.format = 'slate-vaulx')],
      ['version', (h) => (h.version = 1)],
      ['version 3', (h) => (h.version = 3)],
      ['profile', (h) => (h.profile = 'fips-140-3')],
      ['profile unknown', (h) => (h.profile = 'fips')],
      ['suite', (h) => (h.suite = 1)],
      ['suite reserved', (h) => (h.suite = 3)],
      ['keyEpoch', (h) => (h.keyEpoch = 1)],
      ['keyEpoch negative', (h) => (h.keyEpoch = -1)],
      ['kdf.alg', (h) => (h.kdf.alg = 'pbkdf2-hmac-sha512')],
      ['password.alg', (h) => (h.wraps.password.alg = 'aes-256-gcm-siv')],
      ['history', (h) => (h.history = [{ epoch: 0, alg: 'aes-256-gcm', nonce: h.wraps.password.nonce, ct: h.wraps.password.ct }])],
      ['vaultId', (h) => (h.vaultId = h.vaultId.replace(/^./, (c: string) => (c === 'a' ? 'b' : 'a')))],
      ['revision', (h) => (h.revision += 1)],
      ['revision 0', (h) => (h.revision = 0)],
      ['createdAt', (h) => (h.createdAt += 1)],
      ['kdf.memoryKiB', (h) => (h.kdf.memoryKiB += 8)],
      ['kdf.passes', (h) => (h.kdf.passes += 1)],
      ['kdf.parallelism', (h) => (h.kdf.parallelism = 2)],
      ['kdf.salt', (h) => (h.kdf.salt = Buffer.alloc(16, 9).toString('base64'))],
      ['kdf extra key', (h) => (h.kdf.extra = 1)],
      ['password.nonce', (h) => (h.wraps.password.nonce = Buffer.alloc(12, 3).toString('base64'))],
      ['password.ct', (h) => (h.wraps.password.ct = flipB64(h.wraps.password.ct))],
      ['recovery.nonce', (h) => (h.wraps.recovery.nonce = Buffer.alloc(12, 3).toString('base64'))],
      ['recovery.ct', (h) => (h.wraps.recovery.ct = flipB64(h.wraps.recovery.ct))],
      ['check', (h) => (h.check = flipB64(h.check))],
      ['check short', (h) => (h.check = Buffer.alloc(31).toString('base64'))],
      ['extra top key', (h) => (h.extra = 1)],
      ['extra slot', (h) => (h.wraps.quick = h.wraps.password)],
      ['missing check', (h) => delete h.check],
      ['ct as number', (h) => (h.wraps.password.ct = 5)],
    ]
    for (const [label, mutate] of mutations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above: a header any case may break
      const h = clone(header) as Record<string, any>
      mutate(h)
      let parsed: VaultHeader
      try {
        parsed = parseHeader(h, weak)
      } catch (e) {
        expect(e, label).toBeInstanceOf(BadHeader)
        continue
      }
      await expect(unlockWithPassword(parsed, secretBytes(pw), weak), label).rejects.toThrow(WrongSecret)
      expect(() => unlockWithRecovery(parsed, secretBytes(recoveryKey!)), label).toThrow(WrongSecret)
    }
  })

  it('swapping the slots or moving a slot to another vault fails', async () => {
    const a = await vault(pw)
    const b = await vault(pw)
    const swapped = clone(a.header)
    swapped.wraps = { password: a.header.wraps.recovery!, recovery: a.header.wraps.password }
    await expect(unlockWithPassword(swapped, secretBytes(pw), weak)).rejects.toThrow(WrongSecret)
    expect(() => unlockWithRecovery(swapped, secretBytes(a.recoveryKey!))).toThrow(WrongSecret)
    const moved = clone(b.header)
    moved.wraps = clone(a.header.wraps)
    await expect(unlockWithPassword(moved, secretBytes(pw), weak)).rejects.toThrow(WrongSecret)
    expect(() => unlockWithRecovery(moved, secretBytes(a.recoveryKey!))).toThrow(WrongSecret)
  })

  it('a bad wrap and a bad check give the same error message', async () => {
    const { header } = await vault(pw)
    const badCheck = { ...clone(header), check: flipB64(header.check) }
    const e1 = await unlockWithPassword(header, secretBytes('nope nope nope'), weak).catch((e: Error) => e)
    const e2 = await unlockWithPassword(badCheck, secretBytes(pw), weak).catch((e: Error) => e)
    expect(e1).toBeInstanceOf(WrongSecret)
    expect(e2).toBeInstanceOf(WrongSecret)
    expect((e1 as Error).message).toBe((e2 as Error).message)
  })
})

describe('changes and choosing a base', () => {
  const pw = 'correct horse battery'

  it('changePassword bumps the revision, keeps MK and the recovery key', async () => {
    const { header, mk, recoveryKey } = await vault(pw)
    const next = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(pw) }, weak), secretBytes('a whole new password'), weak)
    expect(next.revision).toBe(2)
    expect(next.vaultId).toBe(header.vaultId)
    await expect(unlockWithPassword(next, secretBytes(pw), weak)).rejects.toThrow(WrongSecret)
    expect(sameMaster(await unlockWithPassword(next, secretBytes('a whole new password'), weak), mk)).toBe(true)
    expect(sameMaster(unlockWithRecovery(next, secretBytes(recoveryKey!)), mk)).toBe(true)
  })

  it('newRecoveryKey bumps the revision and retires the old key', async () => {
    const { header, mk, recoveryKey } = await vault(pw)
    const { header: next, recoveryKey: fresh } = newRecoveryKey(header, mk, await proveSecret(header, { password: secretBytes(pw) }, weak))
    expect(next.revision).toBe(2)
    expect(fresh).not.toBe(recoveryKey)
    expect(() => unlockWithRecovery(next, secretBytes(recoveryKey!))).toThrow(WrongSecret)
    expect(sameMaster(unlockWithRecovery(next, secretBytes(fresh)), mk)).toBe(true)
    expect(sameMaster(await unlockWithPassword(next, secretBytes(pw), weak), mk)).toBe(true)
  })

  it('refuses to build on a header that does not verify under MK', async () => {
    const a = await vault(pw)
    const b = await vault(pw)
    const proof = await proveSecret(a.header, { password: secretBytes(pw) }, weak)
    await expect(changePassword(a.header, b.mk, proof, secretBytes('another password!'), weak)).rejects.toThrow(WrongSecret)
    expect(() => newRecoveryKey(a.header, b.mk, proof)).toThrow(WrongSecret)
  })

  it('chooseBase picks the highest verified revision', async () => {
    const { header, mk } = await vault(pw)
    const r2 = newRecoveryKey(header, mk, await proveSecret(header, { password: secretBytes(pw) }, weak)).header
    expect(chooseBase(header, undefined, mk)).toBe(header)
    expect(chooseBase(header, r2, mk)).toBe(r2)
    expect(chooseBase(r2, header, mk)).toBe(r2)
    const forged = { ...clone(r2), revision: 9 }
    expect(chooseBase(header, forged, mk)).toBe(header)
    const other = await vault(pw)
    expect(chooseBase(header, newRecoveryKey(other.header, other.mk, await proveSecret(other.header, { password: secretBytes(pw) }, weak)).header, mk)).toBe(header)
    expect(() => chooseBase(other.header, undefined, mk)).toThrow(WrongSecret)
  })
})

// ---- PQ-B1: header v3 (docs/reviews/quantum-proof-roadmap.md §3.2-§3.4) ----

const FIXTURES = join(__dirname, 'fixtures', 'pq')
const DEVICE = 'device-11111111-1111-4111-8111-111111111111'
const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64')
const slot768 = () => ({ alg: 'mlkem768-x25519-kdf56c' as const, pkHash: b64(32, 3), kemCt: b64(1088, 4), ecdhPub: b64(32, 5), nonce: b64(12, 6), ct: b64(48, 7), addedAt: 1761200000000, addedBy: '22222222-2222-4222-8222-222222222222' })
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const total = (c: NativeCalls) => [...c.values()].reduce((a, b) => a + b, 0)

/** The native calls `fn` makes, by name, and what it threw. */
async function pathOf(fn: () => unknown): Promise<{ error: unknown; calls: Map<string, number> }> {
  const before = new Map(calls)
  let error: unknown = null
  try {
    const r = await fn()
    if (r) destroyKey(r as KeyHandle)
  } catch (e) {
    error = e
  }
  const diff = new Map<string, number>()
  for (const [k, v] of calls) if (v !== (before.get(k) ?? 0)) diff.set(k, v - (before.get(k) ?? 0))
  return { error, calls: diff }
}

/** A header's `check` recomputed under `mk`, as a writer of device slots (PQ-B6) would: K_check over JCS of the rest. */
function remac<H extends VaultHeader>(h: H, mk: KeyHandle): H {
  const { check: _drop, ...rest } = h
  const k = deriveSubkey(mk, 'check', scheduleOf(h))
  try {
    return { ...h, check: toBase64(vaultNative().hmacSha256(k, utf8(canonicalJson(rest)))) }
  } finally {
    destroyKey(k)
  }
}

async function v3Vault(pw = 'correct horse battery') {
  const made = await vault(pw)
  return { ...made, v2: made.header, header: buildHeaderV3From(made.header, made.mk) }
}

/** A v3 header holding one schema-valid device slot, MACed under the vault's MK. */
async function v3WithSlot(pw = 'correct horse battery') {
  const made = await v3Vault(pw)
  const h = clone(made.header) as VaultHeaderV3 & { wraps: Record<string, unknown> }
  h.wraps[DEVICE] = slot768()
  h.pq.minCapability = 2
  return { ...made, header: parseHeader(remac(h, made.mk), weak) as VaultHeaderV3 }
}

describe('PQ-B1: header v3', () => {
  it('T-PQ-B1-01: every fixtures/pq/valid-*.json parses, and each invalid-*.json is BadHeader', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
    const valid = files.filter((f) => f.startsWith('valid-'))
    const invalid = files.filter((f) => f.startsWith('invalid-'))
    expect(valid.length).toBeGreaterThanOrEqual(5)
    expect(invalid.length).toBeGreaterThanOrEqual(30)
    expect(valid.length + invalid.length).toBe(files.length)
    for (const f of valid) {
      const doc = fixture(f)
      expect(canonicalJson(parseHeader(clone(doc))), f).toBe(canonicalJson(doc))
      expect(canonicalJson(parseHeaderV3(clone(doc))), f).toBe(canonicalJson(doc))
    }
    for (const f of invalid) {
      expect(() => parseHeader(fixture(f)), f).toThrow(BadHeader)
      expect(() => parseHeaderV3(fixture(f)), f).toThrow(BadHeader)
    }
  })

  it('T-PQ-B1-02: buildHeaderV3From(v2) keeps the password and recovery wraps byte-identical and unlocks with both v2 secrets', async () => {
    const { v2, header, mk, recoveryKey } = await v3Vault()
    expect(header).toMatchObject({ version: 3, revision: v2.revision + 1, pq: { kem: 'hybrid-only', minCapability: 1 } })
    expect(canonicalJson(header.wraps.password)).toBe(canonicalJson(v2.wraps.password))
    expect(canonicalJson(header.wraps.recovery)).toBe(canonicalJson(v2.wraps.recovery))
    for (const k of ['vaultId', 'createdAt', 'profile', 'suite', 'keyEpoch', 'kdf'] as const) expect(canonicalJson(header[k]), k).toBe(canonicalJson(v2[k]))
    expect(Object.keys(header.wraps).sort()).toEqual(['password', 'recovery'])
    expect(verifyCheck(header, mk)).toBe(true)
    expect(parseHeader(clone(header), weak)).toEqual(header)
    expect(sameMaster(await unlockWithPassword(header, secretBytes('correct horse battery'), weak), mk)).toBe(true)
    expect(sameMaster(unlockWithRecovery(header, secretBytes(recoveryKey!)), mk)).toBe(true)
    // The v2 header is not changed, and a v3 build from a header MK does not verify is refused.
    expect(v2.version).toBe(2)
    const other = await vault()
    expect(() => buildHeaderV3From(v2, other.mk)).toThrow(WrongSecret)
  })

  it('T-PQ-B1-03: a tampered v3 field fails check with the same error and native path as a wrong password', async () => {
    const pw = 'correct horse battery'
    const { header, recoveryKey } = await v3WithSlot(pw)
    const wrong = await pathOf(() => unlockWithPassword(header, secretBytes('not the password'), weak))
    expect(wrong.error).toBeInstanceOf(WrongSecret)
    const flipKemCt = (s: string) => {
      const b = Buffer.from(s, 'base64')
      b[100] = b[100]! ^ 1
      return b.toString('base64')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each case reaches into a header it then re-parses
    const tampers: [string, (h: Record<string, any>) => void][] = [
      ['pq.minCapability', (h) => (h.pq.minCapability = 3)],
      ['version (rolled back to v2)', (h) => ((h.version = 2), delete h.pq, delete h.wraps[DEVICE])],
      ['a device slot byte', (h) => (h.wraps[DEVICE].kemCt = flipKemCt(h.wraps[DEVICE].kemCt))],
      ['a device slot addedAt', (h) => (h.wraps[DEVICE].addedAt += 1)],
      ['a device slot removed', (h) => ((h.pq.minCapability = 1), delete h.wraps[DEVICE])],
    ]
    for (const [label, tamper] of tampers) {
      const h = clone(header) as unknown as Record<string, unknown>
      tamper(h)
      const parsed = parseHeader(h, weak)
      const bad = await pathOf(() => unlockWithPassword(parsed, secretBytes(pw), weak))
      expect(bad.error, label).toBeInstanceOf(WrongSecret)
      expect((bad.error as Error).message, label).toBe((wrong.error as Error).message)
      // The same work either way: one key derivation, one unwrap, one check MAC. Only the stand-in for an MK that
      // did not unwrap (keyRandom) is the wrong password's alone.
      const { keyRandom: _k, ...wrongWork } = Object.fromEntries(wrong.calls)
      expect(Object.fromEntries(bad.calls), label).toEqual(wrongWork)
      expect(() => unlockWithRecovery(parsed, secretBytes(recoveryKey!)), label).toThrow(WrongSecret)
    }
  })

  it('T-PQ-B1-04: a device slot with a classical-only alg is BadHeader (INV-PQ-1)', () => {
    for (const alg of ['x25519-kdf56c', 'rsa-oaep-sha256', 'p384-kdf56c', 'mlkem768', '']) {
      const h = fixture('valid-standard-mlkem768-slot.json') as { wraps: Record<string, { alg: string }> }
      h.wraps[DEVICE]!.alg = alg
      expect(() => parseHeader(h), alg).toThrow(BadHeader)
    }
  })

  it('T-PQ-B1-05: 17 device slots (with or without the recovery wrap), or a header over 64 KiB, is BadHeader with zero native calls', () => {
    const many = (n: number) => {
      const h = fixture('valid-standard-mlkem768-slot.json') as { wraps: Record<string, unknown> }
      delete h.wraps[DEVICE]
      for (let i = 0; i < n; i++) h.wraps[`device-${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`] = slot768()
      return h
    }
    expect(Object.keys(parseHeader(many(16)).wraps)).toHaveLength(18)
    const before = total(calls)
    expect(() => parseHeader(many(17))).toThrow(BadHeader)
    // 17 slots and the password wrap alone are 18 wraps, which the schema allows; §3.2's 16-slot cap refuses them.
    const passwordOnly = many(17) as { wraps: Record<string, unknown> }
    delete passwordOnly.wraps.recovery
    expect(Object.keys(passwordOnly.wraps)).toHaveLength(18)
    expect(() => parseHeader(passwordOnly)).toThrow(BadHeader)
    const big = fixture('valid-standard.json')
    expect(() => parseHeader({ ...big, kdf: { ...(big.kdf as object), salt: 'A'.repeat(70_000) } })).toThrow(BadHeader)
    expect(() => parseHeader({ ...big, padding: 'A'.repeat(70_000) })).toThrow(BadHeader)
    expect(() => parseHeaderV3(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 'x'.repeat(16)])))).toThrow(BadHeader)
    expect(total(calls)).toBe(before)
  })

  it('T-PQ-B1-06: version 4 is BadHeader before any derivation', async () => {
    const { header } = await v3Vault()
    const before = total(calls)
    for (const version of [4, 0, -3, '3', 3.5, null]) expect(() => parseHeader({ ...clone(header), version }, weak), String(version)).toThrow(BadHeader)
    expect(total(calls)).toBe(before)
  })

  it('T-PQ-B1-07: a password change and a new recovery key on a v3 header keep its device slot byte-identical (rule 10)', async () => {
    const pw = 'correct horse battery'
    const { header, mk } = await v3WithSlot(pw)
    const changed = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(pw) }, weak), secretBytes('a whole new password'), weak)
    expect(changed).toMatchObject({ version: 3, revision: header.revision + 1, pq: header.pq })
    expect(canonicalJson(changed.wraps[DEVICE as `device-${string}`])).toBe(canonicalJson(header.wraps[DEVICE as `device-${string}`]))
    expect(parseHeader(clone(changed), weak)).toEqual(changed)
    expect(sameMaster(await unlockWithPassword(changed, secretBytes('a whole new password'), weak), mk)).toBe(true)
    const { header: rec } = newRecoveryKey(changed, mk, await proveSecret(changed, { password: secretBytes('a whole new password') }, weak))
    expect(canonicalJson(rec.wraps[DEVICE as `device-${string}`])).toBe(canonicalJson(header.wraps[DEVICE as `device-${string}`]))
    expect(verifyCheck(rec, mk)).toBe(true)
  })

  it('v3 and v2 hold the same keys: neither is newer keys than the other, and v2 under a v3 floor is a downgrade (INV-PQ-4)', async () => {
    const { v2, header } = await v3Vault()
    expect(isNewerKeys(header, v2)).toBe(false)
    expect(isNewerKeys(v2, header)).toBe(false)
    expect(isDowngrade(v2, floorOf(header))).toBe(true)
    expect(isDowngrade(header, floorOf(v2))).toBe(false)
    expect(floorOf(header)).toEqual({ version: 3, profile: 'standard', keyEpoch: 0 })
  })

  it('T-PQ-B4-05: rekeyHeader keeps a v3 base at v3 (it refused one until PQ-B4); an upgrade of it is still refused', async () => {
    const pw = 'correct horse battery'
    const { header, mk } = await v3WithSlot(pw)
    const proof = await proveSecret(header, { password: secretBytes(pw) }, weak)
    const kdf = { ...header.kdf, salt: Buffer.alloc(16, 9).toString('base64') }
    await expect(rekeyHeader({ kind: 'upgrade', base: header, mk, proof, password: secretBytes(pw), kdf, profile: 'standard' }, weak)).rejects.toThrow(RotationRefused)
    const r = await rekeyHeader({ kind: 'rotate', base: header, mk, proof, password: secretBytes(pw), kdf, profile: 'standard' }, weak)
    destroyKey(proof.kek)
    expect(r.header).toMatchObject({ version: 3, keyEpoch: 1, pq: header.pq })
    expect(canonicalJson((r.header as VaultHeaderV3).wraps[DEVICE as `device-${string}`])).toBe(canonicalJson(header.wraps[DEVICE as `device-${string}`]))
    expect(parseHeader(JSON.parse(JSON.stringify(r.header)), weak)).toEqual(r.header)
    for (const k of [mk, r.mk]) destroyKey(k)
  })
})

function flipB64(s: string): string {
  const b = Buffer.from(s, 'base64')
  b[0] = b[0]! ^ 1
  return b.toString('base64')
}

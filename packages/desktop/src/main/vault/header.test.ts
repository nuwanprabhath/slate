import { describe, expect, it } from 'vitest'
import { sameMaster } from '../../../test/vaultKeys'
import { encodeRecovery } from './recovery'
import { proveSecret, BadHeader, WrongSecret, canonicalJson, changePassword, chooseBase, createVault, newRecoveryKey, parseHeader, unlockWithPassword, unlockWithRecovery, verifyCheck, type VaultHeader } from './header'
import { secretBytes } from '../../shared/secret'

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

function flipB64(s: string): string {
  const b = Buffer.from(s, 'base64')
  b[0] = b[0]! ^ 1
  return b.toString('base64')
}

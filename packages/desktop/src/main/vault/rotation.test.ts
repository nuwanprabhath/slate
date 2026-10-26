// C9 (audit §4.7 R-1 … R-5): a key rotation builds header v2 under a fresh master key at the next epoch, with the
// old master key in `history` under K_hist; a conversion to fips-140-3 empties `history`; pruning drops an epoch.
import { describe, expect, it } from 'vitest'
import { sameMaster } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'
import {
  createVault,
  isNewerKeys,
  openHistory,
  parseHeader,
  proveSecret,
  pruneHistory,
  rekeyHeader,
  RotationRefused,
  unlockWithPassword,
  unlockWithRecovery,
  verifyCheck,
  WrongSecret,
  type VaultHeaderV2,
} from './header'
import { destroyKey } from './native'
import { encodeRecovery } from './recovery'

const weak = { allowWeakForTests: true }
const PW = 'correct horse battery'
const argon = () => ({ alg: 'argon2id' as const, memoryKiB: 64, passes: 1, parallelism: 1 as const, salt: Buffer.alloc(16, 7).toString('base64') })

async function vault() {
  return createVault({ password: secretBytes(PW), kdf: { memoryKiB: 64, passes: 1 } }, weak)
}

async function rotate(base: VaultHeaderV2 | Awaited<ReturnType<typeof vault>>['header'], mk: Parameters<typeof verifyCheck>[1]) {
  const proof = await proveSecret(base, { password: secretBytes(PW) }, weak)
  try {
    return await rekeyHeader({ kind: 'rotate', base, mk, proof, password: secretBytes(PW), kdf: argon(), profile: 'standard' }, weak)
  } finally {
    destroyKey(proof.kek)
  }
}

describe('C9 rekeyHeader: rotation (R-1)', () => {
  it('rotation round trip: the next epoch under a fresh MK, a new recovery key, the old MK in history', async () => {
    const v = await vault()
    const r = await rotate(v.header, v.mk)
    expect(r.header).toMatchObject({ version: 2, keyEpoch: 1, revision: 2, profile: 'standard', vaultId: v.header.vaultId })
    expect(r.header.history?.map((h) => h.epoch)).toEqual([0])
    // The password is unchanged; the salt is fresh, so the password wrap is new.
    expect(r.header.kdf.salt).not.toBe(v.header.kdf.salt)
    expect(parseHeader(JSON.parse(JSON.stringify(r.header)), weak)).toEqual(r.header)
    const byPassword = await unlockWithPassword(r.header, secretBytes(PW), weak)
    expect(sameMaster(byPassword, r.mk)).toBe(true)
    expect(sameMaster(byPassword, v.mk)).toBe(false)
    expect(sameMaster(unlockWithRecovery(r.header, secretBytes(r.recoveryKey)), r.mk)).toBe(true)
    // The old recovery key no longer opens the new header: its slot could not be rewrapped.
    expect(() => unlockWithRecovery(r.header, secretBytes(v.recoveryKey!))).toThrow(WrongSecret)
    const hist = openHistory(r.header, r.mk)
    expect([...hist.keys()]).toEqual([0])
    expect(sameMaster(hist.get(0)!.mk, v.mk)).toBe(true)
    expect(hist.get(0)!.schedule).toMatchObject({ suite: 2, keyEpoch: 0 })
    for (const k of [byPassword, v.mk, r.mk, ...[...hist.values()].map((h) => h.mk)]) destroyKey(k)
  })

  it('a second rotation rewraps the older entries under the newest master key', async () => {
    const v = await vault()
    const r1 = await rotate(v.header, v.mk)
    const r2 = await rotate(r1.header, r1.mk)
    expect(r2.header.keyEpoch).toBe(2)
    expect(r2.header.history?.map((h) => h.epoch).sort()).toEqual([0, 1])
    const hist = openHistory(r2.header, r2.mk)
    expect(sameMaster(hist.get(0)!.mk, v.mk)).toBe(true)
    expect(sameMaster(hist.get(1)!.mk, r1.mk)).toBe(true)
    // Not openable under the older epoch's key: K_hist belongs to the current master key.
    expect(openHistory(r2.header, r1.mk).size).toBe(0)
    for (const k of [v.mk, r1.mk, r2.mk, ...[...hist.values()].map((h) => h.mk)]) destroyKey(k)
  })

  it('history holds at most four epochs: a fifth rotation is refused until one is pruned', async () => {
    const v = await vault()
    let cur = { header: v.header as VaultHeaderV2, mk: v.mk }
    for (let i = 0; i < 4; i++) {
      const next = await rotate(cur.header, cur.mk)
      destroyKey(cur.mk)
      cur = next
    }
    expect(cur.header.history).toHaveLength(4)
    await expect(rotate(cur.header, cur.mk)).rejects.toThrow(RotationRefused)
    const pruned = pruneHistory(cur.header, cur.mk, [0])
    expect(pruned.history?.map((h) => h.epoch).sort()).toEqual([1, 2, 3])
    const next = await rotate(pruned, cur.mk)
    expect(next.header.history).toHaveLength(4)
    for (const k of [cur.mk, next.mk]) destroyKey(k)
  })

  it('history pruning drops the epoch, raises the revision and keeps the header verified', async () => {
    const v = await vault()
    const r = await rotate(v.header, v.mk)
    const pruned = pruneHistory(r.header, r.mk, [0])
    expect(pruned.history).toBeUndefined()
    expect(pruned.revision).toBe(r.header.revision + 1)
    expect(verifyCheck(pruned, r.mk)).toBe(true)
    expect(parseHeader(JSON.parse(JSON.stringify(pruned)), weak)).toEqual(pruned)
    expect(() => pruneHistory(r.header, v.mk, [0])).toThrow(WrongSecret)
    for (const k of [v.mk, r.mk]) destroyKey(k)
  })

  it('a proof of another vault, or of the wrong secret, is refused before anything is written', async () => {
    const v = await vault()
    await expect(proveSecret(v.header, { password: secretBytes('wrong horse battery') }, weak)).rejects.toThrow(WrongSecret)
    const other = await vault()
    const proof = await proveSecret(other.header, { password: secretBytes(PW) }, weak)
    await expect(rekeyHeader({ kind: 'rotate', base: v.header, mk: v.mk, proof, password: secretBytes(PW), kdf: argon(), profile: 'standard' }, weak)).rejects.toThrow()
    destroyKey(proof.kek)
    expect(() => unlockWithRecovery(v.header, secretBytes(encodeRecovery(Buffer.alloc(32, 3))))).toThrow(WrongSecret)
    for (const k of [v.mk, other.mk]) destroyKey(k)
  })

  it('downgrade refused: a rekey never lowers the profile, and only rotate keeps history', async () => {
    const v = await vault()
    const proof = await proveSecret(v.header, { password: secretBytes(PW) }, weak)
    // standard → standard as a "convert" is not a conversion.
    await expect(rekeyHeader({ kind: 'convert', base: v.header, mk: v.mk, proof, password: secretBytes(PW), kdf: argon(), profile: 'standard' }, weak)).rejects.toThrow(RotationRefused)
    // A rotation that names another profile is refused (R-3 is the only profile move).
    await expect(
      rekeyHeader({ kind: 'rotate', base: v.header, mk: v.mk, proof, password: secretBytes(PW), kdf: { alg: 'pbkdf2-hmac-sha512', iterations: 1000, salt: Buffer.alloc(32, 1).toString('base64') }, profile: 'fips-140-3' }, weak),
    ).rejects.toThrow(RotationRefused)
    destroyKey(proof.kek)
    destroyKey(v.mk)
  })

  it('isNewerKeys: a later epoch, header version or profile; never an older one', async () => {
    const v = await vault()
    const r = await rotate(v.header, v.mk)
    expect(isNewerKeys(r.header, v.header)).toBe(true)
    expect(isNewerKeys(v.header, r.header)).toBe(false)
    expect(isNewerKeys(v.header, v.header)).toBe(false)
    expect(isNewerKeys({ ...v.header, profile: 'fips-140-3' }, v.header)).toBe(true)
    for (const k of [v.mk, r.mk]) destroyKey(k)
  })

  it('R-3: converting to fips-140-3 empties history and switches the KDF to PBKDF2', async () => {
    const v = await vault()
    const r1 = await rotate(v.header, v.mk)
    const proof = await proveSecret(r1.header, { password: secretBytes(PW) }, weak)
    const fipsPw = 'a much longer passphrase here'
    const kdf = { alg: 'pbkdf2-hmac-sha512' as const, iterations: 1000, salt: Buffer.alloc(32, 9).toString('base64') }
    const c = await rekeyHeader({ kind: 'convert', base: r1.header, mk: r1.mk, proof, password: secretBytes(fipsPw), kdf, profile: 'fips-140-3' }, weak)
    destroyKey(proof.kek)
    expect(c.header).toMatchObject({ profile: 'fips-140-3', keyEpoch: 2, revision: 3 })
    expect(c.header.kdf.alg).toBe('pbkdf2-hmac-sha512')
    expect(c.header.history).toBeUndefined()
    expect(sameMaster(await unlockWithPassword(c.header, secretBytes(fipsPw), weak), c.mk)).toBe(true)
    await expect(unlockWithPassword(c.header, secretBytes(PW), weak)).rejects.toThrow(WrongSecret)
    for (const k of [v.mk, r1.mk, c.mk]) destroyKey(k)
  })
})

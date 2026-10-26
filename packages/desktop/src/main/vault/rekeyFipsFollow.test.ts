// C9 R-3 on another device: a standard device follows its vault's conversion to fips-140-3 (the only cross-profile
// move: a rejoin of the same vault, upwards), with the new password, and never latches on the strength of a header
// that has not verified. Its own file: following latches the module approved-only for the process (C5).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secretBytes } from '../../shared/secret'
import { writeJsonAtomic } from './atomic'
import { parseHeader, proveSecret, rekeyHeader } from './header'
import { kdfForProfile } from './kdf'
import { Migration, type MigrationDeps } from './migration'
import { destroyKey, vaultNative } from './native'
import type { VaultRemote } from './remoteVault'
import { createEncryptedDataDir, storeWithLk } from './testVault'
import { AdoptWithOldSecret, CANDIDATE_FILE, UnlockFailed, unlockVault, VAULT_FILE } from './unlock'
import { readJsonCapped } from './atomic'

vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery staple'
const FIPS_PASSWORD = 'a fifteen-plus character passphrase'
let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('C9 R-3: a device that missed the conversion', () => {
  it('unlocks with its old password, is asked for the new one, and follows into fips-140-3', async () => {
    dir = mkdtempSync(join(tmpdir(), 'slate-follow-'))
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir)
    destroyKey((await createEncryptedDataDir(dataDir, secretBytes(PASSWORD), weak)).mk)
    // Device A converted the vault (made here without latching this process, as A's own process would).
    const base = parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), weak)
    const own = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    const proof = await proveSecret(base, { password: secretBytes(PASSWORD) }, weak)
    const converted = await rekeyHeader({ kind: 'convert', base, mk: own.keyRing.get('mk'), proof, password: secretBytes(FIPS_PASSWORD), kdf: await kdfForProfile('fips-140-3', { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 }), profile: 'fips-140-3' }, weak)
    destroyKey(proof.kek)
    destroyKey(converted.mk)
    own.keyRing.close()
    const remote: VaultRemote = { read: async () => ({ header: converted.header, version: 'v2', otherFiles: [] }), claim: async () => false, writeHeader: async () => false }
    // The sync check left it as the candidate (review C9 L1: never the pending header, unverified).
    await writeJsonAtomic(join(dataDir, CANDIDATE_FILE), converted.header)

    // The new password opens only the converted header, whose history is empty: refused with what to do, no latch.
    await expect(unlockVault(dataDir, { password: secretBytes(FIPS_PASSWORD) }, weak)).rejects.toThrow(AdoptWithOldSecret)
    expect(vaultNative().status().approvedKeysOnly).toBe(false)

    const u = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    expect(u.adopt).toMatchObject({ profile: 'fips-140-3' })
    const stores: Array<{ close(): void }> = []
    const deps: MigrationDeps = {
      dataDir,
      kdfOpts: weak,
      remote: () => remote,
      closeServices: async () => {},
      reopenPlaintext: () => {},
      openServices: (keyRing, dbFile) => {
        const store = storeWithLk(keyRing, dbFile)
        stores.push(store)
        return { store }
      },
    }
    const m = new Migration(deps)
    // The old password does not open the converted header: nothing changes, nothing latches.
    await expect(m.rejoin(u.keyRing, { password: secretBytes(PASSWORD) }, u.adopt)).rejects.toThrow(UnlockFailed)
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
    const next = await m.rejoin(u.keyRing, { password: secretBytes(FIPS_PASSWORD) })
    for (const s of stores) s.close()
    expect(vaultNative().status().approvedKeysOnly).toBe(true)
    expect(next.schedule).toMatchObject({ profile: 'fips-140-3', keyEpoch: 1 })
    next.close()
    expect(readdirSync(dataDir).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))).toHaveLength(1)
    const again = await unlockVault(dataDir, { password: secretBytes(FIPS_PASSWORD) }, weak)
    expect(again.keyRing.schedule.profile).toBe('fips-140-3')
    again.keyRing.close()
  })
})

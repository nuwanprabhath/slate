// Review C5 M1: a header nobody has verified never latches the process approved-only, and a rejoin across
// profiles is refused before any latch or derivation. A standard device here; the fips-140-3 device's side
// is rejoinProfilesFips.test.ts (the latch is one-way per process, and vitest runs each file in its own).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { spyOnNative } from '../../../test/nativeSpy'
import { createVault, type VaultHeader } from './header'
import { Migration, type MigrationDeps } from './migration'
import { destroyKey, vaultNative } from './native'
import { ProfileMismatch } from './profile'
import type { VaultRemote } from './remoteVault'
import { createEncryptedDataDir } from './testVault'
import { PENDING_FILE, unlockVault } from './unlock'

const calls = spyOnNative()
const weak = { allowWeakForTests: true }
const PASSWORD = 'the standard device password'

const remoteOf = (header: unknown): VaultRemote =>
  ({ read: async () => ({ header, version: 'v1', otherFiles: [] }), claim: async () => false, writeHeader: async () => false }) as unknown as VaultRemote

async function standardDevice() {
  const dataDir = mkdtempSync(join(tmpdir(), 'slate-rejoin-std-'))
  destroyKey((await createEncryptedDataDir(dataDir, secretBytes(PASSWORD), weak)).mk)
  const { keyRing } = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
  return { dataDir, keyRing }
}

function migration(dataDir: string, remote: VaultRemote): Migration {
  return new Migration({ dataDir, kdfOpts: weak, remote: () => remote, closeServices: async () => {}, openServices: () => { throw new Error('not reached') } } as unknown as MigrationDeps)
}

async function fipsHeader(): Promise<VaultHeader> {
  // createVault does not latch (review C5 M1): a vault is committed, and the latch set, only where it is used.
  const made = await createVault({ password: secretBytes('a fips vault password'), profile: 'fips-140-3', kdf: { alg: 'pbkdf2-hmac-sha512', iterations: 1000, salt: Buffer.alloc(32, 3).toString('base64') } }, weak)
  destroyKey(made.mk)
  return made.header
}

describe('review C5 M1: no latch from an unverified header (standard device)', () => {
  it('creating a fips-140-3 vault in memory (the wizard before it commits) does not latch the process', async () => {
    await fipsHeader()
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
  })

  it('a forged fips-140-3 header on the remote: the rejoin is refused up front, nothing derived, the latch stays off, and the own vault still unlocks', async () => {
    const { dataDir, keyRing } = await standardDevice()
    const forged = { ...(await fipsHeader()), vaultId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }
    const before = calls.get('pbkdf2Async') ?? 0
    const err = await migration(dataDir, remoteOf(forged)).rejoin(keyRing, { password: secretBytes(PASSWORD) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProfileMismatch)
    expect((err as Error).message).toMatch(/FIPS 140-3/)
    expect(calls.get('pbkdf2Async') ?? 0).toBe(before)
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
    keyRing.close()
    const again = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    again.keyRing.close()
  })

  it('a real fips-140-3 vault on the remote, with its right password: refused the same way, before the latch', async () => {
    const { dataDir, keyRing } = await standardDevice()
    const header = await fipsHeader()
    await expect(migration(dataDir, remoteOf(header)).rejoin(keyRing, { password: secretBytes('a fips vault password') })).rejects.toThrow(ProfileMismatch)
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
    keyRing.close()
  })

  it('a forged fips-140-3 pending header at unlock: the derivation fails, the latch stays off, and the standard vault unlocks without a false message', async () => {
    const { dataDir, keyRing } = await standardDevice()
    keyRing.close()
    const local = JSON.parse(JSON.stringify(await fipsHeader())) as Record<string, unknown>
    const { readFileSync } = await import('node:fs')
    const own = JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as { vaultId: string; revision: number }
    writeFileSync(join(dataDir, PENDING_FILE), JSON.stringify({ ...local, vaultId: own.vaultId, revision: own.revision + 5 }))
    await expect(unlockVault(dataDir, { password: secretBytes('not the password at all') }, weak)).rejects.toThrow("That password didn't work")
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
    const opened = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    opened.keyRing.close()
  })
})

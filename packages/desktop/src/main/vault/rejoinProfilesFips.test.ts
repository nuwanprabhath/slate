// Review C5 M1, the fips-140-3 device's side: a rejoin into a standard vault is refused up front with a message
// that says why, instead of ProfileLatched's "quit and reopen" (which could never help: rejoin needs the open ring).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { createVault } from './header'
import { Migration, type MigrationDeps } from './migration'
import { destroyKey, vaultNative } from './native'
import { ProfileMismatch } from './profile'
import type { VaultRemote } from './remoteVault'
import { createEncryptedDataDir } from './testVault'
import { unlockVault } from './unlock'

const weak = { allowWeakForTests: true }

describe('review C5 M1: a fips-140-3 device and a standard remote vault', () => {
  it('the latch is set only once the fips header verified, and a standard rejoin is refused before any derivation', async () => {
    const standard = await createVault({ password: secretBytes('a standard vault password'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    destroyKey(standard.mk)
    const dataDir = mkdtempSync(join(tmpdir(), 'slate-rejoin-fips-'))
    destroyKey((await createEncryptedDataDir(dataDir, secretBytes('the fips device password'), weak, 'fips-140-3')).mk)
    const { keyRing } = await unlockVault(dataDir, { password: secretBytes('the fips device password') }, weak)
    expect(vaultNative().status().approvedKeysOnly).toBe(true)
    const remote = { read: async () => ({ header: standard.header, version: 'v1', otherFiles: [] }) } as unknown as VaultRemote
    const m = new Migration({ dataDir, kdfOpts: weak, remote: () => remote } as unknown as MigrationDeps)
    const err = await m.rejoin(keyRing, { password: secretBytes('a standard vault password') }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProfileMismatch)
    expect((err as Error).message).toMatch(/standard/)
    keyRing.close()
  })
})

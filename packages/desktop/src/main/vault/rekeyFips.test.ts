// C9 R-3 and criterion 4: converting a standard vault to fips-140-3 (here straight from header v1) re-encrypts the
// notes under a fresh LK, empties `history` and leaves no suite-0x01 file on this device. Its own file: the
// conversion latches the module approved-only for the process (C5).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secretBytes } from '../../shared/secret'
import { parseHeader, type VaultHeaderV2 } from './header'
import { Migration, type MigrationDeps } from './migration'
import { vaultNative } from './native'
import { storeWithLk } from './testVault'
import { LOCAL_KEYS_FILE, PREUNLOCK_FILE, unlockVault, VAULT_FILE } from './unlock'

vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
const FIXTURES = join(__dirname, 'fixtures', 'c4')
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as { password: string }
const FIPS_PASSWORD = 'a fifteen-plus character passphrase'
let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('C9 R-3: standard to fips-140-3', () => {
  it('criterion 4: an empty history, a fips header v2, local files of version 2 only, and the new password', async () => {
    dir = mkdtempSync(join(tmpdir(), 'slate-convert-'))
    const dataDir = join(dir, 'data')
    cpSync(join(FIXTURES, 'data'), dataDir, { recursive: true })
    const u = await unlockVault(dataDir, { password: secretBytes(manifest.password) }, weak)
    const stores: Array<{ close(): void }> = []
    const deps: MigrationDeps = {
      dataDir,
      kdfOpts: weak,
      kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
      remote: () => null,
      closeServices: async () => {},
      reopenPlaintext: () => {},
      openServices: (keyRing, dbFile) => {
        const store = storeWithLk(keyRing, dbFile)
        stores.push(store)
        return { store }
      },
    }
    const m = new Migration(deps)
    await expect(m.prepareRekey(u.keyRing, 'convert', secretBytes(manifest.password), secretBytes('too short'))).rejects.toThrow()
    const { recoveryKey } = await m.prepareRekey(u.keyRing, 'convert', secretBytes(manifest.password), secretBytes(FIPS_PASSWORD))
    expect(await m.confirmRecovery(secretBytes(recoveryKey))).toBe(true)
    // Not latched until the notes are copied and the new pair is in place.
    expect(vaultNative().status().approvedKeysOnly).toBe(false)
    const next = await m.runRekey(u.keyRing)
    for (const s of stores) s.close()
    expect(vaultNative().status().approvedKeysOnly).toBe(true)
    const h = parseHeader(JSON.parse(readFileSync(join(dataDir, VAULT_FILE), 'utf8')), weak) as VaultHeaderV2
    expect(h).toMatchObject({ version: 2, profile: 'fips-140-3', suite: 2, keyEpoch: 1 })
    expect(h.kdf.alg).toBe('pbkdf2-hmac-sha512')
    expect(h.history).toBeUndefined()
    expect(next.historyEpochs).toEqual([])
    next.close()
    expect(JSON.parse(readFileSync(join(dataDir, LOCAL_KEYS_FILE), 'utf8'))).toMatchObject({ version: 2, profile: 'fips-140-3', keyEpoch: 1 })
    expect(JSON.parse(readFileSync(join(dataDir, PREUNLOCK_FILE), 'utf8'))).toMatchObject({ version: 2, profile: 'fips-140-3' })
    // Nothing of suite 0x01 is left here: no quick unlock (refused in fips-140-3), no v1 file, one database.
    expect(existsSync(join(dataDir, 'quick-unlock.bin'))).toBe(false)
    // profile-floor.json's own format is version 1 (audit §4.5.4); every vault-format file is version 2.
    for (const f of readdirSync(dataDir).filter((n) => n.endsWith('.json') && n !== 'profile-floor.json')) expect(JSON.parse(readFileSync(join(dataDir, f), 'utf8')).version, f).toBe(2)
    expect(JSON.parse(readFileSync(join(dataDir, 'profile-floor.json'), 'utf8'))).toMatchObject({ profile: 'fips-140-3', minHeaderVersion: 2 })
    expect(readdirSync(dataDir).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))).toHaveLength(1)
    await expect(unlockVault(dataDir, { password: secretBytes(manifest.password) }, weak)).rejects.toThrow()
    const again = await unlockVault(dataDir, { password: secretBytes(FIPS_PASSWORD) }, weak)
    expect(again.keyRing.schedule).toMatchObject({ profile: 'fips-140-3', keyEpoch: 1 })
    again.keyRing.close()
  })
})

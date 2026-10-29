// The fips-140-3 matrix (audit §4.1, C5 criterion 2): a fips-140-3 vault through creation, unlock by password
// and by recovery key, a password change, a new recovery key, sync (SLE2 and names), preunlock, the profile
// floor and quick unlock, with every call into @slate/native counted. It never reaches suite 0x01, Argon2id
// or RFC 5869 HKDF, and the module is latched approved-only from before the first key. This file runs in its
// own process (vitest isolates files), since the latch is one-way. Also T-POL-01, -05 and -06.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { isApprovedKey } from '@slate/native'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { memoryDrive } from '../../../../sync/test/memoryDrive'
import { spyOnNative } from '../../../test/nativeSpy'
import { log } from '../log/logger'
import { EncryptingDrive } from '../sync/encryptingDrive'
import { readJsonCapped } from './atomic'
import { changePassword, createVault, newRecoveryKey, parseHeader, proveSecret, destroyProof, profileOf, type VaultHeader } from './header'
import { checkPassword } from './password'
import { checkPreunlock, savePreunlock } from './preunlockSync'
import { HeaderRefused, PROFILE_FLOOR_FILE } from './profileFloor'
import { enableQuickUnlock, openQuickUnlock, QUICK_UNLOCK_FILE, QuickUnlockFailed, QuickUnlockNotAllowed, type QuickUnlockPlatform } from './quickUnlock'
import { createEncryptedDataDir, storeWithLk } from './testVault'
import { unlockVault, VAULT_FILE, LOCAL_KEYS_FILE } from './unlock'
import { destroyKey, vaultNative } from './native'
import { Migration, type MigrationDeps } from './migration'
import { runPqUpgrade } from './pqUpgrade'

const calls = spyOnNative()
const weak = { allowWeakForTests: true }
const PASSWORD = 'a fips profile password'
const LEGACY = ['hkdfLegacy', 'hkdfFromSecret', 'argon2id', 'argon2idAsync', 'aesEcbBlock']
const dirs: string[] = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'slate-fips-'))
  dirs.push(d)
  return d
}
const header = async (d: string): Promise<VaultHeader> => parseHeader(await readJsonCapped(join(d, VAULT_FILE)), weak)
const platform: QuickUnlockPlatform = {
  platform: 'linux',
  secrets: { available: async () => true, seal: async (s: string) => Buffer.from(s), open: async (b: Uint8Array) => ({ plain: Buffer.from(b).toString(), rewrite: false }) } as unknown as QuickUnlockPlatform['secrets'],
  systemPreferences: {},
}


describe('C5 criterion 2: a fips-140-3 vault never touches suite 0x01, Argon2id or hkdfLegacy', () => {
  it('the FIPS provider is active in this build (the profile needs it)', () => {
    expect(vaultNative().status().fipsActive).toBe(true)
  })

  it('creation, unlock by password and recovery key, password change, new recovery key, sync and preunlock', async () => {
    const d = dir()
    const made = await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')
    destroyKey(made.mk)
    expect(vaultNative().status().approvedKeysOnly).toBe(true)
    const h = await header(d)
    expect(h).toMatchObject({ version: 2, profile: 'fips-140-3', suite: 2 })
    expect(h.kdf.alg).toBe('pbkdf2-hmac-sha512')
    expect(Buffer.from(h.kdf.salt, 'base64')).toHaveLength(32)

    const byPassword = await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)
    for (const name of ['mk', 'lk', 'sync', 'nameEnc', 'nameMac', 'check', 'prefs', 'localwrap'] as const) expect(isApprovedKey(byPassword.keyRing.get(name)), name).toBe(true)
    // The database opens under the approved LK (SQLCipher refuses any other once latched).
    storeWithLk(byPassword.keyRing, byPassword.dbFile).close()

    const drive = new EncryptingDrive(memoryDrive(), byPassword.keyRing)
    const page = `docs/page_${randomUUID()}/${randomUUID()}/00000001.chunk`
    await drive.upload(page, new Uint8Array([1, 2, 3]))
    const listed = (await drive.delta(null)).items.map((i) => i.path)
    expect(listed).toEqual([page])
    expect(await drive.download(page)).toEqual(new Uint8Array([1, 2, 3]))

    const pre = join(d, 'preunlock.json')
    await savePreunlock(pre, DEFAULT_SETTINGS, byPassword.keyRing)
    expect(JSON.parse(readFileSync(pre, 'utf8'))).toMatchObject({ format: 'slate-preunlock', version: 2, profile: 'fips-140-3' })
    expect((await checkPreunlock(pre, DEFAULT_SETTINGS, byPassword.keyRing)).tampered).toBe(false)
    expect(JSON.parse(readFileSync(join(d, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ profile: 'fips-140-3', minHeaderVersion: 2 })

    const proof = await proveSecret(h, { password: secretBytes(PASSWORD) }, weak)
    const changed = await changePassword(h, byPassword.keyRing.get('mk'), proof, secretBytes('another fips profile password'), weak)
    const renewed = newRecoveryKey(changed, byPassword.keyRing.get('mk'), proof)
    destroyProof(proof)
    byPassword.keyRing.close()
    writeFileSync(join(d, VAULT_FILE), JSON.stringify(renewed.header))
    const byRecovery = await unlockVault(d, { recoveryKey: secretBytes(renewed.recoveryKey) }, weak)
    byRecovery.keyRing.close()
    const byNewPassword = await unlockVault(d, { password: secretBytes('another fips profile password') }, weak)
    byNewPassword.keyRing.close()
  })

  it('a standard vault cannot be opened or created in this process once a fips-140-3 vault latched it', async () => {
    await expect(createVault({ password: secretBytes('a standard password'), kdf: { memoryKiB: 64, passes: 1 } }, weak)).rejects.toThrow(/Quit and reopen Slate/)
  })
})

describe('T-POL-01: fips-140-3 password minimum', () => {
  it('14 characters are refused and 15 accepted; a blocklisted password of any length is refused', () => {
    expect(checkPassword(secretBytes('a'.repeat(4) + 'bcdefghijk'), [], 'fips-140-3')).toMatchObject({ ok: false, reason: 'Use at least 15 characters.' })
    expect(checkPassword(secretBytes('abcd efgh ijklm'), [], 'fips-140-3').ok).toBe(true)
    expect(checkPassword(secretBytes('1qaz2wsx3edc4rfv'), [], 'fips-140-3')).toMatchObject({ ok: false, reason: 'That is one of the most common passwords.' })
    expect(checkPassword(secretBytes('abcd efgh ij'), [], 'standard').ok).toBe(true)
  })

  it('at creation (the wizard) and at a password change', async () => {
    const d = dir()
    const m = new Migration({ dataDir: d, kdfOpts: weak, remote: () => null } as unknown as MigrationDeps)
    await expect(m.prepare(secretBytes('fourteen chars'), 'fips-140-3')).rejects.toThrow('Use at least 15 characters.')
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')).mk)
    const opened = await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)
    await expect(m.changePassword(opened.keyRing, { password: secretBytes(PASSWORD) }, secretBytes('fourteen chars'))).rejects.toThrow('Use at least 15 characters.')
    opened.keyRing.close()
  })
})

describe('T-POL-05: downgrades are refused before anything is derived', () => {
  async function fipsVault(): Promise<string> {
    const d = dir()
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')).mk)
    ;(await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).keyRing.close()
    return d
  }

  it('a v2 standard header for a vault whose floor says fips-140-3: vault.header.refused { reason: downgrade }', async () => {
    const d = await fipsVault()
    const h = await header(d)
    const warn = vi.spyOn(log, 'warn')
    const standard = { ...h, profile: 'standard', kdf: { alg: 'argon2id', memoryKiB: 65536, passes: 2, parallelism: 1, salt: Buffer.alloc(16, 1).toString('base64') } }
    writeFileSync(join(d, VAULT_FILE), JSON.stringify(standard))
    const before = calls.get('pbkdf2Async') ?? 0
    await expect(unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(HeaderRefused)
    expect(calls.get('pbkdf2Async') ?? 0).toBe(before)
    expect(warn).toHaveBeenCalledWith('app', 'vault.header.refused', expect.objectContaining({ reason: 'downgrade' }))
    warn.mockRestore()
  })

  it('a v1 header of the same vault: refused the same way', async () => {
    const d = await fipsVault()
    const h = await header(d)
    const v1 = JSON.parse(readFileSync(join(__dirname, 'fixtures/c4/data/vault.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(d, VAULT_FILE), JSON.stringify({ ...v1, vaultId: h.vaultId }))
    await expect(unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(HeaderRefused)
  })
})

describe('T-POL-06: no quick unlock in fips-140-3', () => {
  it('enableQuickUnlock refuses, a planted quick-unlock.bin is deleted at unlock, and the lock screen cannot use one', async () => {
    const d = dir()
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')).mk)
    const opened = await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)
    const h = await header(d)
    const proof = await proveSecret(h, { password: secretBytes(PASSWORD) }, weak)
    await expect(enableQuickUnlock(d, proof, platform, opened.keyRing.schedule)).rejects.toThrow(QuickUnlockNotAllowed)
    destroyProof(proof)
    opened.keyRing.close()
    expect(existsSync(join(d, QUICK_UNLOCK_FILE))).toBe(false)
    const ids = JSON.parse(readFileSync(join(d, LOCAL_KEYS_FILE), 'utf8')) as { vaultId: string; deviceId: string }
    const planted = { format: 'slate-quick-unlock', version: 2, ...ids, keyEpoch: 0, sealedQu: Buffer.alloc(44).toString('base64'), nonce: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(48).toString('base64') }
    writeFileSync(join(d, QUICK_UNLOCK_FILE), JSON.stringify(planted))
    await expect(openQuickUnlock(d, platform)).rejects.toThrow(QuickUnlockFailed)
    ;(await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).keyRing.close()
    expect(existsSync(join(d, QUICK_UNLOCK_FILE))).toBe(false)
    expect(profileOf(h)).toBe('fips-140-3')
  })
})


describe('review C5 L4: the floor cannot vanish, and the staged rejoin header is held to it', () => {
  async function fipsVault(): Promise<string> {
    const d = dir()
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')).mk)
    ;(await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).keyRing.close()
    return d
  }

  it('with profile-floor.json deleted, a weaker header is still refused: local-keys v2 binds the profile', async () => {
    const d = await fipsVault()
    const h = await header(d)
    rmSync(join(d, PROFILE_FLOOR_FILE))
    expect(JSON.parse(readFileSync(join(d, LOCAL_KEYS_FILE), 'utf8'))).toMatchObject({ version: 2, profile: 'fips-140-3' })
    const standard = { ...h, profile: 'standard', kdf: { alg: 'argon2id', memoryKiB: 65536, passes: 2, parallelism: 1, salt: Buffer.alloc(16, 1).toString('base64') } }
    writeFileSync(join(d, VAULT_FILE), JSON.stringify(standard))
    await expect(unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(HeaderRefused)
  })

  it('a standard vault.rejoin.json planted next to a fips-140-3 vault is refused, not opened', async () => {
    const d = await fipsVault()
    // A standard (header-v1) header as the staged one: only the floor and the local profile decide.
    const v1 = JSON.parse(readFileSync(join(__dirname, 'fixtures/c4/data/vault.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(d, 'vault.rejoin.json'), JSON.stringify(v1))
    await expect(unlockVault(d, { password: secretBytes('not this vault password') }, weak)).rejects.toThrow(HeaderRefused)
  })
})

describe('T-PQ-B3-07: the v2 → v3 upgrade of a fips-140-3 vault (INV-PQ-9)', () => {
  it('T-PQ-B3-07: makes zero calls to a legacy primitive and none to mldsaVerify, and the vault stays fips-140-3', async () => {
    const d = dir()
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak, 'fips-140-3')).mk)
    const opened = await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)
    const watched = [...LEGACY, 'mldsaVerify']
    const before = Object.fromEntries(watched.map((m) => [m, calls.get(m) ?? 0]))
    const hmacBefore = calls.get('hmacSha256') ?? 0
    try {
      const out = await runPqUpgrade({ dataDir: d, kdfOpts: weak, keyRing: opened.keyRing, remote: () => null, selfTest: async () => true })
      expect(out.state).toBe('done')
    } finally {
      opened.keyRing.close()
    }
    expect(Object.fromEntries(watched.map((m) => [m, calls.get(m) ?? 0]))).toEqual(before)
    // The new header's check and the raised floor were MAC'd through the module's approved HMAC.
    expect(calls.get('hmacSha256') ?? 0).toBeGreaterThan(hmacBefore)
    expect(await header(d)).toMatchObject({ version: 3, profile: 'fips-140-3', suite: 2 })
    expect(JSON.parse(readFileSync(join(d, PROFILE_FLOOR_FILE), 'utf8'))).toMatchObject({ profile: 'fips-140-3', minHeaderVersion: 3 })
    ;(await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)).keyRing.close()
  })
})

// Last in the file (tests run in order): criterion 2 over everything above.
describe('C5 criterion 2: the count over the whole fips-140-3 matrix', () => {
  it('not one call to Argon2id, RFC 5869 HKDF or AES-ECB, while the approved services were used', () => {
    expect(Object.fromEntries(LEGACY.map((m) => [m, calls.get(m) ?? 0]))).toEqual(Object.fromEntries(LEGACY.map((m) => [m, 0])))
    expect(calls.get('pbkdf2Async') ?? 0).toBeGreaterThan(0)
    expect(calls.get('kbkdf') ?? 0).toBeGreaterThan(0)
    expect(calls.get('nameSivEncode') ?? 0).toBeGreaterThan(0)
  })
})

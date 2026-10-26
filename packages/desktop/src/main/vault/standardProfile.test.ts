// Review C5 L2: a standard header-v2 vault (suite 0x02) never runs suite 0x01 either. Its password KDF is Argon2id,
// but RFC 5869 HKDF and AES-ECB belong to header-v1 vaults only. Every call into @slate/native is counted across
// creation, unlock by password and recovery key, quick unlock, preunlock, sync and a password change.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { memoryDrive } from '../../../../sync/test/memoryDrive'
import { spyOnNative } from '../../../test/nativeSpy'
import { EncryptingDrive } from '../sync/encryptingDrive'
import { readJsonCapped } from './atomic'
import { changePassword, destroyProof, newRecoveryKey, parseHeader, proveSecret } from './header'
import { destroyKey } from './native'
import { checkPreunlock, savePreunlock } from './preunlockSync'
import { enableQuickUnlock, openQuickUnlock, QUICK_UNLOCK_FILE, QuickUnlockFailed, type QuickUnlockPlatform } from './quickUnlock'
import { createEncryptedDataDir } from './testVault'
import { LOCAL_KEYS_FILE, unlockVault, VAULT_FILE } from './unlock'

const calls = spyOnNative()
const weak = { allowWeakForTests: true }
const PASSWORD = 'a standard profile password'
const SUITE1 = ['hkdfLegacy', 'hkdfFromSecret', 'aesEcbBlock']
const platform: QuickUnlockPlatform = {
  platform: 'linux',
  secrets: { available: async () => true, seal: async (s: string) => Buffer.from(s), open: async (b: Uint8Array) => ({ plain: Buffer.from(b).toString(), rewrite: false }) } as unknown as QuickUnlockPlatform['secrets'],
  systemPreferences: {},
}

describe('review C5 L2: a standard header-v2 vault never reaches suite 0x01', () => {
  it('create, unlock (password, recovery, quick unlock), preunlock, sync, password change and new recovery key', async () => {
    const d = mkdtempSync(join(tmpdir(), 'slate-std-v2-'))
    const made = await createEncryptedDataDir(d, secretBytes(PASSWORD), weak)
    destroyKey(made.mk)
    const opened = await unlockVault(d, { password: secretBytes(PASSWORD) }, weak)
    const header = parseHeader(await readJsonCapped(join(d, VAULT_FILE)), weak)
    const proof = await proveSecret(header, { password: secretBytes(PASSWORD) }, weak)
    await enableQuickUnlock(d, proof, platform, opened.keyRing.schedule)
    const pre = join(d, 'preunlock.json')
    await savePreunlock(pre, DEFAULT_SETTINGS, opened.keyRing)
    await checkPreunlock(pre, DEFAULT_SETTINGS, opened.keyRing)
    const drive = new EncryptingDrive(memoryDrive(), opened.keyRing)
    const page = `docs/page_${randomUUID()}/${randomUUID()}/00000001.chunk`
    await drive.upload(page, new Uint8Array([1]))
    await drive.delta(null)
    await drive.download(page)
    const changed = await changePassword(header, opened.keyRing.get('mk'), proof, secretBytes('another standard password'), weak)
    const renewed = newRecoveryKey(changed, opened.keyRing.get('mk'), proof)
    destroyProof(proof)
    opened.keyRing.close()
    ;(await unlockVault(d, { mk: await openQuickUnlock(d, platform) }, weak)).keyRing.close()
    writeFileSync(join(d, VAULT_FILE), JSON.stringify(renewed.header))
    ;(await unlockVault(d, { recoveryKey: secretBytes(renewed.recoveryKey) }, weak)).keyRing.close()
    expect(Object.fromEntries(SUITE1.map((m) => [m, calls.get(m) ?? 0]))).toEqual(Object.fromEntries(SUITE1.map((m) => [m, 0])))
    expect(calls.get('argon2idAsync') ?? 0).toBeGreaterThan(0)
  })

  it('a v1 quick-unlock file planted on a header-v2 vault is refused, without running suite 0x01', async () => {
    const d = mkdtempSync(join(tmpdir(), 'slate-std-v2-qu-'))
    destroyKey((await createEncryptedDataDir(d, secretBytes(PASSWORD), weak)).mk)
    const ids = JSON.parse(readFileSync(join(d, LOCAL_KEYS_FILE), 'utf8')) as { vaultId: string; deviceId: string }
    const v1 = { vaultId: ids.vaultId, deviceId: ids.deviceId, sealedQu: Buffer.from(Buffer.alloc(32, 9).toString('base64')).toString('base64'), nonce: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(48).toString('base64') }
    writeFileSync(join(d, QUICK_UNLOCK_FILE), JSON.stringify(v1))
    const before = calls.get('hkdfFromSecret') ?? 0
    await expect(openQuickUnlock(d, platform)).rejects.toThrow(QuickUnlockFailed)
    expect(calls.get('hkdfFromSecret') ?? 0).toBe(before)
  })
})

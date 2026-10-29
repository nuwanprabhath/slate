import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHeaderV3From, parseHeader, proveSecret, type VaultHeaderV2 } from './header'
import {
  enableQuickUnlock,
  forgetQuickUnlock,
  openQuickUnlock,
  QUICK_UNLOCK_FILE,
  quickUnlockKind,
  QuickUnlockFailed,
  type QuickUnlockPlatform,
} from './quickUnlock'
import { createSecretStorage } from '../secretStorage'
import { importKey, liveHandles, masterKeyMatches, mkBytesOf, sameMaster } from '../../../test/vaultKeys'
import { createEncryptedDataDir } from './testVault'
import { scheduleOf } from './header'
import { LOCAL_KEYS_FILE, UnlockFailed, unlockVault } from './unlock'
import { secretBytes } from '../../shared/secret'

const weak = { allowWeakForTests: true }
/** safeStorage stand-in: reversible, so a test can prove the file never holds QU in the clear. */
function fakePlatform(over: Partial<{ backend: string; touchId: boolean; prompt: () => Promise<void>; decrypt: (b: Buffer) => string; platform: NodeJS.Platform }> = {}) {
  const prompts: string[] = []
  const platform = over.platform ?? 'darwin'
  const decrypt = over.decrypt ?? ((b: Buffer) => Buffer.from(b.toString().slice('sealed:'.length), 'hex').toString())
  const p: QuickUnlockPlatform = {
    platform,
    // Electron's async safeStorage (the only one Slate calls, B-5) behind the real secretStorage wrapper.
    secrets: createSecretStorage(
      {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (s) => Buffer.from('sealed:' + Buffer.from(s).toString('hex')),
        decryptStringAsync: async (b) => ({ result: decrypt(b), shouldReEncrypt: false }),
        getSelectedStorageBackend: () => (over.backend ?? 'gnome_libsecret') as 'gnome_libsecret',
      },
      platform,
    ),
    systemPreferences: {
      canPromptTouchID: () => over.touchId ?? true,
      promptTouchID: async (reason) => {
        prompts.push(reason)
        await (over.prompt ?? (async () => {}))()
      },
    },
  }
  return { p, prompts }
}

async function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'slate-qu-'))
  const { mk } = await createEncryptedDataDir(dir, secretBytes('correct horse'), weak)
  const header = parseHeader(JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')), weak)
  const proof = await proveSecret(header, { password: secretBytes('correct horse') }, weak)
  return { dir, mk, proof, schedule: scheduleOf(header) }
}

describe('quick unlock (§8)', () => {
  it('round trips MK through quick-unlock.bin (0600) after Touch ID, and unlockVault accepts it', async () => {
    const { dir, mk, proof, schedule } = await vault()
    const { p, prompts } = fakePlatform()
    await enableQuickUnlock(dir, proof, p, schedule)
    const file = join(dir, QUICK_UNLOCK_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    // v2 (audit §4.5.4, F-GEN-03) for a header-v2 vault: a format, a version and the key epoch, all in the AAD.
    expect(Object.keys(json).sort()).toEqual(['ct', 'deviceId', 'format', 'keyEpoch', 'nonce', 'sealedQu', 'vaultId', 'version'])
    const mkBytes = await mkBytesOf(dir, 'correct horse')
    expect(readFileSync(file, 'utf8')).not.toContain(mkBytes.toString('base64'))
    const got = await openQuickUnlock(dir, p)
    expect(prompts).toEqual(['unlock your notes'])
    expect(masterKeyMatches(got, mkBytes)).toBe(true)
    expect(sameMaster(got, mk)).toBe(true)
    const opened = await unlockVault(dir, { mk: got }, weak)
    expect(masterKeyMatches(opened.keyRing.get('mk'), mkBytes)).toBe(true)
    opened.keyRing.close()
  })

  it('rejects an MK that does not pass the vault check', async () => {
    const { dir } = await vault()
    const before = liveHandles()
    await expect(unlockVault(dir, { mk: importKey(Buffer.alloc(32, 7), 'master') }, weak)).rejects.toThrow(UnlockFailed)
    // unlockVault owns a quick-unlock MK: one that fails the check is destroyed, not left in the module.
    expect(liveHandles()).toBe(before)
  })

  it('binds the wrap to vaultId and deviceId', async () => {
    for (const field of ['vaultId', 'deviceId'] as const) {
      const { dir, mk, proof, schedule } = await vault()
      const { p } = fakePlatform()
      await enableQuickUnlock(dir, proof, p, schedule)
      const file = join(dir, QUICK_UNLOCK_FILE)
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
      const other = '00000000-0000-4000-8000-000000000000'
      writeFileSync(file, JSON.stringify({ ...json, [field]: other }))
      await expect(openQuickUnlock(dir, p)).rejects.toThrow(QuickUnlockFailed)
      // The device's own local-keys.json claiming the other id fails the same way.
      writeFileSync(file, JSON.stringify(json))
      const lk = JSON.parse(readFileSync(join(dir, LOCAL_KEYS_FILE), 'utf8')) as Record<string, string>
      writeFileSync(join(dir, LOCAL_KEYS_FILE), JSON.stringify({ ...lk, [field]: other }))
      await expect(openQuickUnlock(dir, p)).rejects.toThrow(QuickUnlockFailed)
    }
  })

  it('is available on macOS with Touch ID, and on Linux only with a real keyring', async () => {
    expect(await quickUnlockKind(fakePlatform().p)).toBe('touchid')
    expect(await quickUnlockKind(fakePlatform({ touchId: false }).p)).toBeNull()
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) expect(await quickUnlockKind(fakePlatform({ platform: 'linux', backend }).p)).toBe('keyring')
    for (const backend of ['basic_text', 'unknown']) expect(await quickUnlockKind(fakePlatform({ platform: 'linux', backend }).p)).toBeNull()
    expect(await quickUnlockKind(fakePlatform({ platform: 'win32' }).p)).toBeNull()
  })

  it('refuses to enable on basic_text', async () => {
    const { dir, mk, proof, schedule } = await vault()
    await expect(enableQuickUnlock(dir, proof, fakePlatform({ platform: 'linux', backend: 'basic_text' }).p, schedule)).rejects.toThrow()
    expect(existsSync(join(dir, QUICK_UNLOCK_FILE))).toBe(false)
  })

  it('turns every failure into QuickUnlockFailed', async () => {
    const { dir, mk, proof, schedule } = await vault()
    await enableQuickUnlock(dir, proof, fakePlatform().p, schedule)
    const cases: QuickUnlockPlatform[] = [
      fakePlatform({ prompt: async () => Promise.reject(new Error('User canceled')) }).p,
      fakePlatform({
        decrypt: () => {
          throw new Error('Keychain access denied')
        },
      }).p,
      fakePlatform({ decrypt: () => Buffer.alloc(32, 1).toString('base64') }).p,
      fakePlatform({ touchId: false }).p,
      fakePlatform({ platform: 'linux', backend: 'basic_text' }).p,
    ]
    for (const p of cases) await expect(openQuickUnlock(dir, p)).rejects.toThrow(QuickUnlockFailed)
    writeFileSync(join(dir, QUICK_UNLOCK_FILE), 'not json')
    await expect(openQuickUnlock(dir, fakePlatform().p)).rejects.toThrow(QuickUnlockFailed)
  })

  it('forget deletes the file, and is harmless when there is none', async () => {
    const { dir, mk, proof, schedule } = await vault()
    await enableQuickUnlock(dir, proof, fakePlatform().p, schedule)
    await forgetQuickUnlock(dir)
    expect(existsSync(join(dir, QUICK_UNLOCK_FILE))).toBe(false)
    await forgetQuickUnlock(dir)
    await expect(openQuickUnlock(dir, fakePlatform().p)).rejects.toThrow(QuickUnlockFailed)
  })

  it('T-PQ-B1-09: quick unlock opens a header-v3 vault, made from v2 without re-entering a secret (INV-PQ-3)', async () => {
    const { dir, mk } = await vault()
    const v2 = parseHeader(JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')), weak) as VaultHeaderV2
    const v3 = buildHeaderV3From(v2, mk)
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(v3))
    const proof = await proveSecret(v3, { password: secretBytes('correct horse') }, weak)
    const { p } = fakePlatform()
    await enableQuickUnlock(dir, proof, p, scheduleOf(v3))
    const got = await openQuickUnlock(dir, p)
    expect(sameMaster(got, mk)).toBe(true)
    const opened = await unlockVault(dir, { mk: got }, weak)
    expect(sameMaster(opened.keyRing.get('mk'), mk)).toBe(true)
    opened.keyRing.close()
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { guardHandlers } from '../ipcGuard'
import { logHandlers } from '../log/ipcLog'
import { Logger } from '../log/logger'
import { DocStore } from '../store'
import { proveSecret, changePassword } from './header'
import { Locked } from './keyring'
import { createEncryptedDataDir, headersOpenedBy, storeWithLk } from './testVault'
import { UNLOCK_FAILED_MESSAGE, UnlockFailed, unlockVault } from './unlock'
import { isLive } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'

const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery'

function plainDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-unlock-'))
  const store = new DocStore(join(dir, 'slate.db'))
  const doc = new LoroDoc()
  doc.getText('t').insert(0, 'hello')
  store.append('page:00000000-0000-4000-8000-000000000001', doc.export({ mode: 'update' }))
  store.close()
  return dir
}

describe('unlock (§6.7, §4)', () => {
  it('opens the encrypted database with the password, and refuses a wrong one generically', async () => {
    const dir = plainDataDir()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    expect(existsSync(join(dir, 'slate.db'))).toBe(false)
    await expect(unlockVault(dir, { password: secretBytes('wrong password!') }, weak)).rejects.toThrow(UnlockFailed)
    await expect(unlockVault(dir, { password: secretBytes('wrong password!') }, weak)).rejects.toThrow(UNLOCK_FAILED_MESSAGE)
    const { keyRing, dbFile, passwordChanged } = await unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)
    expect(passwordChanged).toBe(false)
    const store = storeWithLk(keyRing, dbFile)
    expect(store.load('page:00000000-0000-4000-8000-000000000001')).toHaveLength(1)
    store.close()
    keyRing.close()
    expect(() => keyRing.get('lk')).toThrow(Locked)
  })

  it('opens with the recovery key', async () => {
    const dir = plainDataDir()
    const { recoveryKey } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    await expect(unlockVault(dir, { recoveryKey: secretBytes('AAAA-BBBB') }, weak)).rejects.toThrow(UnlockFailed)
    const { keyRing } = await unlockVault(dir, { recoveryKey: secretBytes(recoveryKey.toLowerCase()) }, weak)
    expect(isLive(keyRing.get('lk'))).toBe(true)
  })

  it('adopts a pending header when the password was changed on another device', async () => {
    const dir = plainDataDir()
    const { header, mk } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const pending = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(PASSWORD) }, weak), secretBytes('a brand new password'), weak)
    writeFileSync(join(dir, 'vault.pending.json'), JSON.stringify(pending))
    // The old password still opens the local header; the pending one stays pending.
    const old = await unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)
    expect(old.passwordChanged).toBe(false)
    expect(existsSync(join(dir, 'vault.pending.json'))).toBe(true)
    const { keyRing, passwordChanged } = await unlockVault(dir, { password: secretBytes('a brand new password') }, weak)
    expect(passwordChanged).toBe(true)
    expect(isLive(keyRing.get('lk'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')).revision).toBe(2)
    expect(existsSync(join(dir, 'vault.pending.json'))).toBe(false)
    // Nothing reads an older header, so none is kept: the old password opens no file here.
    expect(existsSync(join(dir, 'vault.prev.json'))).toBe(false)
    expect(await headersOpenedBy(dir, secretBytes(PASSWORD), weak)).toEqual([])
  })

  it('never adopts a pending header with a lower revision or another vault', async () => {
    const dir = plainDataDir()
    const { header, mk } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const pending = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(PASSWORD) }, weak), secretBytes('a brand new password'), weak)
    writeFileSync(join(dir, 'vault.pending.json'), JSON.stringify({ ...pending, revision: 1 }))
    await expect(unlockVault(dir, { password: secretBytes('a brand new password') }, weak)).rejects.toThrow(UnlockFailed)
  })

  it('never writes the password to the diagnostic log', async () => {
    const dir = plainDataDir()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const logDir = mkdtempSync(join(tmpdir(), 'slate-unlock-log-'))
    const logger = new Logger()
    logger.configure({ enabled: true, dir: logDir, maxSizeMb: 1, home: tmpdir() })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake registrar takes any handler shape
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipc = guardHandlers(logHandlers({ handle: (c: string, h: (...args: never[]) => unknown) => void handlers.set(c, h) }, logger), () => false)
    ipc.handle('vault:unlock', (_e: unknown, password: string) => unlockVault(dir, { password: secretBytes(password) }, weak))
    const secret = 'hunter2-my-secret-pw'
    await expect(handlers.get('vault:unlock')!({}, secret)).rejects.toThrow(UnlockFailed)
    const text = logger.read()
    expect(text).toContain('vault:unlock')
    expect(text).not.toContain(secret)
  })
})

describe('review C5 N1: the stray-database clean-up at unlock is best effort', () => {
  it('a slate-x.db that cannot be removed (a directory) does not fail the unlock, and is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-stray-dir-'))
    const { mk } = await createEncryptedDataDir(dir, secretBytes('correct horse'), weak)
    ;(await import('./native')).destroyKey(mk)
    mkdirSync(join(dir, 'slate-x.db'))
    writeFileSync(join(dir, 'slate-x.db', 'inside'), 'x')
    const { log } = await import('../log/logger')
    const warn = vi.spyOn(log, 'warn')
    const opened = await unlockVault(dir, { password: secretBytes('correct horse') }, weak)
    expect(warn).toHaveBeenCalledWith('app', 'stray database clean-up failed', expect.anything())
    warn.mockRestore()
    opened.keyRing.close()
  })
})

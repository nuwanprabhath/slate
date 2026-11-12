import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { encodeRecovery } from './recovery'
import { secretBytes } from '../../shared/secret'
import { recoverySaveDialog, refuseRecoveryPath } from './recoveryFile'
import { writeRecoveryFile } from '../recoverySave'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-recovery-file-'))
  mkdirSync(join(dir, 'data'))
  mkdirSync(join(dir, 'Documents'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('refuseRecoveryPath', () => {
  it('refuses the data folder and anything under it, also through a symlink', () => {
    const data = join(dir, 'data')
    expect(refuseRecoveryPath(join(data, 'key.txt'), data)).toMatch(/data folder/)
    expect(refuseRecoveryPath(join(data, 'git-sync', 'x', 'key.txt'), data)).toMatch(/data folder/)
    symlinkSync(data, join(dir, 'link'))
    expect(refuseRecoveryPath(join(dir, 'link', 'key.txt'), data)).toMatch(/data folder/)
  })

  it('refuses the data folder named in another case where the disk ignores case (APFS, NTFS)', () => {
    const data = join(dir, 'data')
    mkdirSync(join(data, 'git-sync', 'x'), { recursive: true })
    const upper = join(dir, 'DATA')
    // On a case-sensitive disk DATA is another folder, so it is rightly accepted.
    const sameFolder = existsSync(upper)
    for (const path of [join(upper, 'key.txt'), join(upper, 'GIT-SYNC', 'x', 'key.txt'), join(upper, 'new', 'key.txt')]) {
      expect(refuseRecoveryPath(path, data)).toBe(sameFolder ? refuseRecoveryPath(join(data, 'key.txt'), data) : null)
    }
    expect(refuseRecoveryPath(join(data, 'key.txt'), upper)).toBe(sameFolder ? refuseRecoveryPath(join(data, 'key.txt'), data) : null)
    expect(process.platform !== 'darwin' || sameFolder).toBe(true)
  })

  it('accepts Documents', () => {
    expect(refuseRecoveryPath(join(dir, 'Documents', 'Slate recovery key.txt'), join(dir, 'data'))).toBeNull()
  })
})

describe('writeRecoveryFile', () => {
  it('writes the key in 14 groups, owner-read-only, and refuses anything that is not a recovery key', async () => {
    const key = encodeRecovery(randomBytes(32))
    const keyText = new TextDecoder().decode(key)
    const path = join(mkdtempSync(join(tmpdir(), 'slate-recovery-')), 'key.txt')
    await writeRecoveryFile(path, key)
    // The written file carries the key; main holds it as bytes and zeroes them, because a string of
    // the key could not be zeroed and would outlive the lock (POAM-10, T-ZERO-09).
    const written = readFileSync(path)
    expect(written.toString('latin1')).toContain(keyText)
    expect(keyText.split('-')).toHaveLength(14)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(writeRecoveryFile(path, secretBytes('<script>not a key</script>'))).rejects.toThrow()
  })
})

describe('recovery key save dialog', () => {
  it('warns that Documents may sync to iCloud and suggests printing or a password manager', () => {
    const opts = recoverySaveDialog('/home/me/Documents')
    expect(opts.message).toMatch(/iCloud/)
    expect(opts.message).toMatch(/print/i)
    expect(opts.message).toMatch(/password manager/i)
    expect(opts.defaultPath).toBe(join('/home/me/Documents', 'Slate recovery key.txt'))
    expect(refuseRecoveryPath(join(dir, 'data', 'k.txt'), join(dir, 'data'))).not.toMatch(/Documents/)
  })
})

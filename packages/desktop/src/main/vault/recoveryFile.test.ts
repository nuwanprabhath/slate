import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { encodeRecovery } from './recovery'
import { recoveryFileText, recoverySaveDialog, refuseRecoveryPath } from './recoveryFile'

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

describe('recoveryFileText', () => {
  it('holds the key in 14 groups and refuses anything that is not a recovery key', () => {
    const key = encodeRecovery(randomBytes(32))
    const text = recoveryFileText(key)
    expect(text).toContain(key)
    expect(key.split('-')).toHaveLength(14)
    expect(() => recoveryFileText('<script>not a key</script>')).toThrow()
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

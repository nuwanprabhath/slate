import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultUserDataDir, migrateLegacyUserData } from './paths'

describe('defaultUserDataDir', () => {
  it('follows each platform convention and honours SLATE_USER_DATA', () => {
    expect(defaultUserDataDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/Slate')
    expect(defaultUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/Slate')
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/Slate')
    expect(defaultUserDataDir('win32', { APPDATA: 'C:\\A' }, 'C:\\U')).toBe(join('C:\\A', 'Slate'))
    expect(defaultUserDataDir('darwin', { SLATE_USER_DATA: '/tmp/t' }, '/Users/u')).toBe('/tmp/t')
  })
})

describe('migrateLegacyUserData', () => {
  it('moves the Phase 1 @slate/desktop folder once', () => {
    const parent = mkdtempSync(join(tmpdir(), 'slate-paths-'))
    mkdirSync(join(parent, '@slate', 'desktop'), { recursive: true })
    writeFileSync(join(parent, '@slate', 'desktop', 'slate.db'), 'x')
    expect(migrateLegacyUserData(join(parent, 'Slate'))).toBe(true)
    expect(existsSync(join(parent, 'Slate', 'slate.db'))).toBe(true)
    expect(migrateLegacyUserData(join(parent, 'Slate'))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { detectInstallKind } from './capability'

const base = { isPackaged: true, env: {}, execPath: '/x/slate' }

describe('detectInstallKind', () => {
  it('is manual when not packaged, whatever the platform', () => {
    expect(detectInstallKind({ ...base, isPackaged: false, platform: 'darwin' })).toBe('manual')
    expect(detectInstallKind({ ...base, isPackaged: false, platform: 'linux', env: { APPIMAGE: '/a/Slate.AppImage' } })).toBe('manual')
  })

  it('gives an unsigned mac build the assisted dmg path', () => {
    expect(detectInstallKind({ ...base, platform: 'darwin', execPath: '/Applications/Slate.app/Contents/MacOS/Slate' })).toBe('dmg')
  })

  it('lets an AppImage install itself', () => {
    expect(detectInstallKind({ ...base, platform: 'linux', env: { APPIMAGE: '/home/me/Slate.AppImage' } })).toBe('auto')
  })

  it('gives a .deb installation (under /opt) the assisted deb path', () => {
    expect(detectInstallKind({ ...base, platform: 'linux', execPath: '/opt/Slate/slate' })).toBe('deb')
  })

  it('is manual for any other Linux layout and for Windows', () => {
    expect(detectInstallKind({ ...base, platform: 'linux', execPath: '/home/me/slate-unpacked/slate' })).toBe('manual')
    expect(detectInstallKind({ ...base, platform: 'win32', execPath: 'C:\\Slate\\Slate.exe' })).toBe('manual')
  })
})

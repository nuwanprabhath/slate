import { describe, expect, it } from 'vitest'
import { installCommand, pickInstaller } from './pickInstaller'

const files = [
  { url: 'Slate-0.2.0-mac-arm64.zip', sha512: 'z', size: 1 },
  { url: 'Slate-0.2.0-mac-arm64.dmg', sha512: 'd', size: 2 },
  { url: 'Slate-0.2.0-mac-x64.dmg', sha512: 'dx', size: 2 },
  { url: 'Slate-0.2.0-linux-x86_64.AppImage', sha512: 'a', size: 3 },
  { url: 'Slate-0.2.0-linux-amd64.deb', sha512: 'b', size: 4 },
]

describe('pickInstaller', () => {
  it('picks the dmg for the running arch on a mac', () => {
    expect(pickInstaller(files, 'dmg', 'arm64')?.sha512).toBe('d')
    expect(pickInstaller(files, 'dmg', 'x64')?.sha512).toBe('dx')
  })

  it('picks the .deb for a deb install', () => {
    expect(pickInstaller(files, 'deb', 'x64')?.sha512).toBe('b')
  })

  it('falls back to the only installer of that type when no name carries the arch', () => {
    expect(pickInstaller([{ url: 'Slate.dmg', sha512: 'only', size: 1 }], 'dmg', 'arm64')?.sha512).toBe('only')
  })

  it('never picks an installer for another arch', () => {
    expect(pickInstaller([{ url: 'Slate-0.2.0-mac-x64.dmg', sha512: 'dx', size: 1 }], 'dmg', 'arm64')).toBeNull()
  })

  it('is null when there is nothing to pick, or the kind has no installer file', () => {
    expect(pickInstaller([], 'deb', 'x64')).toBeNull()
    expect(pickInstaller(files, 'auto', 'x64')).toBeNull()
    expect(pickInstaller(files, 'manual', 'x64')).toBeNull()
  })
})

describe('installCommand', () => {
  it('is apt install of the downloaded .deb, quoted', () => {
    expect(installCommand('deb', '/home/me/Downloads/Slate-0.2.0-linux-amd64.deb')).toBe(
      "sudo apt install '/home/me/Downloads/Slate-0.2.0-linux-amd64.deb'",
    )
  })

  it('copies the app out of the dmg and clears quarantine on a mac', () => {
    const cmd = installCommand('dmg', '/Users/me/Downloads/Slate 0.2.0.dmg')!
    expect(cmd).toContain("hdiutil attach -nobrowse -mountpoint /tmp/slate-update '/Users/me/Downloads/Slate 0.2.0.dmg'")
    expect(cmd).toContain('ditto /tmp/slate-update/Slate.app /Applications/Slate.app')
    expect(cmd).toContain('xattr -cr /Applications/Slate.app')
  })

  it("escapes a single quote in the path", () => {
    expect(installCommand('deb', "/tmp/it's.deb")).toBe("sudo apt install '/tmp/it'\\''s.deb'")
  })

  it('is null where the app installs itself', () => {
    expect(installCommand('auto', '/x')).toBeNull()
    expect(installCommand('manual', '/x')).toBeNull()
  })
})

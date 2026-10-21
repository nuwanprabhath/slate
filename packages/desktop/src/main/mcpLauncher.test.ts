import { describe, expect, it } from 'vitest'
import { launcherInfo } from './mcpLauncher'

describe('launcherInfo', () => {
  it('points at the launcher inside the packaged app on each platform', () => {
    const mac = launcherInfo({ packaged: true, resourcesPath: '/Applications/Slate.app/Contents/Resources', repoRoot: '/repo', platform: 'darwin' })
    expect(mac.command).toBe('/Applications/Slate.app/Contents/Resources/bin/slate-mcp')
    expect(mac.claudeCommand).toBe('claude mcp add slate -- "/Applications/Slate.app/Contents/Resources/bin/slate-mcp"')
    expect(mac.packaged).toBe(true)

    const linux = launcherInfo({ packaged: true, resourcesPath: '/opt/Slate/resources', repoRoot: '/repo', platform: 'linux' })
    expect(linux.command).toBe('/opt/Slate/resources/bin/slate-mcp')

    const win = launcherInfo({ packaged: true, resourcesPath: 'C:\\Slate\\resources', repoRoot: 'C:\\repo', platform: 'win32' })
    expect(win.command.endsWith('slate-mcp.cmd')).toBe(true)
    expect(win.command.startsWith('C:\\Slate\\resources')).toBe(true)
  })

  it('points at bin/slate-mcp in the checkout when running from source', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const info = launcherInfo({ packaged: false, resourcesPath: '/ignored', repoRoot: '/repo', platform })
      expect(info.command).toBe('/repo/bin/slate-mcp')
      expect(info.claudeCommand).toBe('claude mcp add slate -- "/repo/bin/slate-mcp"')
      expect(info.packaged).toBe(false)
    }
  })
})

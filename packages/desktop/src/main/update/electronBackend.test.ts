import { describe, expect, it, vi } from 'vitest'

// electron-updater builds its updater on first access to `autoUpdater`, and that constructor
// throws when the app version is not semver — which an unpackaged Linux run reports ("0.0").
// That throw once stopped the main window from ever being created.
vi.mock('electron-updater', () => ({
  get autoUpdater(): never {
    throw new Error('App version is not a valid semver version: "0.0"')
  },
}))
vi.mock('electron', () => ({ clipboard: {}, net: {}, shell: {} }))

describe('electronBackend', () => {
  it('does not touch electron-updater until a check runs', async () => {
    const { electronBackend } = await import('./electronBackend')
    const backend = electronBackend({ downloadsDir: '/tmp', log: () => {} })
    await expect(backend.check()).rejects.toThrow(/semver/)
  })

  it('marks a downloaded installer as quarantined so Gatekeeper still checks it', async () => {
    const { setQuarantine } = await import('./electronBackend')
    const run = vi.fn().mockResolvedValue(undefined)
    await setQuarantine('/dl/Slate.dmg', run)
    expect(run).toHaveBeenCalledWith('xattr', ['-w', 'com.apple.quarantine', expect.stringMatching(/^0081;[0-9a-f]+;Slate;$/), '/dl/Slate.dmg'])
  })
})

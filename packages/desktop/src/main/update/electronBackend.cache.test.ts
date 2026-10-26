import { describe, expect, it, vi } from 'vitest'
import type { VerifiedRelease } from './verifier'

// A stand-in for electron-updater's AppUpdater: one cached update, replaced by every check.
const updater = vi.hoisted(() => ({
  updateInfoAndProvider: null as { info: { version: string; files: Array<{ url: string; sha512: string }> } } | null,
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}))
vi.mock('electron-updater', () => ({ autoUpdater: updater }))
vi.mock('electron', () => ({ clipboard: {}, net: {}, shell: {} }))

const verified = { version: '0.4.0', files: [{ url: 'Slate-0.4.0-x86_64.AppImage', sha512: 'R09PRA==', size: 1 }] } as unknown as VerifiedRelease

describe('electronBackend: the update electron-updater acts on must be the verified one (review F2)', () => {
  it('refuses to download or install when a later check replaced the cached update', async () => {
    const { electronBackend } = await import('./electronBackend')
    const backend = electronBackend({ downloadsDir: '/tmp', log: () => {} })
    updater.updateInfoAndProvider = { info: { version: '0.5.0', files: [{ url: 'Slate-0.5.0-x86_64.AppImage', sha512: 'RVZJTA==' }] } }
    await expect(backend.downloadAuto(verified, () => {})).rejects.toThrow(/not the verified 0\.4\.0/)
    expect(() => backend.installAuto(verified)).toThrow(/not the verified/)
    updater.updateInfoAndProvider = { info: { version: '0.4.0', files: [{ url: 'Slate-0.4.0-x86_64.AppImage', sha512: 'RVZJTA==' }] } }
    await expect(backend.downloadAuto(verified, () => {})).rejects.toThrow(/not the verified/)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    updater.updateInfoAndProvider = { info: { version: '0.4.0', files: [{ url: 'Slate-0.4.0-x86_64.AppImage', sha512: 'R09PRA==' }] } }
    await backend.downloadAuto(verified, () => {})
    backend.installAuto(verified)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})

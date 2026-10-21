import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CH } from '../../shared/ipc'
import { DocStore } from '../store'
import { readSettings } from '../settings'
import { registerUpdateIpc, updatePrefsIn } from './ipc'
import type { UpdateService } from './updateService'

describe('registerUpdateIpc', () => {
  it('routes each update channel to the service', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const service = {
      state: vi.fn(() => ({ phase: 'idle', kind: 'deb', visible: false })),
      check: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
      install: vi.fn(),
      openInstaller: vi.fn(),
      showInFolder: vi.fn(),
      copyCommand: vi.fn(),
      copyReleaseUrl: vi.fn(),
      skip: vi.fn(),
      dismiss: vi.fn(),
    }
    registerUpdateIpc({ handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) }, service as unknown as UpdateService)
    const call = (ch: string) => handlers.get(ch)!({})
    expect(await call(CH.updateState)).toEqual({ phase: 'idle', kind: 'deb', visible: false })
    await call(CH.updateCheck)
    expect(service.check).toHaveBeenCalledWith({ manual: true })
    const pairs: Array<[string, keyof typeof service]> = [
      [CH.updateDownload, 'download'],
      [CH.updateInstall, 'install'],
      [CH.updateOpenInstaller, 'openInstaller'],
      [CH.updateShowInFolder, 'showInFolder'],
      [CH.updateCopyCommand, 'copyCommand'],
      [CH.updateCopyReleaseUrl, 'copyReleaseUrl'],
      [CH.updateSkip, 'skip'],
      [CH.updateDismiss, 'dismiss'],
    ]
    for (const [ch, method] of pairs) {
      await call(ch)
      expect(service[method]).toHaveBeenCalled()
    }
  })
})

describe('updatePrefsIn', () => {
  it('keeps skip and dismiss in the settings store, apart from the app settings', () => {
    const store = new DocStore(join(mkdtempSync(join(tmpdir(), 'slate-upd-')), 'slate.db'))
    const prefs = updatePrefsIn(store)
    expect(prefs.load()).toEqual({})
    prefs.save({ skipped: '0.2.0', dismissed: '0.3.0' })
    expect(updatePrefsIn(store).load()).toEqual({ skipped: '0.2.0', dismissed: '0.3.0' })
    expect(readSettings(store)).not.toHaveProperty('skipped')
    store.close()
  })
})

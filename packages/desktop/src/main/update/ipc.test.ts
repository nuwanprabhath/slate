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
      prepareInstall: vi.fn(async () => ({ needsPassword: false })),
      installAndRestart: vi.fn(async (_password: Uint8Array | null) => ({ ok: true as const })),
    }
    registerUpdateIpc({ handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) }, service as unknown as UpdateService)
    const call = (ch: string) => handlers.get(ch)!({})
    expect(await call(CH.updateState)).toEqual({ phase: 'idle', kind: 'deb', visible: false })
    await call(CH.updateCheck)
    expect(service.check).toHaveBeenCalledWith({ manual: true })
    const pairs: Array<[string, keyof typeof service]> = [
      [CH.updateDownload, 'download'],
      [CH.updateInstall, 'install'],
      [CH.updatePrepareInstall, 'prepareInstall'],
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

describe('registerUpdateIpc: the password for Install and restart', () => {
  function setup() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const seen: Array<number[] | null> = []
    const service = {
      installAndRestart: vi.fn(async (password: Uint8Array | null) => {
        seen.push(password === null ? null : [...password])
        return { ok: true as const }
      }),
    }
    registerUpdateIpc({ handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) }, service as unknown as UpdateService)
    return { call: (arg: unknown) => handlers.get(CH.updateInstallAndRestart)!({}, arg) as Promise<unknown>, service, seen }
  }

  it('hands the service the password as bytes and zeroes main\'s copy when the call settles', async () => {
    const { call, seen } = setup()
    const password = new Uint8Array([104, 117, 110, 116, 101, 114, 50])
    expect(await call(password)).toEqual({ ok: true })
    expect(seen).toEqual([[104, 117, 110, 116, 101, 114, 50]])
    expect([...password]).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('passes null through: no password is needed', async () => {
    const { call, seen } = setup()
    await call(null)
    expect(seen).toEqual([null])
  })

  it('refuses anything that is not a non-empty byte array, without calling the service', async () => {
    const { call, service } = setup()
    for (const bad of ['hunter2', 42, {}, undefined, new Uint8Array(0), new Uint8Array(4097)]) {
      expect(await call(bad)).toMatchObject({ ok: false, reason: 'install' })
    }
    expect(service.installAndRestart).not.toHaveBeenCalled()
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

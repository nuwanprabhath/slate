import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../shared/api'
import { UpdateService, type UpdateBackend, type UpdatePrefs } from './updateService'

const found = (version: string) => ({
  version,
  files: [
    { url: `Slate-${version}-mac-arm64.dmg`, sha512: 'd', size: 1 },
    { url: `Slate-${version}-linux-amd64.deb`, sha512: 'b', size: 1 },
  ],
})

function stubBackend(version = '0.2.0'): UpdateBackend & { [K in keyof UpdateBackend]: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn().mockResolvedValue(found(version)),
    downloadAuto: vi.fn().mockResolvedValue(undefined),
    installAuto: vi.fn(),
    downloadFile: vi.fn(async (file: { url: string }) => `/dl/${file.url}`),
    openPath: vi.fn().mockResolvedValue(undefined),
    showInFolder: vi.fn(),
    openExternal: vi.fn(),
    copy: vi.fn(),
  }
}

function setup(opts: { kind?: UpdateState['kind']; prefs?: UpdatePrefs; backend?: ReturnType<typeof stubBackend> } = {}) {
  const backend = opts.backend ?? stubBackend()
  let prefs: UpdatePrefs = opts.prefs ?? {}
  const states: UpdateState[] = []
  const log = vi.fn()
  const service = new UpdateService({
    backend,
    kind: opts.kind ?? 'deb',
    arch: opts.kind === 'dmg' ? 'arm64' : 'x64',
    currentVersion: '0.1.0',
    loadPrefs: () => prefs,
    savePrefs: (p) => {
      prefs = p
    },
    log,
    emit: (s) => states.push(s),
  })
  return { service, backend, states, log, prefs: () => prefs }
}

describe('UpdateService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks 10 seconds after start, then every 6 hours, until stopped', async () => {
    const { service, backend } = setup()
    service.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(backend.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(backend.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(backend.check).toHaveBeenCalledTimes(2)
    service.stop()
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(backend.check).toHaveBeenCalledTimes(2)
  })

  it('shows a newer version and emits each change', async () => {
    const { service, states, prefs } = setup()
    await service.check()
    expect(service.state()).toMatchObject({ phase: 'available', version: '0.2.0', visible: true, kind: 'deb' })
    expect(service.state().releaseUrl).toBe('https://github.com/nuwanprabhath/slate/releases/tag/v0.2.0')
    expect(states.map((s) => s.phase)).toEqual(['checking', 'available'])
    expect(prefs().lastCheckedAt).toBeTypeOf('number')
  })

  it('stays idle when the feed has the running version or an older one', async () => {
    const { service } = setup({ backend: stubBackend('0.1.0') })
    await service.check()
    expect(service.state()).toMatchObject({ phase: 'idle', visible: false })
    expect(service.state().version).toBeUndefined()
  })

  it('hides a skipped version on scheduled checks but shows it on a manual one', async () => {
    const { service } = setup({ prefs: { skipped: '0.2.0' } })
    await service.check()
    expect(service.state()).toMatchObject({ phase: 'available', visible: false })
    await service.check({ manual: true })
    expect(service.state().visible).toBe(true)
  })

  it('skip persists the version and hides the banner', async () => {
    const { service, prefs } = setup()
    await service.check()
    service.skip()
    expect(prefs().skipped).toBe('0.2.0')
    expect(service.state().visible).toBe(false)
  })

  it('dismiss hides that version until a newer one arrives', async () => {
    const backend = stubBackend('0.2.0')
    const { service, prefs } = setup({ backend })
    await service.check()
    service.dismiss()
    expect(prefs().dismissed).toBe('0.2.0')
    expect(service.state().visible).toBe(false)
    await service.check()
    expect(service.state().visible).toBe(false)
    backend.check.mockResolvedValue(found('0.3.0'))
    await service.check()
    expect(service.state()).toMatchObject({ version: '0.3.0', visible: true })
  })

  it('downloads the .deb and offers the apt command', async () => {
    const { service, backend } = setup({ kind: 'deb' })
    await service.check()
    await service.download()
    expect(backend.downloadFile).toHaveBeenCalledWith(expect.objectContaining({ url: 'Slate-0.2.0-linux-amd64.deb' }), '0.2.0', expect.any(Function))
    expect(service.state()).toMatchObject({
      phase: 'downloaded',
      visible: true,
      file: '/dl/Slate-0.2.0-linux-amd64.deb',
      command: "sudo apt install '/dl/Slate-0.2.0-linux-amd64.deb'",
    })
    service.copyCommand()
    expect(backend.copy).toHaveBeenCalledWith("sudo apt install '/dl/Slate-0.2.0-linux-amd64.deb'")
    service.showInFolder()
    expect(backend.showInFolder).toHaveBeenCalledWith('/dl/Slate-0.2.0-linux-amd64.deb')
  })

  it('downloads the dmg on a mac and opens it', async () => {
    const { service, backend } = setup({ kind: 'dmg' })
    await service.check()
    await service.download()
    expect(backend.openPath).toHaveBeenCalledWith('/dl/Slate-0.2.0-mac-arm64.dmg')
    expect(service.state().command).toContain('xattr -cr /Applications/Slate.app')
  })

  it('lets an AppImage download and install itself', async () => {
    const { service, backend } = setup({ kind: 'auto' })
    await service.check()
    await service.download()
    expect(backend.downloadAuto).toHaveBeenCalled()
    expect(service.state()).toMatchObject({ phase: 'downloaded', visible: true })
    expect(service.state().command).toBeUndefined()
    service.install()
    expect(backend.installAuto).toHaveBeenCalled()
  })

  it('opens the release page where it cannot install anything itself', async () => {
    const { service, backend } = setup({ kind: 'manual' })
    await service.check()
    await service.download()
    expect(backend.openExternal).toHaveBeenCalledWith('https://github.com/nuwanprabhath/slate/releases/tag/v0.2.0')
    expect(backend.downloadFile).not.toHaveBeenCalled()
  })

  it('copies the release URL', async () => {
    const { service, backend } = setup()
    await service.check()
    service.copyReleaseUrl()
    expect(backend.copy).toHaveBeenCalledWith('https://github.com/nuwanprabhath/slate/releases/tag/v0.2.0')
  })

  it('keeps a failed check quiet: logged, saved, never thrown or shown', async () => {
    const backend = stubBackend()
    backend.check.mockRejectedValue(new Error('offline'))
    const { service, log, prefs } = setup({ backend })
    await expect(service.check({ manual: true })).resolves.toBeUndefined()
    expect(service.state()).toMatchObject({ phase: 'error', visible: false })
    expect(prefs().lastError).toContain('offline')
    expect(String(log.mock.calls[0][0])).toContain('offline')
  })

  it('keeps a failed download quiet too, and a later success clears the saved error', async () => {
    const backend = stubBackend()
    backend.downloadFile.mockRejectedValueOnce(new Error('sha512 mismatch'))
    const { service, prefs } = setup({ backend })
    await service.check()
    await service.download()
    expect(service.state()).toMatchObject({ phase: 'error', visible: false })
    expect(prefs().lastError).toContain('sha512 mismatch')
    await service.check()
    expect(prefs().lastError).toBeUndefined()
  })

  it('does nothing when there is no update to download or install', async () => {
    const { service, backend } = setup()
    await service.download()
    service.install()
    service.copyCommand()
    expect(backend.downloadFile).not.toHaveBeenCalled()
    expect(backend.installAuto).not.toHaveBeenCalled()
    expect(backend.copy).not.toHaveBeenCalled()
  })
})

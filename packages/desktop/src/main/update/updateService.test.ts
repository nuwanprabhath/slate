import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../shared/api'
import { artifactMessage, keyIdOf, manifestMessage, UpdateSignatureError, type PinnedUpdateKey } from './signature'
import { UpdateService, type FoundUpdate, type UpdateBackend, type UpdatePrefs } from './updateService'
import { createUpdateVerifier, type UpdateVerifier, type VerifiedRelease } from './verifier'

const found = (version: string) => ({
  version,
  files: [
    { url: `Slate-${version}-mac-arm64.dmg`, sha512: 'd', size: 1 },
    { url: `Slate-${version}-linux-amd64.deb`, sha512: 'b', size: 1 },
  ],
})

function stubBackend(version = '0.2.0') {
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

/** Trusts every release as signed; the verifier itself is covered by verifier.test.ts. */
function stubVerifier() {
  return {
    release: vi.fn<UpdateVerifier['release']>(async (f) => f as VerifiedRelease),
    artifact: vi.fn<UpdateVerifier['artifact']>().mockResolvedValue(undefined),
  }
}

function setup(
  opts: {
    kind?: UpdateState['kind']
    prefs?: UpdatePrefs
    backend?: ReturnType<typeof stubBackend>
    settings?: { automaticChecks: boolean; intervalHours: number }
    verifier?: ReturnType<typeof stubVerifier>
  } = {},
) {
  const settings = { ...(opts.settings ?? { automaticChecks: true, intervalHours: 6 }) }
  const backend = opts.backend ?? stubBackend()
  let prefs: UpdatePrefs = opts.prefs ?? {}
  const states: UpdateState[] = []
  const log = vi.fn()
  const verifier = opts.verifier ?? stubVerifier()
  const diag = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new UpdateService({
    backend: backend as unknown as UpdateBackend,
    verifier,
    diag,
    kind: opts.kind ?? 'deb',
    arch: opts.kind === 'dmg' ? 'arm64' : 'x64',
    currentVersion: '0.1.0',
    loadPrefs: () => prefs,
    savePrefs: (p) => {
      prefs = p
    },
    log,
    emit: (s) => states.push(s),
    settings: () => settings,
  })
  return { settings, service, backend, states, log, verifier, diag, prefs: () => prefs }
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
    await expect(service.check({ manual: true })).resolves.toMatchObject({ phase: 'error', visible: false })
    expect(service.state()).toMatchObject({ phase: 'error', visible: false })
    expect(prefs().lastError).toContain('offline')
    expect(String(log.mock.calls[0]![0])).toContain('offline')
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

  it('waits the configured interval between scheduled checks', async () => {
    const { service, backend } = setup({ settings: { automaticChecks: true, intervalHours: 1 } })
    service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(backend.check).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('schedules nothing while automatic checks are off, yet a manual check still runs', async () => {
    const { service, backend } = setup({ settings: { automaticChecks: false, intervalHours: 6 } })
    service.start()
    await vi.advanceTimersByTimeAsync(48 * 3600_000)
    expect(backend.check).not.toHaveBeenCalled()
    const state = await service.check({ manual: true })
    expect(backend.check).toHaveBeenCalledTimes(1)
    expect(state.phase).toBe('available')
  })

  it('settingsChanged starts and stops the schedule', async () => {
    const { service, backend, settings } = setup({ settings: { automaticChecks: false, intervalHours: 6 } })
    service.start()
    settings.automaticChecks = true
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(backend.check).toHaveBeenCalledTimes(1)
    settings.automaticChecks = false
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(backend.check).toHaveBeenCalledTimes(1)
  })

  it('unskip brings a skipped version back and clears the pref', async () => {
    const { service, prefs } = setup({ prefs: { skipped: '0.2.0' } })
    await service.check()
    expect(service.state().visible).toBe(false)
    expect(service.state().skippedVersion).toBe('0.2.0')
    service.unskip()
    expect(prefs().skipped).toBeUndefined()
    expect(service.state().visible).toBe(true)
    expect(service.state().skippedVersion).toBeUndefined()
  })

  it('a manual check resolves with its own result, carrying version, time and reason', async () => {
    const { service } = setup()
    const state = await service.check({ manual: true })
    expect(state).toMatchObject({ phase: 'available', version: '0.2.0', currentVersion: '0.1.0' })
    expect(state.lastCheckedAt).toBeTypeOf('number')
    expect(state.reason).toMatch(/apt/)
  })

  it('a failed manual check resolves with the error message', async () => {
    const backend = stubBackend()
    backend.check.mockRejectedValue(new Error('offline'))
    const { service } = setup({ backend })
    const state = await service.check({ manual: true })
    expect(state.phase).toBe('error')
    expect(state.error).toMatch(/offline/)
  })

  describe('signatures (C12)', () => {
    it('T-UPD-01: never offers a release whose signature fails, and logs update.signature.failed', async () => {
      const verifier = stubVerifier()
      verifier.release.mockRejectedValue(new UpdateSignatureError('signature by abc does not verify'))
      const { service, diag, prefs } = setup({ verifier })
      const state = await service.check({ manual: true })
      expect(state).toMatchObject({ phase: 'error', visible: false })
      expect(state.error).toMatch(/does not verify/)
      expect(diag.error).toHaveBeenCalledWith('update.signature.failed', expect.objectContaining({ version: '0.2.0' }))
      expect(prefs().lastError).toMatch(/does not verify/)
      await service.download()
      expect(service.state().phase).toBe('error')
    })

    it('hands the release the verifier returned, not the feed object, to download and install', async () => {
      const { service, backend, verifier } = setup({ kind: 'auto' })
      await service.check()
      const verified = await verifier.release.mock.results[0]!.value
      await service.download()
      service.install()
      expect(backend.downloadAuto).toHaveBeenCalledWith(verified, expect.any(Function))
      expect(backend.installAuto).toHaveBeenCalledWith(verified)
    })

    it('checks the installer signature before downloading it', async () => {
      const verifier = stubVerifier()
      verifier.artifact.mockRejectedValue(new UpdateSignatureError('signature of Slate-0.2.0-linux-amd64.deb is missing'))
      const { service, backend, diag } = setup({ kind: 'deb', verifier })
      await service.check()
      await service.download()
      expect(verifier.artifact).toHaveBeenCalledWith(expect.objectContaining({ version: '0.2.0' }), expect.objectContaining({ url: 'Slate-0.2.0-linux-amd64.deb' }))
      expect(backend.downloadFile).not.toHaveBeenCalled()
      expect(service.state().phase).toBe('error')
      expect(diag.error).toHaveBeenCalledWith('update.signature.failed', expect.anything())
    })

    it('an AppImage update verifies every artefact before it downloads, and so before quitAndInstall', async () => {
      const verifier = stubVerifier()
      verifier.artifact.mockRejectedValue(new UpdateSignatureError('nope'))
      const { service, backend } = setup({ kind: 'auto', verifier })
      await service.check()
      await service.download()
      service.install()
      expect(backend.downloadAuto).not.toHaveBeenCalled()
      expect(backend.installAuto).not.toHaveBeenCalled()

      const ok = setup({ kind: 'auto' })
      await ok.service.check()
      await ok.service.download()
      ok.service.install()
      expect(ok.verifier.artifact).toHaveBeenCalledTimes(found('0.2.0').files.length)
      expect(ok.backend.installAuto).toHaveBeenCalled()
    })

    it('F2: after any failed check nothing is downloaded or installed, even with a release verified before', async () => {
      // electron-updater keeps one cached update and every check overwrites it: emulate that.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key: PinnedUpdateKey = { alg: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
      const sigFile = (m: Uint8Array) =>
        new TextEncoder().encode(JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId: keyIdOf(key.publicKeyPem), signature: sign(null, m, privateKey).toString('base64') }))
      const feedOf = (r: FoundUpdate) => new TextEncoder().encode(`version: ${r.version}\nfiles:\n${r.files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n`).join('')}`)
      const good = { version: '0.4.0', files: [{ url: 'Slate-0.4.0-x86_64.AppImage', sha512: 'R09PRA==', size: 1 }] }
      const evil = { version: '0.5.0', files: [{ url: 'Slate-0.5.0-x86_64.AppImage', sha512: 'RVZJTA==', size: 1 }] }
      const assets = new Map<string, Uint8Array>([
        ['0.4.0/latest-linux.yml', feedOf(good)],
        ['0.4.0/latest-linux.yml.sig', sigFile(manifestMessage('latest-linux.yml', feedOf(good)))],
        ['0.4.0/Slate-0.4.0-x86_64.AppImage.sig', sigFile(artifactMessage('Slate-0.4.0-x86_64.AppImage', 'R09PRA=='))],
        ['0.5.0/latest-linux.yml', feedOf(evil)],
      ])
      const verifier = createUpdateVerifier({
        keys: [key],
        manifestName: 'latest-linux.yml',
        currentVersion: '0.1.0',
        fetchAsset: async (version, name) => {
          // The reviewer's case: an oversized .sig makes the fetch throw a plain Error, not UpdateSignatureError.
          if (version === '0.5.0' && name.endsWith('.sig')) throw new Error('GET latest-linux.yml.sig: 2000000 bytes is too large')
          return assets.get(`${version}/${name}`) ?? null
        },
      })
      const run = async (step: 'download' | 'install') => {
        let cached: FoundUpdate = good
        const installed: string[] = []
        const backend = {
          ...stubBackend(),
          check: vi.fn(async () => cached),
          downloadAuto: vi.fn(async () => void installed.push(`downloaded ${cached.version}`)),
          installAuto: vi.fn(() => void installed.push(`installed ${cached.version}`)),
        }
        const { service } = setup({ kind: 'auto', backend, verifier: verifier as unknown as ReturnType<typeof stubVerifier> })
        await service.check()
        expect(service.state()).toMatchObject({ phase: 'available', version: '0.4.0' })
        if (step === 'install') await service.download()
        cached = evil
        await service.check({ manual: true })
        expect(service.state().phase).toBe('error')
        await service.download()
        service.install()
        return installed
      }
      expect(await run('download')).toEqual([])
      expect(await run('install')).toEqual(['downloaded 0.4.0'])
    })
  })
})

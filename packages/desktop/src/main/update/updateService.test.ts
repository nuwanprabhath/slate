import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../shared/api'
import { secretBytes } from '../../shared/secret'
import { FAKE_HYBRID_KEY } from './fakeBackend'
import { CHANGED_SINCE_VERIFIED } from './installCommands'
import { artifactMessage, keyIdOf, manifestMessage, UpdateSignatureError, type Ed25519UpdateKey } from './signature'
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
    needsPassword: vi.fn().mockResolvedValue(false),
    stillVerified: vi.fn().mockResolvedValue(true),
    installDownloaded: vi.fn<UpdateBackend['installDownloaded']>().mockResolvedValue({ ok: true }),
    restart: vi.fn(),
    takePreviousInstall: vi.fn<UpdateBackend['takePreviousInstall']>().mockResolvedValue(null),
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

    it('T-PQ-A2-03: with the hybrid key pinned, a release signed only with a valid v1 .sig is never offered', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const classic: Ed25519UpdateKey = { alg: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
      const rel = found('0.2.0')
      const feed = new TextEncoder().encode(`version: 0.2.0\nfiles:\n${rel.files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n`).join('')}`)
      const v1 = (m: Uint8Array) =>
        new TextEncoder().encode(JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId: keyIdOf(classic.publicKeyPem), signature: sign(null, m, privateKey).toString('base64') }))
      const assets = new Map([
        ['latest-linux.yml', feed],
        ['latest-linux.yml.sig', v1(manifestMessage('latest-linux.yml', feed))],
      ])
      const fetched: string[] = []
      const verifier = createUpdateVerifier({
        keys: [classic, FAKE_HYBRID_KEY],
        manifestName: 'latest-linux.yml',
        currentVersion: '0.1.0',
        fetchAsset: async (_version, name) => {
          fetched.push(name)
          return assets.get(name) ?? null
        },
      })
      const { service, diag } = setup({ verifier: verifier as unknown as ReturnType<typeof stubVerifier> })
      const state = await service.check({ manual: true })
      expect(state).toMatchObject({ phase: 'error', visible: false })
      expect(state.error).toMatch(/post-quantum signature missing/)
      expect(diag.error).toHaveBeenCalledWith('update.signature.failed', expect.objectContaining({ version: '0.2.0' }))
      // The v1 file was never even read.
      expect(fetched).not.toContain('latest-linux.yml.sig')
    })

    it('F2: after any failed check nothing is downloaded or installed, even with a release verified before', async () => {
      // electron-updater keeps one cached update and every check overwrites it: emulate that.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key: Ed25519UpdateKey = { alg: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
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
        await service.prepareInstall()
        return installed
      }
      expect(await run('download')).toEqual([])
      expect(await run('install')).toEqual(['downloaded 0.4.0'])
    })
  })
})

describe('UpdateService: Install and restart', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const available = async (kind: UpdateState['kind'] = 'deb', backend = stubBackend()) => {
    const ctx = setup({ kind, backend })
    await ctx.service.check()
    return ctx
  }

  it('is offered for a dmg, deb or AppImage install with a release in hand, and not where Slate cannot install', async () => {
    expect((await available('deb')).service.state().installable).toBe(true)
    expect((await available('dmg')).service.state().installable).toBe(true)
    expect((await available('auto')).service.state().installable).toBe(true)
    const { service, backend } = await available('manual')
    expect(service.state().installable).toBeUndefined()
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    expect(backend.downloadFile).not.toHaveBeenCalled()
    expect(backend.openExternal).not.toHaveBeenCalled()
  })

  it('an AppImage installs and restarts in one go: every artefact verified, downloaded, then quit and install', async () => {
    const { service, backend, verifier, states } = await available('auto')
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    expect(verifier.artifact).toHaveBeenCalledTimes(found('0.2.0').files.length)
    const verified = await verifier.release.mock.results[0]!.value
    expect(backend.downloadAuto).toHaveBeenCalledWith(verified, expect.any(Function))
    expect(backend.installAuto).toHaveBeenCalledWith(verified)
    expect(backend.needsPassword).not.toHaveBeenCalled()
    expect(states.map((s) => s.phase)).toContain('restarting')
    expect(service.state().installable).toBeUndefined()
  })

  it('an AppImage already downloaded installs and restarts without downloading again', async () => {
    const { service, backend } = await available('auto')
    await service.download()
    expect(service.state().installable).toBe(true)
    await service.prepareInstall()
    expect(backend.downloadAuto).toHaveBeenCalledTimes(1)
    expect(backend.installAuto).toHaveBeenCalledTimes(1)
  })

  it('an AppImage pressed twice while it downloads is downloaded and installed once', async () => {
    let finish!: () => void
    const backend = { ...stubBackend(), downloadAuto: vi.fn(() => new Promise<void>((r) => (finish = r))) }
    const { service } = await available('auto', backend)
    const first = service.prepareInstall()
    await vi.waitFor(() => expect(backend.downloadAuto).toHaveBeenCalled())
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    service.install()
    finish()
    await first
    expect(backend.downloadAuto).toHaveBeenCalledTimes(1)
    expect(backend.installAuto).toHaveBeenCalledTimes(1)
  })

  it('an AppImage that does not quit goes back to Try again instead of saying it is restarting forever', async () => {
    vi.useFakeTimers()
    try {
      const { service, backend } = await available('auto')
      await service.prepareInstall()
      expect(backend.installAuto).toHaveBeenCalledTimes(1)
      expect(service.state().phase).toBe('restarting')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(service.state()).toMatchObject({ phase: 'downloaded', installable: true })
      expect(service.state().installError).toMatch(/did not restart/)
      await service.prepareInstall()
      expect(backend.installAuto).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an AppImage whose artefacts do not verify is neither downloaded nor installed', async () => {
    const { service, backend, verifier } = await available('auto')
    verifier.artifact.mockRejectedValue(new UpdateSignatureError('nope'))
    await service.prepareInstall()
    expect(backend.downloadAuto).not.toHaveBeenCalled()
    expect(backend.installAuto).not.toHaveBeenCalled()
    expect(service.state().phase).toBe('error')
  })

  it('downloads and verifies, installs without a password, and restarts into it, opening nothing', async () => {
    const { service, backend, verifier, states } = await available('dmg')
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    expect(verifier.artifact).toHaveBeenCalledTimes(1)
    expect(backend.downloadFile).toHaveBeenCalledTimes(1)
    // A hand-over would open the dmg a second install could start from.
    expect(backend.openPath).not.toHaveBeenCalled()
    expect(backend.stillVerified).toHaveBeenCalledWith('/dl/Slate-0.2.0-mac-arm64.dmg', 'd')
    expect(backend.installDownloaded).toHaveBeenCalledWith('/dl/Slate-0.2.0-mac-arm64.dmg', { password: null, version: '0.2.0', sha512: 'd' })
    expect(backend.restart).toHaveBeenCalledTimes(1)
    expect(service.state()).toMatchObject({ phase: 'restarting', visible: true })
    expect([...new Set(states.map((s) => s.phase))]).toEqual(['checking', 'available', 'downloading', 'downloaded', 'installing', 'restarting'])
    expect(states.filter((s) => s.phase === 'downloading').every((s) => s.installRequested)).toBe(true)
  })

  it('waits in needs-password when sudo wants one, and installs with the password it is sent', async () => {
    const { service, backend } = await available('deb')
    backend.needsPassword.mockResolvedValue(true)
    expect(await service.prepareInstall()).toEqual({ needsPassword: true })
    expect(service.state()).toMatchObject({ phase: 'needs-password', visible: true, version: '0.2.0' })
    expect(backend.installDownloaded).not.toHaveBeenCalled()
    const password = secretBytes('hunter2')
    expect(await service.installAndRestart(password)).toEqual({ ok: true })
    expect(backend.installDownloaded).toHaveBeenCalledWith('/dl/Slate-0.2.0-linux-amd64.deb', { password, version: '0.2.0', sha512: 'b' })
    expect(service.state().phase).toBe('restarting')
    expect(backend.restart).toHaveBeenCalledTimes(1)
  })

  it('says a refused password was refused and stays on the form', async () => {
    const { service, backend } = await available('deb')
    backend.needsPassword.mockResolvedValue(true)
    backend.installDownloaded.mockResolvedValueOnce({ ok: false, reason: 'password', message: 'That password was not accepted.' })
    await service.prepareInstall()
    await service.installAndRestart(secretBytes('wrong'))
    expect(service.state()).toMatchObject({ phase: 'needs-password', installError: 'That password was not accepted.' })
    expect(backend.restart).not.toHaveBeenCalled()
    await service.installAndRestart(secretBytes('right'))
    expect(service.state().phase).toBe('restarting')
    expect(service.state().installError).toBeUndefined()
  })

  it('asks for a password without saying anything was refused when sudo wanted one after all', async () => {
    const { service, backend } = await available('deb')
    backend.installDownloaded.mockResolvedValueOnce({ ok: false, reason: 'password-required', message: '' })
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    expect(service.state()).toMatchObject({ phase: 'needs-password' })
    expect(service.state().installError).toBeUndefined()
  })

  it('keeps the verified download when the install fails, and Try again installs it without downloading again', async () => {
    const { service, backend, diag } = await available('deb')
    backend.installDownloaded.mockResolvedValueOnce({ ok: false, reason: 'install', message: 'E: Unable to locate package' })
    await service.prepareInstall()
    expect(service.state()).toMatchObject({ phase: 'downloaded', installError: 'E: Unable to locate package', installable: true, file: '/dl/Slate-0.2.0-linux-amd64.deb' })
    expect(backend.restart).not.toHaveBeenCalled()
    expect(diag.warn).toHaveBeenCalled()
    await service.prepareInstall()
    expect(backend.downloadFile).toHaveBeenCalledTimes(1)
    expect(backend.installDownloaded).toHaveBeenCalledTimes(2)
    expect(service.state().phase).toBe('restarting')
  })

  it('says why when this install cannot be replaced at all (a quarantined copy), and installs nothing', async () => {
    const { service, backend } = await available('dmg')
    backend.needsPassword.mockRejectedValue(new Error('Slate is running from a quarantined copy.'))
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    expect(service.state()).toMatchObject({ phase: 'downloaded', installError: 'Slate is running from a quarantined copy.' })
    expect(backend.installDownloaded).not.toHaveBeenCalled()
  })

  it('refuses a file that no longer matches the sha512 the signed feed names, and forgets it', async () => {
    const { service, backend } = await available('deb')
    backend.stillVerified.mockResolvedValue(false)
    await service.prepareInstall()
    expect(backend.installDownloaded).not.toHaveBeenCalled()
    expect(service.state()).toMatchObject({ phase: 'available', installError: expect.stringContaining('changed since it was verified') as string })
    expect(service.state().file).toBeUndefined()
    // The next try downloads and verifies afresh.
    backend.stillVerified.mockResolvedValue(true)
    await service.prepareInstall()
    expect(backend.downloadFile).toHaveBeenCalledTimes(2)
  })

  it('ignores a second click while the first is still downloading or asking sudo, so two installs never start', async () => {
    const { service, backend } = await available('deb')
    let release!: () => void
    backend.downloadFile.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('/dl/Slate-0.2.0-linux-amd64.deb') }))
    const first = service.prepareInstall()
    expect(await service.prepareInstall()).toEqual({ needsPassword: false })
    release()
    await first
    expect(backend.downloadFile).toHaveBeenCalledTimes(1)
    expect(backend.installDownloaded).toHaveBeenCalledTimes(1)
  })

  it('treats the root-side re-check refusing the file the same way as the one in main: forgets the download and offers a fresh one', async () => {
    const { service, backend } = await available('deb')
    backend.installDownloaded.mockResolvedValueOnce({ ok: false, reason: 'install', message: CHANGED_SINCE_VERIFIED })
    await service.prepareInstall()
    expect(service.state()).toMatchObject({ phase: 'available', installError: CHANGED_SINCE_VERIFIED })
    await service.prepareInstall()
    expect(backend.downloadFile).toHaveBeenCalledTimes(2)
  })

  it('refuses to install outside needs-password, and with nothing downloaded', async () => {
    const { service, backend } = await available('deb')
    expect(await service.installAndRestart(secretBytes('x'))).toMatchObject({ ok: false, reason: 'install' })
    await service.prepareInstall()
    expect(await service.installAndRestart(null)).toMatchObject({ ok: false, reason: 'install' })
    expect(backend.installDownloaded).toHaveBeenCalledTimes(1)
  })

  it('refuses a download of a verified release that fails verification, installing nothing', async () => {
    const { service, backend, verifier } = await available('deb')
    verifier.artifact.mockRejectedValue(new UpdateSignatureError('bad signature'))
    await service.prepareInstall()
    expect(service.state().phase).toBe('error')
    expect(backend.downloadFile).not.toHaveBeenCalled()
    expect(backend.installDownloaded).not.toHaveBeenCalled()
  })

  it('Cancel on the password form keeps the download and offers Install and restart again, without dismissing the release', async () => {
    const { service, backend, prefs } = await available('deb')
    backend.needsPassword.mockResolvedValue(true)
    await service.prepareInstall()
    service.dismiss()
    expect(service.state()).toMatchObject({ phase: 'downloaded', visible: true, installable: true })
    expect(service.state().installRequested).toBeUndefined()
    expect(prefs().dismissed).toBeUndefined()
  })

  it('stays visible while installing even if the release was dismissed or skipped before', async () => {
    const { service, backend } = setup({ kind: 'deb', prefs: { dismissed: '0.2.0', skipped: '0.2.0' } })
    await service.check({ manual: true })
    backend.needsPassword.mockResolvedValue(true)
    await service.prepareInstall()
    service.skip()
    expect(service.state()).toMatchObject({ phase: 'needs-password', visible: true })
  })

  it('is not interrupted by a check while it installs', async () => {
    const { service, backend } = await available('deb')
    backend.needsPassword.mockResolvedValue(true)
    await service.prepareInstall()
    backend.check.mockClear()
    await service.check({ manual: true })
    expect(backend.check).not.toHaveBeenCalled()
    expect(service.state().phase).toBe('needs-password')
  })

  it('no longer offers a download of an older release once a newer one is found', async () => {
    const { service, backend } = await available('deb')
    backend.installDownloaded.mockResolvedValueOnce({ ok: false, reason: 'install', message: 'x' })
    await service.prepareInstall()
    expect(service.state().installable).toBe(true)
    backend.check.mockResolvedValue(found('0.3.0'))
    await service.check({ manual: true })
    await service.prepareInstall()
    expect(backend.installDownloaded).toHaveBeenLastCalledWith('/dl/Slate-0.3.0-linux-amd64.deb', { password: null, version: '0.3.0', sha512: 'b' })
    expect(backend.downloadFile).toHaveBeenCalledTimes(2)
  })

  it('still hands the download over to install by hand: Download opens a dmg and keeps the command for a deb', async () => {
    const dmg = await available('dmg')
    await dmg.service.download()
    expect(dmg.backend.openPath).toHaveBeenCalledWith('/dl/Slate-0.2.0-mac-arm64.dmg')
    expect(dmg.service.state()).toMatchObject({ phase: 'downloaded', installable: true })
    const deb = await available('deb')
    await deb.service.download()
    expect(deb.service.state().command).toMatch(/^sudo apt install /)
    expect(deb.backend.openPath).not.toHaveBeenCalled()
  })

  describe('after the macOS helper ran', () => {
    it('says nothing when it succeeded or never ran', async () => {
      const { service, backend } = setup({ kind: 'dmg' })
      await service.restorePreviousInstall()
      backend.takePreviousInstall.mockResolvedValue({ version: '0.2.0', ok: true, message: '', path: null })
      await service.restorePreviousInstall()
      expect(service.state()).toMatchObject({ phase: 'idle', visible: false })
    })

    it('shows the failure with the installer it kept, even when that release was dismissed', async () => {
      const { service, backend } = setup({ kind: 'dmg', prefs: { dismissed: '0.2.0' } })
      backend.takePreviousInstall.mockResolvedValue({ version: '0.2.0', ok: false, message: 'The disk image could not be opened.', path: '/dl/Slate-0.2.0-mac-arm64.dmg' })
      await service.restorePreviousInstall()
      expect(service.state()).toMatchObject({
        phase: 'downloaded', visible: true, version: '0.2.0', installError: 'The disk image could not be opened.', file: '/dl/Slate-0.2.0-mac-arm64.dmg',
      })
      expect(service.state().installable).toBeUndefined()
    })
  })
})

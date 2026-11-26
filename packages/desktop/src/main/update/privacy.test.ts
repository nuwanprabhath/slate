import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISCLOSURES } from '../../shared/privacy/consent'
import { DocStore } from '../store'
import { readSettings, writeSettings } from '../settings'
import { createPlatformInstaller } from './platformInstaller'
import { scheduledUpdateSettings, UpdateService, type UpdateBackend } from './updateService'
import type { UpdateVerifier, VerifiedRelease } from './verifier'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'slate-updpriv-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.useRealTimers()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const grant = { grantedAt: 1, textVersion: DISCLOSURES.updates.textVersion, source: 'user' as const }
const fresh = () => new DocStore(join(tmp(), 'slate.db'))

function service(open: () => DocStore | null) {
  const backend = {
    check: vi.fn().mockResolvedValue(null),
    takePreviousInstall: vi.fn().mockResolvedValue(null),
    stillVerified: vi.fn().mockResolvedValue(true),
    removeDownload: vi.fn().mockResolvedValue(undefined),
  }
  const verifier = { release: vi.fn(async (f: unknown) => f as VerifiedRelease), artifact: vi.fn() } as unknown as UpdateVerifier
  const diag = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const svc = new UpdateService({
    backend: backend as unknown as UpdateBackend, verifier, diag, kind: 'deb', arch: 'x64', currentVersion: '0.1.0',
    loadPrefs: () => ({}), savePrefs: () => undefined, log: vi.fn(), emit: () => undefined,
    settings: () => scheduledUpdateSettings(open()),
  })
  return { svc, backend, diag }
}

describe('update schedule and consent (GDPR-02)', () => {
  it('locked: no timer, and a manual check still runs', async () => {
    vi.useFakeTimers()
    const { svc, backend } = service(() => null)
    svc.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backend.check).not.toHaveBeenCalled()
    await svc.check({ manual: true })
    expect(backend.check).toHaveBeenCalledTimes(1)
  })

  it('strict without consent: no timer; manual check runs', async () => {
    vi.useFakeTimers()
    const db = fresh()
    const { svc, backend } = service(() => db)
    svc.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backend.check).not.toHaveBeenCalled()
    await svc.check({ manual: true })
    expect(backend.check).toHaveBeenCalledTimes(1)
  })

  it('a grant arms the timer and a revoke clears it', async () => {
    vi.useFakeTimers()
    const db = fresh()
    const { svc, backend } = service(() => db)
    svc.start()
    writeSettings(db, {}, {})
    db.setSetting('settings', { ...readSettings(db), consents: { updates: grant } })
    svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(backend.check).toHaveBeenCalledTimes(1)
    db.setSetting('settings', { ...readSettings(db), consents: {} })
    svc.settingsChanged()
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(backend.check).toHaveBeenCalledTimes(1)
  })

  it('a legacy record from an existing install arms the timer', () => {
    const db = fresh()
    db.setSetting('settings', { updateAutomaticChecks: true })
    expect(scheduledUpdateSettings(db).automaticChecks).toBe(true)
  })
})

describe('installer left behind (GDPR-19)', () => {
  it('deletes a verified download after a successful install', async () => {
    const { svc, backend } = service(() => null)
    backend.takePreviousInstall.mockResolvedValue({ version: '0.2.0', ok: true, message: '', path: '/dl/a.dmg', sha512: 'h' })
    await svc.restorePreviousInstall()
    expect(backend.stillVerified).toHaveBeenCalledWith('/dl/a.dmg', 'h')
    expect(backend.removeDownload).toHaveBeenCalledWith('/dl/a.dmg')
  })

  it('keeps a file that no longer verifies, and says so', async () => {
    const { svc, backend, diag } = service(() => null)
    backend.stillVerified.mockResolvedValue(false)
    backend.takePreviousInstall.mockResolvedValue({ version: '0.2.0', ok: true, message: '', path: '/dl/a.dmg', sha512: 'h' })
    await svc.restorePreviousInstall()
    expect(backend.removeDownload).not.toHaveBeenCalled()
    expect(diag.warn).toHaveBeenCalledWith('kept unverified download', expect.anything())
  })

  it('the installer carries the hash noted before quit through takePreviousInstall and removes only a .dmg in Downloads', async () => {
    const root = tmp()
    const downloads = join(root, 'dl')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(downloads)
    const dmg = join(downloads, 'Slate.dmg')
    writeFileSync(dmg, 'x')
    const resultFile = join(root, 'update-result.json')
    const inst = createPlatformInstaller({ platform: 'linux', resultFile, quit: () => undefined, log: { info() {}, warn() {}, error() {} } as never, downloadsDir: downloads, scriptsDir: root })
    writeFileSync(resultFile, JSON.stringify({ version: '0.6.0', ok: true, message: '', path: dmg }))
    writeFileSync(`${resultFile}.download`, JSON.stringify({ path: dmg, sha512: 'abc' }))
    expect(await inst.takePreviousInstall()).toMatchObject({ ok: true, path: dmg, sha512: 'abc' })
    expect(existsSync(`${resultFile}.download`)).toBe(false)
    const other = join(root, 'keep.dmg')
    writeFileSync(other, 'x')
    await inst.removeDownload?.(other)
    expect(existsSync(other)).toBe(true)
    await inst.removeDownload?.(dmg)
    expect(existsSync(dmg)).toBe(false)
  })
})

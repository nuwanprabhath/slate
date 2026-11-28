import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISCLOSURES } from '../shared/privacy/consent'
import { readSettings, setLegacyPrivacyContext, writeSettings } from './settings'
import { DocStore } from './store'
import { registerIpc } from './ipc'
import { CH } from '../shared/ipc'
import type { Handler, IpcRegistrar } from './ipcGuard'

// registerIpc's own listeners tell the windows and the log about a write; neither exists in a unit test.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, clipboard: {}, dialog: {} }))
vi.mock('./log/configure', () => ({ configureLogging: () => {} }))

const dirs: string[] = []
function tempStore(): DocStore {
  const dir = mkdtempSync(join(tmpdir(), 'slate-settings-privacy-'))
  dirs.push(dir)
  return new DocStore(join(dir, 'slate.db'))
}
afterEach(() => {
  setLegacyPrivacyContext({ encrypted: () => false })
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const legacy = (f: keyof typeof DISCLOSURES) => ({ grantedAt: expect.any(Number) as number, textVersion: DISCLOSURES[f].textVersion, source: 'legacy' })

describe('GDPR strict mode for existing and fresh installs (§3.1 step 4)', () => {
  it('a fresh install (no settings row) gets strict mode and no consents', () => {
    const store = tempStore()
    expect(readSettings(store)).toMatchObject({ gdprStrictMode: true })
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })

  it('an existing install gets strict mode with legacy grants for what it already uses, written back once', () => {
    const store = tempStore()
    store.setSetting('settings', { syncProvider: 'git', git: { remoteUrl: 'git@github.com:me/notes.git', branch: 'main', auth: 'system' }, updateAutomaticChecks: true, msClientId: 'abc' })
    const s = readSettings(store)
    expect(s.gdprStrictMode).toBe(true)
    expect(s.consents).toEqual({ gitSync: legacy('gitSync'), plaintextSync: legacy('plaintextSync'), updates: legacy('updates'), microsoftSignIn: legacy('microsoftSignIn') })
    const stored = store.getSetting<Record<string, unknown>>('settings')
    expect(stored).toMatchObject({ gdprStrictMode: true, consents: s.consents })
    // Written once: a later read changes nothing, even after the person withdrew a grant.
    writeSettings(store, { consents: {} })
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })

  it('a downgrade to 0.7.14 and back does not grant again what the person withdrew, nor turn strict mode back on (blast radius R2)', () => {
    const store = tempStore()
    store.setSetting('settings', { syncProvider: null, updateAutomaticChecks: true })
    expect(readSettings(store).consents).toEqual({ updates: legacy('updates') })
    writeSettings(store, { consents: {}, gdprStrictMode: false })
    // 0.7.14's sanitizePatch keeps only its own keys, so its next settings write drops both.
    const { gdprStrictMode: _strict, consents: _consents, ...older } = store.getSetting<Record<string, unknown>>('settings')!
    store.setSetting('settings', { ...older, fontSize: 15 })
    const again = readSettings(store)
    expect(again.consents).toEqual({})
    expect(again.gdprStrictMode).toBe(false)
    expect(store.getSetting<Record<string, unknown>>('settings')).toMatchObject({ gdprStrictMode: false, consents: {} })
    // A grant made since is what comes back after the next round trip.
    writeSettings(store, { consents: { updates: { grantedAt: 5, textVersion: DISCLOSURES.updates.textVersion, source: 'user' } } })
    const { gdprStrictMode: _s2, consents: _c2, ...older2 } = store.getSetting<Record<string, unknown>>('settings')!
    store.setSetting('settings', older2)
    expect(readSettings(store).consents).toEqual({ updates: { grantedAt: 5, textVersion: DISCLOSURES.updates.textVersion, source: 'user' } })
    store.close()
  })

  it('an install 0.8.0 migrated keeps a copy of its choices from its first read, so a later downgrade cannot undo them', () => {
    const store = tempStore()
    store.setSetting('settings', { updateAutomaticChecks: true, gdprStrictMode: false, consents: {} })
    expect(readSettings(store).gdprStrictMode).toBe(false)
    const { gdprStrictMode: _s, consents: _c, ...older } = store.getSetting<Record<string, unknown>>('settings')!
    store.setSetting('settings', older)
    expect(readSettings(store)).toMatchObject({ gdprStrictMode: false, consents: {} })
    store.close()
  })

  it('a withdrawal made by 0.8.0 or 0.8.1 (which keep no copy) is what a later downgrade and upgrade restores (security review of correct)', () => {
    const store = tempStore()
    const granted = { updates: { grantedAt: 5, textVersion: DISCLOSURES.updates.textVersion, source: 'user' as const } }
    writeSettings(store, { gdprStrictMode: true, consents: granted })
    // 0.8.1 withdraws: it rewrites only the settings row.
    store.setSetting('settings', { ...store.getSetting<Record<string, unknown>>('settings')!, consents: {} })
    expect(readSettings(store).consents).toEqual({})
    // 0.7.14 then drops both keys from the row.
    const { gdprStrictMode: _s, consents: _c, ...older } = store.getSetting<Record<string, unknown>>('settings')!
    store.setSetting('settings', older)
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })

  it('OneDrive sync keeps its sign-in, and a vault means no plaintext-sync grant', () => {
    setLegacyPrivacyContext({ encrypted: () => true })
    const store = tempStore()
    store.setSetting('settings', { syncProvider: 'onedrive', updateAutomaticChecks: false })
    expect(readSettings(store).consents).toEqual({ oneDriveSync: legacy('oneDriveSync'), microsoftSignIn: legacy('microsoftSignIn') })
    store.close()
  })

  it('an existing install that used nothing gets strict mode and no grants', () => {
    const store = tempStore()
    store.setSetting('settings', { updateAutomaticChecks: false, autoBullets: false })
    expect(readSettings(store)).toMatchObject({ gdprStrictMode: true, autoBullets: false })
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })

  it('a stored strict-mode choice is kept, never migrated again', () => {
    const store = tempStore()
    store.setSetting('settings', { gdprStrictMode: false, syncProvider: 'onedrive' })
    expect(readSettings(store)).toMatchObject({ gdprStrictMode: false })
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })

  it('a window cannot write consents through settings:set', () => {
    const store = tempStore()
    const forged = { updates: { grantedAt: 1, textVersion: DISCLOSURES.updates.textVersion, source: 'user' as const } }
    writeSettings(store, { consents: forged, autoBullets: false }, { fromRenderer: true })
    expect(readSettings(store)).toMatchObject({ autoBullets: false })
    expect(readSettings(store).consents).toEqual({})
    writeSettings(store, { consents: forged })
    expect(readSettings(store).consents).toEqual(forged)
    store.close()
  })
})

describe('settings:set from a window', () => {
  it('drops consents and keeps the rest, strict mode included', async () => {
    const store = tempStore()
    const handlers = new Map<string, Handler>()
    const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
    registerIpc(ipc, () => store, () => {
      throw new Error('no blobs here')
    })
    const forged = { updates: { grantedAt: 1, textVersion: DISCLOSURES.updates.textVersion, source: 'user' } }
    await handlers.get(CH.settingsSet)!({} as never, { consents: forged, gdprStrictMode: false })
    expect(readSettings(store)).toMatchObject({ gdprStrictMode: false })
    expect(readSettings(store).consents).toEqual({})
    store.close()
  })
})


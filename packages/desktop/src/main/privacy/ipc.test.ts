import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PurgeScope, Settings } from '../../shared/api'
import { CH } from '../../shared/ipc'
import { CONSENT_FEATURES, DISCLOSURES } from '../../shared/privacy/consent'
import type { Handler, IpcRegistrar } from '../ipcGuard'
import { onSettingsWritten, readSettings } from '../settings'
import { DocStore } from '../store'
import type { DataRights } from './dataRights'
import { createConsents, registerPrivacyIpc, type PrivacyDeps } from './ipc'
import type { Retention } from './retention'

const dirs: string[] = []
const stores: DocStore[] = []
function tempStore(): DocStore {
  const dir = mkdtempSync(join(tmpdir(), 'slate-privacy-ipc-'))
  dirs.push(dir)
  const store = new DocStore(join(dir, 'slate.db'))
  stores.push(store)
  return store
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function setup(profile: 'standard' | 'fips-140-3' | null = null) {
  const store = tempStore()
  const calls: string[] = []
  const retention: Retention = {
    purge: async (scope: PurgeScope) => (calls.push(`purge:${scope}`), { scope, blobs: 0, tempDirs: 0, bytesFreed: 0, logsCleared: false, auditCleared: false }),
    clearAudit: () => void calls.push('clearAudit'),
    readSecurityLog: () => (calls.push('readSecurityLog'), 'log text'),
    clearSecurityLog: () => void calls.push('clearSecurityLog'),
    sweepTemp: async () => (calls.push('sweepTemp'), 0),
  }
  const dataRights: DataRights = {
    exportAll: async () => (calls.push('exportAll'), null),
    eraseHistory: async (docId: string) => void calls.push(`eraseHistory:${docId}`),
    eraseAll: async () => void calls.push('eraseAll'),
  }
  const deps: PrivacyDeps = {
    ...createConsents({ store: () => store, profile: () => profile, now: () => 1234 }),
    retention,
    dataRights,
    sync: () => ({ forget: async () => void calls.push('syncForget') }),
  }
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  registerPrivacyIpc(ipc, deps)
  const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({} as never, ...args))
  return { store, calls, handlers, call }
}

describe('registerPrivacyIpc', () => {
  it('registers every privacy channel', () => {
    const { handlers } = setup()
    for (const ch of [CH.privacyStatus, CH.privacyGrant, CH.privacyRevoke, CH.privacyExport, CH.privacyPurge, CH.privacyEraseHistory, CH.privacyEraseAll, CH.privacySecurityLogRead, CH.privacySecurityLogClear, CH.auditClear, CH.syncForget]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('status: strict mode on, nothing allowed, no legacy grants on a fresh install', async () => {
    const { call } = setup('standard')
    expect(await call(CH.privacyStatus)).toEqual({
      gdprStrictMode: true,
      consents: {},
      allowed: Object.fromEntries(CONSENT_FEATURES.map((f) => [f, false])),
      legacy: [],
      profile: 'standard',
    })
  })

  it('grant stamps a user record for the current disclosure, and revoke removes it', async () => {
    const { call, store } = setup()
    const written: Settings[] = []
    const off = onSettingsWritten((s) => written.push(s))
    try {
      const granted = (await call(CH.privacyGrant, 'updates')) as { allowed: Record<string, boolean> }
      expect(readSettings(store).consents).toEqual({ updates: { grantedAt: 1234, textVersion: DISCLOSURES.updates.textVersion, source: 'user' } })
      expect(granted.allowed.updates).toBe(true)
      // A settings write, so the update schedule re-arms through onSettingsWritten.
      expect(written.at(-1)?.consents.updates?.source).toBe('user')
      const revoked = (await call(CH.privacyRevoke, 'updates')) as { allowed: Record<string, boolean> }
      expect(readSettings(store).consents).toEqual({})
      expect(revoked.allowed.updates).toBe(false)
      expect(written).toHaveLength(2)
    } finally {
      off()
    }
  })

  it('a re-grant replaces a legacy record with a user one, and status lists legacy grants', async () => {
    const { call, store } = setup()
    store.setSetting('settings', { syncProvider: 'onedrive', updateAutomaticChecks: true })
    expect(((await call(CH.privacyStatus)) as { legacy: string[] }).legacy.sort()).toEqual(['microsoftSignIn', 'oneDriveSync', 'plaintextSync', 'updates'])
    await call(CH.privacyGrant, 'updates')
    expect(readSettings(store).consents.updates?.source).toBe('user')
    expect(((await call(CH.privacyStatus)) as { legacy: string[] }).legacy).not.toContain('updates')
  })

  it('passes each well-formed call to its backend', async () => {
    const { call, calls } = setup()
    const docId = 'page:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(await call(CH.privacyExport)).toBeNull()
    await call(CH.privacyPurge, 'logs')
    await call(CH.privacyEraseHistory, docId)
    await call(CH.privacyEraseAll, 'ERASE')
    expect(await call(CH.privacySecurityLogRead)).toBe('log text')
    await call(CH.privacySecurityLogClear)
    await call(CH.auditClear)
    await call(CH.syncForget)
    expect(calls).toEqual(['exportAll', 'purge:logs', `eraseHistory:${docId}`, 'eraseAll', 'readSecurityLog', 'clearSecurityLog', 'clearAudit', 'syncForget'])
  })

  it('refuses malformed arguments before any backend or the settings are reached', async () => {
    const { call, calls, store } = setup()
    const bad: Array<[string, unknown[]]> = [
      [CH.privacyGrant, ['everything']],
      [CH.privacyGrant, []],
      [CH.privacyGrant, [{ feature: 'updates' }]],
      [CH.privacyRevoke, ['__proto__']],
      [CH.privacyPurge, ['blobs']],
      [CH.privacyPurge, []],
      [CH.privacyEraseHistory, ['test:1']],
      [CH.privacyEraseHistory, [5]],
      [CH.privacyEraseAll, ['erase']],
      [CH.privacyEraseAll, [true]],
      [CH.privacyEraseAll, []],
    ]
    for (const [channel, args] of bad) await expect(call(channel, ...args), `${channel} ${JSON.stringify(args)}`).rejects.toThrow(`Refused a malformed ${channel} request`)
    expect(calls).toEqual([])
    expect(store.getSetting('settings')).toBeUndefined()
  })
})

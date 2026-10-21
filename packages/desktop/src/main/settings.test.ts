import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, writeSettings } from './settings'
import { DocStore } from './store'

const dirs: string[] = []
function tempStore(): DocStore {
  const dir = mkdtempSync(join(tmpdir(), 'slate-settings-'))
  dirs.push(dir)
  return new DocStore(join(dir, 'slate.db'))
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('settings', () => {
  it('turns Phase 4 syncEnabled into the OneDrive provider', () => {
    const store = tempStore()
    store.setSetting('settings', { syncEnabled: true, deviceId: 'd1' })
    expect(readSettings(store)).toMatchObject({ syncProvider: 'onedrive', git: null, deviceId: 'd1' })
    expect(readSettings(store)).not.toHaveProperty('syncEnabled')
    store.close()
  })

  it('leaves sync off for syncEnabled false, and an explicit provider wins', () => {
    const store = tempStore()
    store.setSetting('settings', { syncEnabled: false })
    expect(readSettings(store).syncProvider).toBeNull()
    store.setSetting('settings', { syncEnabled: true, syncProvider: null })
    expect(readSettings(store).syncProvider).toBeNull()
    store.close()
  })

  it('writes the git settings and drops the old flag', () => {
    const store = tempStore()
    store.setSetting('settings', { syncEnabled: true })
    const git = { remoteUrl: 'git@github.com:me/notes.git', branch: 'main', auth: 'system' as const }
    writeSettings(store, { syncProvider: 'git', git })
    expect(store.getSetting('settings')).not.toHaveProperty('syncEnabled')
    expect(readSettings(store)).toMatchObject({ syncProvider: 'git', git })
    store.close()
  })
})

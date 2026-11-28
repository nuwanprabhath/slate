import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import type { Settings } from '../../shared/api'
import { FileBlobStore } from '../blobs'
import type { SearchIndex } from '../search/searchIndex'
import type { SecretStorage } from '../secretStorage'
import { DocStore } from '../store'
import { createDataRights, type DataRightsDeps, type DataRightsPlatform } from './dataRights'
import { VaultBusy } from '../vault/busy'
import type { Retention } from './retention'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'slate-rights-'))
  dirs.push(d)
  return d
}
const stores: DocStore[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const notImplemented = (): never => {
  throw new Error('not implemented')
}
const retention: Retention = { purge: () => Promise.reject(new Error('x')), clearAudit: notImplemented, readSecurityLog: () => 'log', clearSecurityLog: notImplemented, sweepTemp: () => Promise.resolve(0) }
const secrets: SecretStorage = { available: () => Promise.resolve(true), seal: () => Promise.resolve(Buffer.from('sealed')), open: () => Promise.resolve({ plain: 'x', rewrite: false }) } as unknown as SecretStorage

function setup(settings: Partial<Settings> = {}, platform: Partial<DataRightsPlatform> = {}, vaultMigrating = false, busy = new VaultBusy()) {
  const dataDir = temp()
  const store = new DocStore(join(dataDir, 'slate.db'), { compact: false })
  stores.push(store)
  const calls: string[] = []
  const docChanged = vi.fn()
  const deps: DataRightsDeps = {
    store: () => store,
    blobs: () => new FileBlobStore(join(dataDir, 'blobs')),
    search: () => ({ docChanged }) as unknown as SearchIndex,
    sync: notImplemented,
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    dataDir,
    profile: () => null,
    appVersion: '1.0.0',
    retention,
    auth: { status: notImplemented, token: notImplemented, signIn: notImplemented, signOut: async () => void calls.push('signOut') },
    secrets,
    closeNotes: async () => {
      calls.push('closeNotes')
      store.close()
      stores.splice(stores.indexOf(store), 1)
    },
    forgetQuickUnlock: async () => void calls.push('forgetQuickUnlock'),
    relaunch: () => void calls.push('relaunch'),
    unfinishedMigration: () => vaultMigrating,
    busy,
  }
  const plat: DataRightsPlatform = { pickFolder: async () => null, clearBrowserStorage: async () => void calls.push('clearBrowserStorage'), confirmEraseAll: async () => true, ...platform }
  return { dataDir, store, calls, docChanged, rights: createDataRights(deps, plat) }
}

describe('createDataRights', () => {
  it('exportAll: null when the folder dialog is cancelled; otherwise the report of a new folder in the chosen one', async () => {
    expect(await setup().rights.exportAll()).toBeNull()
    const parent = temp()
    const report = await setup({}, { pickFolder: async () => parent }).rights.exportAll()
    expect(report?.folder.startsWith(join(parent, 'Slate export '))).toBe(true)
    expect(report).toMatchObject({ pages: 0, images: 0 })
    expect(readdirSync(report!.folder).sort()).toEqual(['ai-audit.json', 'conflicts.json', 'manifest.json', 'security-log.txt', 'settings.json'])
  })

  it('exportAll is refused before any dialog when the notes are closed (a locked vault)', async () => {
    const pickFolder = vi.fn(async () => temp())
    const locked = createDataRights({ ...({} as DataRightsDeps), store: () => { throw new Error('Locked') } }, { pickFolder, clearBrowserStorage: async () => {}, confirmEraseAll: async () => true })
    await expect(locked.exportAll()).rejects.toThrow('Locked')
    expect(pickFolder).not.toHaveBeenCalled()
  })

  it('eraseHistory is refused while sync is on', async () => {
    await expect(setup({ syncProvider: 'git' }).rights.eraseHistory('page:00000000-0000-4000-8000-000000000001')).rejects.toThrow(/Turn sync off first/)
  })

  it('eraseHistory erases a page that was never synced, re-indexes it, and refuses one that was (GDPR-04)', async () => {
    const PAGE = 'page:00000000-0000-4000-8000-000000000001'
    const OTHER = 'page:00000000-0000-4000-8000-000000000002'
    const { store, docChanged, rights } = setup()
    for (const id of [PAGE, OTHER]) {
      const doc = new LoroDoc()
      doc.getText('t').insert(0, 'words')
      doc.commit()
      store.append(id, doc.export({ mode: 'update' }))
      doc.free()
    }
    await rights.eraseHistory(PAGE)
    expect(store.load(PAGE)).toHaveLength(1)
    expect(docChanged).toHaveBeenCalledWith(PAGE)
    store.setSyncMeta(`pushed:${OTHER}`, new Uint8Array([0]))
    await expect(rights.eraseHistory(OTHER)).rejects.toThrow(/has been synced/)
  })

  it('eraseAll signs out, closes the notes, forgets quick unlock, deletes the data files, clears browser storage, then relaunches', async () => {
    const { dataDir, calls, rights } = setup()
    mkdirSync(join(dataDir, 'git-sync'), { recursive: true })
    for (const f of ['vault.json', 'msal-cache.bin', 'slate.lock', join('git-sync', 'token.bin')]) writeFileSync(join(dataDir, f), 'x')
    await rights.eraseAll()
    expect(calls).toEqual(['signOut', 'closeNotes', 'forgetQuickUnlock', 'clearBrowserStorage', 'relaunch'])
    expect(readdirSync(dataDir)).toEqual(['slate.lock'])
    expect(existsSync(join(dataDir, 'slate.db'))).toBe(false)
  })

  it('historyEraseBlocker says up front why a page cannot be erased: sync on, then a page that was synced (UI review 3)', async () => {
    const page = 'page:00000000-0000-4000-8000-0000000000aa'
    const on = setup({ syncProvider: 'git' })
    expect(await on.rights.historyEraseBlocker(page)).toMatch(/^Turn sync off first/)
    const off = setup()
    off.store.append(page, new Uint8Array([1]))
    expect(await off.rights.historyEraseBlocker(page)).toBeNull()
    off.store.setSyncMeta(`git:file:///r#main:pushed:${page}`, new Uint8Array([1]))
    expect(await off.rights.historyEraseBlocker(page)).toMatch(/^This page has been synced/)
  })

  it('eraseAll asks in main too: answered Cancel, nothing is closed or removed (security review: the renderer is untrusted)', async () => {
    const confirmEraseAll = vi.fn(async () => false)
    const { dataDir, calls, rights } = setup({}, { confirmEraseAll })
    for (const f of ['vault.json', 'msal-cache.bin']) writeFileSync(join(dataDir, f), 'x')
    expect(await rights.eraseAll()).toBe(false)
    expect(confirmEraseAll).toHaveBeenCalledOnce()
    expect(calls).toEqual([])
    for (const f of ['vault.json', 'msal-cache.bin', 'slate.db']) expect(existsSync(join(dataDir, f)), f).toBe(true)
  })

  it('eraseAll is refused while a migration runs (the vault\'s own VaultBusy), and none can start during the erase (security review of correct)', async () => {
    // A running encryption leaves vault.state at 'plaintext'; only VaultBusy knows it runs.
    const busy = new VaultBusy()
    let finish = () => {}
    const running = busy.run(() => new Promise<void>((resolve) => (finish = resolve)))
    const confirmEraseAll = vi.fn(async () => true)
    const a = setup({}, { confirmEraseAll }, false, busy)
    writeFileSync(join(a.dataDir, 'vault.json'), 'x')
    await expect(a.rights.eraseAll()).rejects.toMatchObject({ name: 'EraseWhileMigrating' })
    expect(confirmEraseAll).not.toHaveBeenCalled()
    expect(existsSync(join(a.dataDir, 'vault.json'))).toBe(true)
    finish()
    await running

    // One started while main's dialog is open is seen too, and nothing is removed.
    const late = new VaultBusy()
    let release = () => {}
    let started: Promise<void> | undefined
    const b = setup({}, { confirmEraseAll: async () => ((started = late.run(() => new Promise<void>((r) => (release = r)))), true) }, false, late)
    writeFileSync(join(b.dataDir, 'vault.json'), 'x')
    await expect(b.rights.eraseAll()).rejects.toMatchObject({ name: 'EraseWhileMigrating' })
    expect(b.calls).toEqual([])
    expect(existsSync(join(b.dataDir, 'vault.json'))).toBe(true)
    release()
    await started

    // While the erase runs, a migration cannot start.
    const during = new VaultBusy()
    const c = setup({}, {}, false, during)
    let refused: unknown = null
    const erasing = c.rights.eraseAll()
    await Promise.resolve()
    await during.run(async () => {}).catch((e: unknown) => (refused = e))
    await erasing
    expect(String(refused)).toMatch(/Wait for the encryption/)
  })

  it('eraseAll is refused while the notes are being encrypted, before asking (blast radius R4b)', async () => {
    const confirmEraseAll = vi.fn(async () => true)
    const { dataDir, calls, rights } = setup({}, { confirmEraseAll }, true)
    writeFileSync(join(dataDir, 'vault.json'), 'x')
    await expect(rights.eraseAll()).rejects.toMatchObject({ name: 'EraseWhileMigrating' })
    expect(confirmEraseAll).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(true)
  })
})

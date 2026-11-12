import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CH } from '../shared/ipc'
import type { BackupPick, SearchQuery } from '../shared/api'
import { MAX_UPDATE_BYTES } from '../shared/ipcValidators'
import { clearBackupPick, isSearchQuery, registerSearchIpc } from './ipc'
import type { SearchIndex } from './search/searchIndex'
import { allHandlers, fakeRegistrar } from '../../test/ipcHarness'

const good: SearchQuery = { text: 'zeta', matchCase: false, wholeWord: false, regex: false, scope: { kind: 'all' } }

describe('registerSearchIpc', () => {
  it('passes a well-formed query to the index', () => {
    const { ipc, handlers } = fakeRegistrar()
    const seen: SearchQuery[] = []
    registerSearchIpc(ipc, () => ({ query: (q: SearchQuery) => (seen.push(q), { pages: [], total: 0, truncated: false }) }) as unknown as SearchIndex)
    handlers.get(CH.searchQuery)!({} as never, good)
    expect(seen).toEqual([good])
  })

  it('refuses a malformed query from the renderer before it reaches the index', () => {
    const { ipc, handlers } = fakeRegistrar()
    let called = false
    registerSearchIpc(ipc, () => ({ query: () => ((called = true), { pages: [], total: 0, truncated: false }) }) as unknown as SearchIndex)
    for (const bad of [null, 'zeta', { ...good, text: 5 }, { ...good, scope: { kind: 'notebook' } }, { ...good, regex: 'yes' }, { ...good, text: 'x'.repeat(10_001) }]) {
      expect(() => handlers.get(CH.searchQuery)!({} as never, bad), JSON.stringify(bad)?.slice(0, 40)).toThrow(/Refused a malformed search:query request/)
    }
    expect(called).toBe(false)
  })

  it('isSearchQuery accepts each scope kind', () => {
    expect(isSearchQuery(good)).toBe(true)
    expect(isSearchQuery({ ...good, scope: { kind: 'section', id: 's1' } })).toBe(true)
    expect(isSearchQuery({ ...good, scope: { kind: 'elsewhere' } })).toBe(false)
  })
})

// C1 (review F7): every `invoke` channel checks its arguments before main acts on them. The table
// sends each one a wrong type, an oversized value and a missing argument, and asserts the channel's
// fixed refusal and that no service was reached.
const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const docId = `page:${uuid}`
const git = { remoteUrl: 'https://example.invalid/notes.git', branch: 'main', auth: 'system' }

const malformed: Array<[channel: string, args: unknown[]]> = [
  [CH.docsList, ['page']],
  [CH.docsList, [`page:${'x'.repeat(10_000)}`]],
  [CH.docsList, []],
  [CH.docsLoad, [5]],
  [CH.docsLoad, ['test:1']],
  [CH.docsLoad, [`page:${'a'.repeat(20_000)}`]],
  [CH.docsLoad, []],
  [CH.docsAppend, [docId, 'bytes']],
  [CH.docsAppend, [docId, new Uint8Array(MAX_UPDATE_BYTES + 1)]],
  [CH.docsAppend, [docId]],
  [CH.docsAppend, ['test:1', new Uint8Array(1)]],
  [CH.docsRemove, [5]],
  [CH.docsRemove, [`section:${uuid}`]],
  [CH.docsRemove, []],
  [CH.blobsPut, ['not bytes', 'image/png']],
  [CH.blobsPut, [new Uint8Array(1), 'text/html']],
  [CH.blobsPut, [new Uint8Array(1)]],
  [CH.settingsSet, [5]],
  [CH.settingsSet, [null]],
  [CH.settingsSet, []],
  [CH.auditList, ['200']],
  [CH.auditList, [0]],
  [CH.auditList, [1001]],
  [CH.auditList, [1.5]],
  [CH.syncSetEnabled, ['yes']],
  [CH.syncSetEnabled, []],
  [CH.syncConfigure, [null]],
  [CH.syncConfigure, [{ provider: 'dropbox' }]],
  [CH.syncConfigure, []],
  [CH.syncTestGit, [null]],
  [CH.syncTestGit, [{ ...git, auth: 'sudo' }]],
  [CH.syncTestGit, [git, 't'.repeat(501)]],
  [CH.syncTestGit, []],
  [CH.syncCreateRepo, ['notes']],
  [CH.syncCreateRepo, ['notes', 'sudo']],
  [CH.syncCreateRepo, [5, 'system']],
  [CH.syncCreateRepo, ['n'.repeat(201), 'system']],
  [CH.syncConflicts, ['page:1']],
  [CH.syncConflicts, [5]],
  [CH.syncResolve, [uuid]],
  [CH.syncResolve, [uuid, 'whatever']],
  [CH.syncResolve, [5, 'mine']],
  [CH.syncResolve, ['i'.repeat(201), 'mine']],
  [CH.syncOpened, [5]],
  [CH.syncOpened, ['nope']],
  [CH.syncOpened, []],
  [CH.onenoteStartBackup, [uuid, 'ids']],
  [CH.onenoteStartBackup, [uuid, ['i'.repeat(501)]]],
  [CH.onenoteStartBackup, [uuid]],
  // C2: a path, where only an id main handed out is accepted.
  [CH.onenoteStartBackup, [['/tmp/a.one'], []]],
  [CH.onenoteStartBackup, ['/tmp/a.one', []]],
  [CH.onenoteStart, ['id']],
  [CH.onenoteStart, [['i'.repeat(10_001)]]],
  [CH.onenoteStart, []],
  [CH.onenoteSetClientId, [5]],
  [CH.onenoteSetClientId, ['x'.repeat(201)]],
  [CH.onenoteSetClientId, []],
  [CH.blobsCopyRich, [1, '']],
  [CH.blobsCopyRich, ['x'.repeat(16 * 1024 * 1024 + 1), '']],
  [CH.blobsCopyRich, ['text']],
  [CH.blobsCopyImage, [5]],
  [CH.blobsCopyImage, ['u'.repeat(4097)]],
  [CH.blobsCopyImage, []],
  [CH.themesSave, ['not a spec']],
  [CH.themesSave, [{ name: 'x' }, 'p'.repeat(2001)]],
  [CH.themesSave, []],
  [CH.themesRename, [`user:${uuid}`]],
  [CH.themesRename, [uuid, 'Name']],
  [CH.themesRename, [`user:${uuid}`, 'n'.repeat(201)]],
  [CH.themesRemove, ['builtin:dark']],
  [CH.themesRemove, []],
  [CH.themesGenerate, [5, null]],
  [CH.themesGenerate, ['r'.repeat(10_001), null]],
  [CH.themesGenerate, ['make it blue', 'spec']],
  [CH.themesGenerate, []],
]

describe('every invoke handler validates its arguments first (C1)', () => {
  it('refuses a wrong type, an oversized value and a missing argument on each channel', async () => {
    const { handlers, reached } = allHandlers()
    for (const [channel, args] of malformed) {
      const label = `${channel} ${JSON.stringify(args, (_k, v: unknown) => (v instanceof Uint8Array ? `Uint8Array(${v.byteLength})` : v))?.slice(0, 60)}`
      await expect(Promise.resolve().then(() => handlers.get(channel)!({} as never, ...args)), label).rejects.toThrow(`Refused a malformed ${channel} request`)
    }
    expect(reached, `services reached: ${reached.join(', ')}`).toEqual([])
  })

  it('still passes a well-formed request through to the service', async () => {
    const { handlers, reached } = allHandlers()
    handlers.get(CH.docsAppend)!({} as never, docId, new Uint8Array([1, 2, 3]))
    handlers.get(CH.docsList)!({} as never, 'notebook:')
    handlers.get(CH.auditList)!({} as never, undefined)
    handlers.get(CH.syncConflicts)!({} as never, docId)
    handlers.get(CH.syncResolve)!({} as never, uuid, 'mine')
    handlers.get(CH.onenoteStart)!({} as never, [uuid])
    await handlers.get(CH.themesRename)!({} as never, `user:${uuid}`, 'Midnight')
    expect(reached).toEqual(['store.append(2)', 'onAppend', 'store.list(1)', 'store.listAudit(1)', 'sync.conflicts(1)', 'sync.resolve(2)', 'importer.start(1)', 'themes.rename(2)'])
  })

})

describe('the backup\u2019s file paths never come from the renderer (C2)', () => {
  const backupDir = mkdtempSync(join(tmpdir(), 'slate-pick-'))

  /** The dialog answers with `backupDir` (the e2e hook), so no window opens in a unit test. */
  function withDialog() {
    vi.stubEnv('SLATE_E2E', '1')
    vi.stubEnv('SLATE_E2E_BACKUP_PATH', backupDir)
  }

  afterEach(() => vi.unstubAllEnvs())

  it('hands the renderer an id, not the paths', async () => {
    withDialog()
    const { handlers } = allHandlers()
    const pick = (await handlers.get(CH.onenotePickBackup)!({} as never)) as BackupPick
    expect(Object.keys(pick).sort()).toEqual(['pickId', 'sections'])
    expect(JSON.stringify(pick)).not.toContain(backupDir)
  })

  it('resolves that id to the paths the dialog chose', async () => {
    withDialog()
    const { handlers, reached } = allHandlers()
    const pick = (await handlers.get(CH.onenotePickBackup)!({} as never)) as BackupPick
    const paths = await handlers.get(CH.onenoteStartBackup)!({} as never, pick.pickId, [])
    expect(reached).toEqual(['importer.startBackup(2)'])
    expect(paths).toBeUndefined()
  })

  it('refuses an id main never handed out, and one from a pick the lock cleared', async () => {
    withDialog()
    const { handlers, reached } = allHandlers()
    await expect(Promise.resolve().then(() => handlers.get(CH.onenoteStartBackup)!({} as never, uuid, []))).rejects.toThrow(
      `Refused a malformed ${CH.onenoteStartBackup} request`,
    )
    const pick = (await handlers.get(CH.onenotePickBackup)!({} as never)) as BackupPick
    clearBackupPick()
    await expect(Promise.resolve().then(() => handlers.get(CH.onenoteStartBackup)!({} as never, pick.pickId, []))).rejects.toThrow(
      `Refused a malformed ${CH.onenoteStartBackup} request`,
    )
    expect(reached).toEqual([])
  })

  it('keeps only the newest pick, so an earlier id names no files', async () => {
    withDialog()
    const { handlers, reached } = allHandlers()
    const first = (await handlers.get(CH.onenotePickBackup)!({} as never)) as BackupPick
    const second = (await handlers.get(CH.onenotePickBackup)!({} as never)) as BackupPick
    expect(second.pickId).not.toBe(first.pickId)
    await expect(Promise.resolve().then(() => handlers.get(CH.onenoteStartBackup)!({} as never, first.pickId, []))).rejects.toThrow('Refused a malformed')
    expect(reached).toEqual([])
  })
})

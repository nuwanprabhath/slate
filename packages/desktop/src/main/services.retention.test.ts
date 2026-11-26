// GDPR-07, GDPR-15 (workstream D): opening the notes applies the age limits the settings choose.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthService } from './onenote/auth'
import { closeServices, openServices, type ServiceContext } from './services'
import { writeSettings } from './settings'
import { DocStore } from './store'

const DAY = 24 * 60 * 60 * 1000
const auth: AuthService = { status: async () => ({ configured: false, signedIn: false }), signIn: async () => {}, signOut: async () => {}, token: async () => '' }
const dirs: string[] = []
afterEach(() => {
  closeServices()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function context(dataDir: string): ServiceContext {
  return {
    dataDir,
    emit: () => {},
    sync: { auth, graphUrl: 'http://127.0.0.1:9', gitDir: join(dataDir, 'git-sync'), secrets: { available: async () => false, seal: async () => Buffer.alloc(0), open: async () => ({ plain: '', rewrite: false }) }, intervalMs: 0 },
    importer: { auth, graphUrl: 'http://127.0.0.1:9' },
  }
}

function seeded(strict: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-svc-retention-'))
  dirs.push(dir)
  const store = new DocStore(join(dir, 'slate.db'))
  writeSettings(store, { gdprStrictMode: strict })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - 45 * DAY)
  store.appendAudit({ tool: 'read_page', target: 'old', outcome: 'ok' })
  vi.useRealTimers()
  store.addConflict({ id: 'c', pageId: 'p', boxId: 'b', device: 'Device 1', mine: 'a', theirs: 'b', merged: 'ab', at: Date.now() - 100 * DAY })
  store.close()
  return dir
}

describe('services apply the retention the settings choose', () => {
  it('strict mode: audit rows over 30 days and conflicts over 90 go when the notes open', () => {
    const dir = seeded(true)
    const svc = openServices(null, join(dir, 'slate.db'), context(dir))
    expect(svc.store.listAudit()).toEqual([])
    expect(svc.store.listConflicts()).toEqual([])
  })

  it('strict mode off: 90 days of audit rows, and conflicts until resolved', () => {
    const dir = seeded(false)
    const svc = openServices(null, join(dir, 'slate.db'), context(dir))
    expect(svc.store.listAudit().map((r) => r.target)).toEqual(['old'])
    expect(svc.store.listConflicts().map((c) => c.id)).toEqual(['c'])
  })
})

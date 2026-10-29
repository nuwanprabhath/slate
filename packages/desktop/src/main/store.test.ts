import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { DocStore } from './store'
import { openDatabase } from './db/openDatabase'
import { testKey } from './db/testModule'
import type { TransportObservation } from '../shared/api'

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-store-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function edits(n: number): { doc: LoroDoc; updates: Uint8Array[] } {
  const doc = new LoroDoc()
  const updates: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const from = doc.oplogVersion()
    doc.getMap('m').set(`k${i}`, i)
    doc.commit()
    updates.push(doc.export({ mode: 'update', from }))
  }
  return { doc, updates }
}

describe('DocStore', () => {
  it('appends and loads updates in order', () => {
    const store = new DocStore(tempDb())
    store.append('page:1', new Uint8Array([1, 2]))
    store.append('page:1', new Uint8Array([3]))
    expect(store.load('page:1').map((u) => Array.from(u))).toEqual([[1, 2], [3]])
    expect(store.load('page:missing')).toEqual([])
    store.close()
  })

  it('lists doc ids by literal prefix', () => {
    const store = new DocStore(tempDb())
    store.append('notebook:a', new Uint8Array([1]))
    store.append('page:b', new Uint8Array([1]))
    store.append('notebook_x', new Uint8Array([1]))
    expect(store.list('notebook:')).toEqual(['notebook:a'])
    store.close()
  })

  it('compacts automatically and preserves document state', () => {
    const store = new DocStore(tempDb())
    const { doc, updates } = edits(520)
    for (const u of updates) store.append('page:c', u)
    const parts = store.load('page:c')
    expect(parts.length).toBeLessThan(30)
    const restored = new LoroDoc()
    restored.importBatch(parts)
    expect(restored.toJSON()).toEqual(doc.toJSON())
    store.close()
  })

  it('persists across reopen and removes docs', () => {
    const file = tempDb()
    const first = new DocStore(file)
    first.append('page:p', new Uint8Array([9]))
    first.close()
    const second = new DocStore(file)
    expect(second.load('page:p')).toHaveLength(1)
    second.remove('page:p')
    expect(second.load('page:p')).toEqual([])
    expect(second.list('page:')).toEqual([])
    second.close()
  })

  it('stores settings as JSON', () => {
    const store = new DocStore(tempDb())
    expect(store.getSetting('settings')).toBeUndefined()
    store.setSetting('settings', { markdownShortcuts: true })
    expect(store.getSetting('settings')).toEqual({ markdownShortcuts: true })
    store.close()
  })

  it('records and lists audit rows newest first', () => {
    const store = new DocStore(tempDb())
    store.appendAudit({ tool: 'read_page', target: 'p1', outcome: 'ok' })
    store.appendAudit({ tool: 'search', target: 'q', outcome: 'denied' })
    const rows = store.listAudit()
    expect(rows.map((r) => r.tool)).toEqual(['search', 'read_page'])
    expect(rows[0]!.ts).toBeGreaterThan(0)
    store.close()
  })

  it('sees updates written by another connection to the same file', () => {
    const file = tempDb()
    const app = new DocStore(file)
    const cli = new DocStore(file, { compact: false })
    const since = app.maxUpdateId()
    const before = app.dataVersion()
    cli.append('page:x', new Uint8Array([7]))
    expect(app.dataVersion()).not.toBe(before)
    expect(app.updatesSince(since).map((u) => [u.docId, Array.from(u.data)])).toEqual([['page:x', [7]]])
    app.close()
    cli.close()
  })

  it('never compacts when compact is false', () => {
    const store = new DocStore(tempDb(), { compact: false })
    for (let i = 0; i < 520; i++) store.append('page:n', new Uint8Array([i % 256]))
    expect(store.load('page:n')).toHaveLength(520)
    store.close()
  })
})

describe('DocStore import tables', () => {
  it('round-trips import items and OneNote id mappings', () => {
    const file = tempDb()
    const store = new DocStore(file)
    expect(store.getImportItem('p1')).toBeUndefined()
    store.setImportItem('p1', { lastModified: '2026-01-01T00:00:00Z', status: 'failed', error: 'Graph 503' })
    store.setImportItem('p2', { lastModified: '2026-01-02T00:00:00Z', status: 'done' })
    store.setImportItem('p1', { lastModified: '2026-01-03T00:00:00Z', status: 'done' })
    expect(store.getMapping('nb1')).toBeUndefined()
    store.setMapping('nb1', 'slate-nb')
    store.close()
    const again = new DocStore(file)
    expect(again.getImportItem('p1')).toEqual({ lastModified: '2026-01-03T00:00:00Z', status: 'done' })
    expect(again.getImportItem('p2')).toEqual({ lastModified: '2026-01-02T00:00:00Z', status: 'done' })
    expect(again.getMapping('nb1')).toBe('slate-nb')
    again.close()
  })
})

describe('transport observations (PQ-B5)', () => {
  const obs = (over: Partial<TransportObservation> = {}): TransportObservation => ({
    remote: 'git-ssh:github.com',
    transport: 'ssh',
    kex: 'mlkem768x25519-sha256',
    pq: 'hybrid',
    source: 'probe',
    at: 1000,
    ...over
  })

  function legacyRows(file: string, key: ReturnType<typeof testKey> | null): void {
    // A 0.3.0 database: today's tables without transport_observations, holding rows.
    const first = new DocStore(openDatabase(file, key))
    first.append('page:1', new Uint8Array([1]))
    first.setSetting('k', 'v')
    first.addNotice('hello')
    first.close()
    const db = openDatabase(file, key)
    db.exec('DROP TABLE transport_observations')
    db.close()
  }

  it.each([
    ['plaintext', null],
    ['encrypted', testKey()]
  ])('T-PQ-B5-01: opening a 0.3.0 %s database creates the table and changes no row', (_name, key) => {
    const file = tempDb()
    legacyRows(file, key)
    const before = openDatabase(file, key)
    before.exec('DROP TABLE IF EXISTS transport_observations')
    const count = (db: ReturnType<typeof openDatabase>): unknown[] =>
      ['snapshots', 'updates', 'settings', 'notices'].map((t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)
    const counts = count(before)
    before.close()
    const store = new DocStore(file, { key })
    expect(store.transportObservations()).toEqual([])
    store.close()
    const after = openDatabase(file, key)
    expect(count(after)).toEqual(counts)
    expect(after.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'transport_observations'").get()).toBeDefined()
    after.close()
  })

  it('T-PQ-B5-02: an observation round-trips and a second one for the same remote replaces it', () => {
    const store = new DocStore(tempDb())
    store.recordTransport(obs())
    store.recordTransport(obs({ remote: 'git-https:github.com', transport: 'tls', kex: null, pq: 'unknown', source: 'test-connection', at: 5 }))
    expect(store.transportObservations()).toEqual(
      expect.arrayContaining([obs(), obs({ remote: 'git-https:github.com', transport: 'tls', kex: null, pq: 'unknown', source: 'test-connection', at: 5 })])
    )
    store.recordTransport(obs({ kex: 'secp384r1', pq: 'classical', at: 2000 }))
    const rows = store.transportObservations().filter((r) => r.remote === 'git-ssh:github.com')
    expect(rows).toEqual([obs({ kex: 'secp384r1', pq: 'classical', at: 2000 })])
    expect(store.transportObservations()).toHaveLength(2)
    store.close()
  })

  it.each([
    'git-https:user@github.com',
    'git-https:user:token@github.com',
    'git-https:github.com/owner/repo',
    'git-https:https://github.com/owner/repo',
    'git-https:github.com?token=abc',
    'git-ssh:git@github.com',
    'github.com',
    'git-ssh:',
    'onedrive:graph.microsoft.com#frag',
    'git-ssh:github.com:22/x'
  ])('T-PQ-B5-03: refuses remote %s so no credential is stored', (remote) => {
    const store = new DocStore(tempDb())
    expect(() => store.recordTransport(obs({ remote }))).toThrow(Error)
    expect(store.transportObservations()).toEqual([])
    store.close()
  })

  it('T-PQ-B5-03: accepts host-level remotes with a port', () => {
    const store = new DocStore(tempDb())
    store.recordTransport(obs({ remote: 'git-https:git.example.com:8443' }))
    expect(store.transportObservations()).toHaveLength(1)
    store.close()
  })
})

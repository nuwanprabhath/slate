// A remote the attacker controls completely: `delta` lists generated items (hostile paths, false sizes, repeated ids
// and eTags, this device's own id, deletions) and `download` serves valid updates, mutated ones, arbitrary bytes,
// errors, or never answers. Whatever it does, a sync settles, refuses oversized files unfetched, and leaves local
// documents alone when nothing it served is a Loro update.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { PageDoc } from '@slate/core'
import { SyncAborted, SyncEngine, unverifiedMessage } from '../src/engine'
import { docKey, parseRemotePath } from '../src/paths'
import { OfflineError, UnverifiableFileError, type RemoteDrive, type RemoteItem, type SyncReport } from '../src/types'
import { Rng, fcRuns, fuzzTimeout } from '../../desktop/test/fuzz'
import { mutateBytes } from '../../desktop/test/fuzzBytes'
import { DEADLINE_MS } from './faultScenario'
import { addTextBox, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'
import { PAGE } from './simulation'

const ME = 'me'
const MAX_FILE_BYTES = 64 * 1024 * 1024
// The document-id grammar, written out here so the test does not share the code it checks.
const DOC_ID = /^(page|notebook):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OTHER_PAGE = 'page:44444444-4444-4444-8444-444444444444'

/** Real updates another device could have written: one to the page this device holds, one to a page it does not. */
const VALID: Uint8Array[] = [PAGE, OTHER_PAGE].map((_, i) => {
  const doc = new LoroDoc()
  doc.setPeerId(BigInt(500 + i))
  addTextBox(new PageDoc(doc), `remote ${i}`)
  return doc.export({ mode: 'update' })
})

type Serve =
  | { kind: 'valid'; pick: number }
  | { kind: 'mutated'; pick: number; salt: number }
  | { kind: 'garbage'; bytes: Uint8Array }
  | { kind: 'missing' | 'unverifiable' | 'offline' | 'boom' | 'hang' }

// Never starts with Loro's magic `loro`, so it is not an update by construction.
const garbage = fc.uint8Array({ maxLength: 64 }).map((b) => Uint8Array.from([0x00, ...b]))
const serve: fc.Arbitrary<Serve> = fc.oneof(
  fc.nat(VALID.length - 1).map<Serve>((pick) => ({ kind: 'valid', pick })),
  fc.record({ pick: fc.nat(VALID.length - 1), salt: fc.nat() }).map<Serve>((r) => ({ kind: 'mutated', ...r })),
  garbage.map<Serve>((bytes) => ({ kind: 'garbage', bytes })),
  fc.constantFrom<Serve>({ kind: 'missing' }, { kind: 'unverifiable' }, { kind: 'offline' }, { kind: 'boom' }, { kind: 'hang' })
)

const docKeyArb = fc.oneof(
  fc.constantFrom(PAGE, OTHER_PAGE).map(docKey),
  fc.uuid().map((u) => docKey(`page:${u}`)),
  fc.constantFrom('..', '.', '', 'evil', 'page_', 'page_x_y', 'page_../..', 'meta_cursor', '%2e%2e', 'notebook_', 'blob_x'),
  fc.string({ maxLength: 12 }).filter((s) => !s.includes('/'))
)
const deviceArb = fc.oneof(fc.constantFrom(ME, 'd2', 'd3', ''), fc.string({ maxLength: 8 }).filter((s) => !s.includes('/')))
const fileArb = fc.oneof(
  fc.nat(99).map((n) => `${String(n).padStart(8, '0')}.chunk`),
  fc.nat(99).map((n) => `snapshot-${String(n).padStart(8, '0')}.bin`),
  fc.constantFrom('1.chunk', '.chunk', 'snapshot-.bin', '00000001.chunk.tmp')
)
const pathArb = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(docKeyArb, deviceArb, fileArb).map(([k, d, f]) => `docs/${k}/${d}/${f}`) },
  { weight: 1, arbitrary: fc.constantFrom('blobs/x.png', 'devices/d2.json', 'docs/a/b', '', '/', 'docs//x/1.chunk') },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) }
)
const sizeArb = fc.option(fc.oneof(fc.nat(4096), fc.constantFrom(MAX_FILE_BYTES, MAX_FILE_BYTES + 1, 2 ** 40, Number.MAX_SAFE_INTEGER)), { nil: undefined })
const itemArb: fc.Arbitrary<RemoteItem> = fc.record(
  {
    id: fc.oneof(fc.constantFrom('i0', 'i1', 'i2'), fc.uuid()),
    path: pathArb,
    eTag: fc.constantFrom('e0', 'e1', 'e2'),
    deleted: fc.oneof({ weight: 1, arbitrary: fc.constant(true) }, { weight: 5, arbitrary: fc.constant(false) }),
    isFile: fc.oneof({ weight: 6, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
    size: sizeArb
  },
  { requiredKeys: ['id', 'path', 'eTag', 'deleted', 'isFile'] }
)

interface Hostile {
  items: RemoteItem[]
  serves: Serve[]
}
const hostile = (serves: fc.Arbitrary<Serve>): fc.Arbitrary<Hostile> =>
  fc.record({ items: fc.array(itemArb, { maxLength: 12 }), serves: fc.array(serves, { minLength: 1, maxLength: 8 }) })

type HostileDrive = RemoteDrive & { downloaded: string[]; onHang: () => void }

function hostileDrive(h: Hostile): HostileDrive {
  const files = new Map<string, Uint8Array>()
  let calls = 0
  const drive: HostileDrive = {
    downloaded: [],
    onHang: () => undefined,
    async upload(path, bytes) {
      files.set(path, bytes.slice())
    },
    async remove(path) {
      files.delete(path)
    },
    async delta() {
      return { items: h.items.map((i) => ({ ...i })), cursor: 'hostile' }
    },
    download(path) {
      drive.downloaded.push(path)
      const s = h.serves[calls++ % h.serves.length]!
      switch (s.kind) {
        case 'valid':
          return Promise.resolve(VALID[s.pick]!.slice())
        case 'mutated':
          return Promise.resolve(mutateBytes(new Rng(s.salt), VALID[s.pick]!))
        case 'garbage':
          return Promise.resolve(s.bytes.slice())
        case 'missing':
          return Promise.reject(Object.assign(new Error('not found'), { status: 404 }))
        case 'unverifiable':
          return Promise.reject(new UnverifiableFileError())
        case 'offline':
          return Promise.reject(new OfflineError())
        case 'boom':
          return Promise.reject(new Error('the drive broke'))
        case 'hang':
          drive.onHang()
          return new Promise<Uint8Array>(() => undefined)
      }
    }
  }
  return drive
}

function device(): { local: MemoryLocal; appended: string[] } {
  const local = memoryLocal()
  editPage(local, PAGE, (p) => addTextBox(p, 'mine'), 1n)
  const appended: string[] = []
  const appendRemote = local.appendRemote.bind(local)
  local.appendRemote = async (docId, update) => {
    appended.push(docId)
    await appendRemote(docId, update)
  }
  return { local, appended }
}

/** One sync as the app runs it: with a signal the deadline aborts. A hung download is aborted by advancing the fake clock. */
async function syncWithDeadline(engine: SyncEngine, drive: HostileDrive): Promise<SyncReport | SyncAborted> {
  const abort = new AbortController()
  const hung = new Promise<'hang'>((resolve) => (drive.onHang = () => resolve('hang')))
  const run = engine.syncOnce({ signal: abort.signal }).then(
    (report) => ({ report }),
    (error: unknown) => ({ error })
  )
  const deadline = setTimeout(() => abort.abort(), DEADLINE_MS)
  let settled = await Promise.race([run, hung])
  if (settled === 'hang') {
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    await new Promise((resolve) => setImmediate(resolve))
    const after = await Promise.race([run, Promise.resolve('pending' as const)])
    if (after === 'pending') throw new Error('a hung sync did not stop when its deadline aborted it')
    settled = after
  }
  clearTimeout(deadline)
  if ('report' in settled) return settled.report
  if (settled.error instanceof SyncAborted) return settled.error
  throw new Error(`syncOnce rejected with something other than SyncAborted: ${String(settled.error)}`)
}

/** What the engine must count as unverified when nothing served is a Loro update: each first sighting of a file it would pull. */
function pullable(items: RemoteItem[]): number {
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.isFile || item.deleted) continue
    const parsed = parseRemotePath(item.path)
    if ((parsed.kind !== 'chunk' && parsed.kind !== 'snapshot') || parsed.deviceId === ME) continue
    seen.add(`${item.id}\n${item.eTag}`)
  }
  return seen.size
}

const snapshotDocs = (local: MemoryLocal) => new Map([...local.docs].map(([id, updates]) => [id, updates.map((u) => Array.from(u).join(','))]))

describe('a hostile remote', () => {
  beforeAll(() => {
    // Only timeouts: the engine's setImmediate yields and the microtask queue stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('T-F2C-05: a sync settles with a report or SyncAborted, and never fetches a file over 64 MiB', { timeout: fuzzTimeout(20_000) }, async () => {
    const seen = { aborted: 0, oversized: 0, statuses: new Set<string>() }
    await fc.assert(
      fc.asyncProperty(hostile(serve), async (h) => {
        const { local } = device()
        const drive = hostileDrive(h)
        const engine = new SyncEngine({ local, remote: drive, deviceId: ME, deviceName: ME, compactAfter: 2 })
        const result = await syncWithDeadline(engine, drive)
        if (result instanceof SyncAborted) seen.aborted++
        else {
          expect(['idle-synced', 'offline', 'error']).toContain(result.status)
          seen.statuses.add(result.status)
        }
        const fetchable = new Set(h.items.filter((i) => i.size === undefined || i.size <= MAX_FILE_BYTES).map((i) => i.path))
        if (h.items.some((i) => i.size !== undefined && i.size > MAX_FILE_BYTES)) seen.oversized++
        for (const path of drive.downloaded) expect(fetchable.has(path), `downloaded ${path}, listed only as over 64 MiB`).toBe(true)
      }),
      fcRuns(4)
    )
    expect(seen.aborted, 'hung syncs aborted').toBeGreaterThan(0)
    expect(seen.oversized, 'runs listing an oversized file').toBeGreaterThan(0)
    expect([...seen.statuses].sort()).toEqual(['error', 'idle-synced', 'offline'])
  })

  it('T-F2C-07: appendRemote is reached only for `page:<uuid>`/`notebook:<uuid>` ids', { timeout: fuzzTimeout(20_000) }, async () => {
    let refused = 0
    await fc.assert(
      fc.asyncProperty(hostile(fc.nat(VALID.length - 1).map<Serve>((pick) => ({ kind: 'valid', pick }))), async (h) => {
        const { local, appended } = device()
        const drive = hostileDrive(h)
        const engine = new SyncEngine({ local, remote: drive, deviceId: ME, deviceName: ME, compactAfter: 2 })
        await syncWithDeadline(engine, drive)
        for (const id of appended) expect(id, `appendRemote(${JSON.stringify(id)})`).toMatch(DOC_ID)
        for (const id of local.docs.keys()) expect(id).toMatch(DOC_ID)
        const ungrammatical = h.items.some((i) => {
          const m = /^docs\/([^/]*)\/([^/]*)\/(\d+\.chunk|snapshot-\d+\.bin)$/.exec(i.path)
          return i.isFile && !i.deleted && m !== null && m[2] !== ME && !DOC_ID.test(m[1]!.replace('_', ':'))
        })
        if (ungrammatical) refused++
      }),
      fcRuns(4)
    )
    expect(refused, 'runs listing an ungrammatical doc id').toBeGreaterThan(0)
  })

  it('T-F2C-07b: a refused doc id leaves the rest of the listing synced', async () => {
    const { local, appended } = device()
    const item = (id: string, path: string): RemoteItem => ({ id, path, eTag: 'e', deleted: false, isFile: true })
    const good = `docs/${docKey(OTHER_PAGE)}/d2/00000001.chunk`
    const h: Hostile = {
      items: [item('bad1', 'docs/w/d2/00000001.chunk'), item('bad2', 'docs//d2/00000001.chunk'), item('good', good)],
      serves: [{ kind: 'valid', pick: 1 }]
    }
    const drive = hostileDrive(h)
    const engine = new SyncEngine({ local, remote: drive, deviceId: ME, deviceName: ME, compactAfter: 2 })
    const report = await syncWithDeadline(engine, drive)
    expect(report instanceof SyncAborted ? 'aborted' : report.status).toBe('idle-synced')
    expect(appended).toEqual([OTHER_PAGE])
    expect(drive.downloaded).toEqual([good])
  })

  it('T-F2C-06: when nothing served is a Loro update, local documents are unchanged and the notice counts every file', { timeout: fuzzTimeout(20_000) }, async () => {
    let counted = 0
    await fc.assert(
      fc.asyncProperty(hostile(garbage.map<Serve>((bytes) => ({ kind: 'garbage', bytes }))), async (h) => {
        const { local, appended } = device()
        const before = snapshotDocs(local)
        const drive = hostileDrive(h)
        const engine = new SyncEngine({ local, remote: drive, deviceId: ME, deviceName: ME, compactAfter: 2 })
        const report = await syncWithDeadline(engine, drive)
        expect(report instanceof SyncAborted ? 'aborted' : report.status).toBe('idle-synced')
        expect(appended).toEqual([])
        expect(snapshotDocs(local)).toEqual(before)
        const expected = pullable(h.items)
        expect(local.notes).toEqual(expected > 0 ? [unverifiedMessage(expected)] : [])
        if (expected > 0) counted++
      }),
      fcRuns(4)
    )
    expect(counted, 'runs with refused files').toBeGreaterThan(0)
  })
})

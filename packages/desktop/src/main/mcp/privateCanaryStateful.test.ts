import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSlateMcpServer } from '@slate/mcp'
import { NotebookDoc, PageDoc, contentToJSON, writeContent, type Access, type PMJSON } from '@slate/core'
import { DocStore } from '../store'
import { storeDocSource } from './docSource'
import * as loro from 'loro-crdt'
import { fcRuns, fuzzTimeout } from '../../../test/fuzz'

/**
 * The private-box canary of `packages/mcp/test/privateCanary.test.ts`, made stateful and run on the
 * path the app runs: `storeDocSource` over a real `DocStore`, whose decoded docs and redacted
 * projections outlive a call. The person's edits (a box made private, access revoked, a page deleted,
 * a compaction, a remote append) interleave with agent calls to every listed tool; after each call no
 * canary of a box that is private now, or on a page the agent cannot read now, may be in the response
 * or the audit, a refusal must look like a missing id, private boxes are unchanged, and every write
 * landed where `readwrite` was granted at the time.
 */

const PLACES = ['TEXT', 'LINK', 'ALT', 'TODO'] as const
type Place = (typeof PLACES)[number]
const ACCESS: Array<Access | null> = [null, 'read', 'readwrite']

function boxContent(places: readonly Place[], token: (p: Place) => string): PMJSON[] {
  const text = (s: string): PMJSON => ({ type: 'text', text: s })
  const blocks: PMJSON[] = [{ type: 'paragraph', content: [text('box')] }]
  for (const place of places) {
    const t = token(place)
    if (place === 'TEXT') blocks.push({ type: 'paragraph', content: [text(`note ${t} end`)] })
    if (place === 'LINK') blocks.push({ type: 'paragraph', content: [{ type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: `https://example.com/${t}` } }] }] })
    if (place === 'ALT') blocks.push({ type: 'image', attrs: { src: 'https://example.com/i.png', alt: t } })
    if (place === 'TODO') blocks.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [text(t)] }] }] })
  }
  return blocks
}

type Origin = 'local' | 'remote'
type Person =
  | { k: 'addBox'; page: number; private: boolean; places: Place[]; origin: Origin }
  | { k: 'editBox'; page: number; box: number; places: Place[]; origin: Origin }
  | { k: 'setPrivate'; page: number; box: number; private: boolean; origin: Origin }
  | { k: 'access'; target: number; access: number }
  | { k: 'deletePage'; page: number }
  | { k: 'compact'; page: number }
type Template = { k: 'pick'; n: number } | { k: 'lit'; v: unknown } | { k: 'obj'; props: Record<string, Template> }
/** `reread` is the agent reading the page the person last changed: the call a stale cached projection answers wrongly. */
type Cmd = Person | { k: 'agent'; tool: number; args: Template } | { k: 'reread' }

interface Schema {
  type?: string
  enum?: unknown[]
  minLength?: number
  properties?: Record<string, Schema>
  required?: string[]
}

function templateFor(tool: string, schema: Schema): fc.Arbitrary<Template> {
  if (schema.enum) return fc.constantFrom(...schema.enum).map((v): Template => ({ k: 'lit', v }))
  switch (schema.type) {
    case 'string':
      return fc.oneof(
        { arbitrary: fc.nat().map((n): Template => ({ k: 'pick', n })), weight: 6 },
        { arbitrary: fc.string({ minLength: schema.minLength ?? 0, maxLength: 12 }).map((v): Template => ({ k: 'lit', v })), weight: 1 },
      )
    case 'object': {
      const keys = Object.keys(schema.properties ?? {})
      const required = new Set(schema.required ?? [])
      return fc
        .tuple(...keys.map((key) => fc.option(templateFor(tool, schema.properties![key]!), { nil: undefined, freq: required.has(key) ? Number.MAX_SAFE_INTEGER : 2 })))
        .map((values): Template => ({ k: 'obj', props: Object.fromEntries(keys.flatMap((key, i) => (values[i] === undefined ? [] : [[key, values[i]]]))) }))
    }
    default:
      throw new Error(`privateCanaryStateful: cannot generate arguments for tool "${tool}" (schema ${JSON.stringify(schema)}); teach templateFor this shape`)
  }
}

function resolve(t: Template, pool: string[]): unknown {
  // Half the picks land on the first few entries (the ids), or ids are drowned by the fragments.
  if (t.k === 'pick') return t.n % 2 === 0 ? pool[(t.n >> 1) % Math.min(pool.length, ID_PICKS)] : pool[(t.n >> 1) % pool.length]
  if (t.k === 'lit') return t.v
  return Object.fromEntries(Object.entries(t.props).map(([k, v]) => [k, resolve(v, pool)]))
}

const placesArb = fc.subarray([...PLACES], { minLength: 1 })
const originArb = fc.constantFrom<Origin>('local', 'local', 'remote')
const personArb: fc.Arbitrary<Person> = fc.oneof(
  fc.record({ k: fc.constant('addBox' as const), page: fc.nat(), private: fc.boolean(), places: placesArb, origin: originArb }),
  fc.record({ k: fc.constant('editBox' as const), page: fc.nat(), box: fc.nat(), places: placesArb, origin: originArb }),
  { arbitrary: fc.record({ k: fc.constant('setPrivate' as const), page: fc.nat(), box: fc.nat(), private: fc.boolean(), origin: originArb }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant('access' as const), target: fc.nat(), access: fc.nat({ max: 2 }) }), weight: 2 },
  fc.record({ k: fc.constant('deletePage' as const), page: fc.nat() }),
  fc.record({ k: fc.constant('compact' as const), page: fc.nat() }),
)

interface BoxRecord {
  pageId: string
  boxId: string
  tokens: string[]
}

const NOTEBOOK = 'notebook:nb0'
const NOT_THERE = 'no-such-id-0000'
/** The three page ids, the two section ids and the notebook id lead the pool. */
const ID_PICKS = 6

/** One run's world: the store, the agent's client, and what the person knows about every box. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'slate-canary-'))
  const store = new DocStore(join(dir, 'slate.db'), { compact: false })
  const saved: string[] = []
  const source = storeDocSource(() => store, (docId) => saved.push(docId))
  const server = createSlateMcpServer(source)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'canary', version: '0.0.0' })
  await client.connect(clientSide)

  // Every Loro document this run decodes, freed by close() even when the case fails: Loro's WebAssembly heap
  // outlives the JavaScript objects, and thousands of runs' worth of it exhausted the heap (FX-30).
  const built: Array<{ doc: { free(): void } }> = []
  const own = <T extends { doc: { free(): void } }>(d: T): T => (built.push(d), d)
  const nb = own(NotebookDoc.create('Notebook'))
  const sections = [nb.addSection('Open'), nb.addSection('Closed')]
  nb.setAccess(sections[0]!, 'readwrite')
  const pages = [nb.addPage(sections[0]!, 'Page A'), nb.addPage(sections[0]!, 'Page B'), nb.addPage(sections[1]!, 'Page C')]
  nb.setAccess(pages[1]!.id, 'read')
  store.append(NOTEBOOK, nb.doc.export({ mode: 'snapshot' }))
  for (const p of pages) store.append(`page:${p.pageId}`, own(new PageDoc()).doc.export({ mode: 'snapshot' }))

  const boxes: BoxRecord[] = []
  const deleted = new Set<string>()
  let n = 0
  const notebook = () => own(NotebookDoc.fromUpdates(store.load(NOTEBOOK)))
  const pageDoc = (pageId: string) => own(PageDoc.fromUpdates(store.load(`page:${pageId}`)))
  const livePages = () => pages.filter((p) => !deleted.has(p.pageId))
  /** The person's write to a page: their own copy, the delta appended as the app (or sync) would. */
  let touched: string | undefined
  const edit = (pageId: string, origin: Origin, fn: (doc: PageDoc) => void) => {
    touched = pageId
    const doc = pageDoc(pageId)
    const from = doc.doc.oplogVersion()
    fn(doc)
    doc.doc.commit()
    store.append(`page:${pageId}`, doc.doc.export({ mode: 'update', from }), origin)
  }
  const tokens = (places: readonly Place[]) => {
    const k = n++
    return places.map((p) => `CNRY_${k}_${p}`)
  }

  function person(c: Person): boolean {
    const live = livePages()
    const pick = <T,>(xs: T[], i: number): T | undefined => (xs.length ? xs[i % xs.length] : undefined)
    switch (c.k) {
      case 'addBox': {
        const page = pick(live, c.page)
        if (!page) return false
        const ts = tokens(c.places)
        edit(page.pageId, c.origin, (doc) => {
          const boxId = doc.addBox({ x: 0, y: 40 * n, width: 300, content: boxContent(c.places, (p) => ts[c.places.indexOf(p)]!) })
          if (c.private) doc.updateBox(boxId, { private: true })
          boxes.push({ pageId: page.pageId, boxId, tokens: ts })
        })
        return true
      }
      case 'editBox':
      case 'setPrivate': {
        const box = pick(boxes.filter((b) => !deleted.has(b.pageId)), c.box)
        if (!box) return false
        edit(box.pageId, c.origin, (doc) => {
          if (c.k === 'setPrivate') return doc.updateBox(box.boxId, { private: c.private })
          box.tokens = tokens(c.places)
          writeContent(doc.contentMap(box.boxId)!, boxContent(c.places, (p) => box.tokens[c.places.indexOf(p)]!))
        })
        return true
      }
      case 'access': {
        const targets = [...sections, ...live.map((p) => p.id)]
        const target = pick(targets, c.target)!
        const doc = notebook()
        const from = doc.doc.oplogVersion()
        doc.setAccess(target, ACCESS[c.access]!)
        doc.doc.commit()
        store.append(NOTEBOOK, doc.doc.export({ mode: 'update', from }))
        return true
      }
      case 'deletePage': {
        const page = pick(live, c.page)
        if (!page) return false
        const doc = notebook()
        const from = doc.doc.oplogVersion()
        doc.delete(page.id)
        doc.doc.commit()
        store.append(NOTEBOOK, doc.doc.export({ mode: 'update', from }))
        store.remove(`page:${page.pageId}`)
        deleted.add(page.pageId)
        return true
      }
      case 'compact': {
        const page = pick(live, c.page)
        if (!page) return false
        store.compact(`page:${page.pageId}`)
        store.compact(NOTEBOOK)
        return true
      }
    }
  }

  /** What the agent may see now: per page, its access (null once deleted). */
  const accessNow = (): Map<string, Access | null> => {
    const doc = notebook()
    return new Map(doc.allPageIds().map((pageId) => [pageId, deleted.has(pageId) ? null : doc.effectiveAccess(doc.findPage(pageId)!.id)]))
  }
  /** Tokens the agent must not see now: every private box, and every box on a page it cannot read. */
  const forbidden = (): string[] => {
    const access = accessNow()
    const docs = new Map<string, PageDoc>()
    return boxes.flatMap((b) => {
      if (!access.get(b.pageId)) return b.tokens
      const doc = docs.get(b.pageId) ?? pageDoc(b.pageId)
      docs.set(b.pageId, doc)
      return doc.getBox(b.boxId)?.private ? b.tokens : []
    })
  }
  const privateState = (): Map<string, unknown> => {
    const out = new Map<string, unknown>()
    for (const b of boxes) {
      if (deleted.has(b.pageId)) continue
      const doc = pageDoc(b.pageId)
      const box = doc.getBox(b.boxId)
      if (box?.private) out.set(b.boxId, { box, content: contentToJSON(doc.contentMap(b.boxId)!) })
    }
    return out
  }
  const pool = (): string[] => {
    const all = boxes.flatMap((b) => b.tokens)
    const fragments = all.flatMap((t) => [t.slice(0, -1), t.slice(1), 'CNRY'])
    return [...pages.map((p) => p.pageId), ...sections.map(String), 'nb0', 'Page A', 'box', ...fragments, NOT_THERE]
  }
  const close = async () => {
    try {
      await client.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    } finally {
      // The source's cached docs end with the run, as the app's end with its MCP server (FX-32).
      source.close()
      for (const d of built.splice(0)) d.doc.free()
    }
  }
  return { store, client, saved, sections, pages, person, touched: () => touched, accessNow, forbidden, privateState, pool, notebook, close }
}

const leaks = (haystack: unknown, tokens: string[]): string[] => {
  const text = JSON.stringify(haystack).toLowerCase()
  return tokens.filter((t) => text.includes(t.toLowerCase()))
}
const textOf = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n')
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }).catch((e: unknown) => ({ protocolError: String(e) }))

async function listedTools(): Promise<Array<{ name: string; inputSchema: Schema }>> {
  const w = await world()
  const { tools } = await w.client.listTools()
  await w.close()
  return tools as Array<{ name: string; inputSchema: Schema }>
}

/** The size of Loro's WebAssembly heap. It never shrinks, so growth is memory no earlier run gave back for reuse. */
const loroHeapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

/** Counted across every run so the property cannot pass by never doing the thing it checks. */
const seen = { kinds: new Set<string>(), cleanReads: 0, refusals: 0, flipsThenReads: 0 }

/** Runs one command sequence, checking the four properties after every agent call. */
async function run(tools: Array<{ name: string }>, cmds: Cmd[]): Promise<void> {
  const w = await world()
  try {
    let flipped = false
    for (const cmd of cmds) {
      if (cmd.k !== 'agent' && cmd.k !== 'reread') {
        if (w.person(cmd)) {
          seen.kinds.add(cmd.k)
          if (cmd.k === 'setPrivate' && cmd.private) flipped = true
        }
        continue
      }
      const touched = w.touched()
      if (cmd.k === 'reread' && touched === undefined) continue
      const tool = cmd.k === 'reread' ? 'read_page' : tools[cmd.tool % tools.length]!.name
      const args = cmd.k === 'reread' ? { pageId: touched } : (resolve(cmd.args, w.pool()) as Record<string, unknown>)
      const access = w.accessNow()
      const nbNow = w.notebook()
      const sectionAccess = new Map(w.sections.map((s) => [String(s), nbNow.effectiveAccess(s)]))
      const before = w.privateState()
      w.saved.length = 0
      const result = await call(w.client, tool, args)
      const saves = [...w.saved]
      const forbidden = w.forbidden()
      // 1. Nothing private now, and nothing from a page the agent cannot read now.
      expect(leaks(result, forbidden), `${tool}(${JSON.stringify(args)}) leaked`).toEqual([])
      expect(leaks(w.store.listAudit(), forbidden), 'audit rows leaked').toEqual([])
      // 2. A page the agent may not use answers exactly as an id that does not exist.
      const pageId = typeof args.pageId === 'string' ? args.pageId : undefined
      const need = tool === 'append_to_page' ? 'readwrite' : 'read'
      if (pageId !== undefined && access.has(pageId) && (tool === 'read_page' || tool === 'append_to_page')) {
        const a = access.get(pageId)
        if (!a || (need === 'readwrite' && a !== 'readwrite')) {
          w.saved.length = 0
          expect(result, `${tool} on a refused page`).toEqual(await call(w.client, tool, { ...args, pageId: NOT_THERE }))
          expect(w.saved).toEqual([])
          seen.refusals++
        } else if (tool === 'read_page' && !(result as { isError?: boolean }).isError) {
          seen.cleanReads++
          if (flipped) seen.flipsThenReads++
        }
      }
      // 3. No private box changed.
      const after = w.privateState()
      for (const [boxId, state] of before) expect(after.get(boxId), `private box ${boxId} changed`).toEqual(state)
      // 4. Every write landed where readwrite was granted at the time of the call.
      for (const docId of saves) {
        if (docId === NOTEBOOK) {
          expect(tool).toBe('create_page')
          const section = w.sections.find((s) => String(s) === args.sectionId)
          expect(section, 'notebook written for a section that is not there').toBeDefined()
          continue
        }
        const id = docId.slice('page:'.length)
        if (access.has(id)) expect(access.get(id), `${tool} wrote ${id}`).toBe('readwrite')
        else expect(w.accessNow().get(id), `${tool} created ${id} outside readwrite`).toBe('readwrite')
      }
      if (saves.includes(NOTEBOOK)) expect(sectionAccess.get(String(args.sectionId)), `create_page in ${String(args.sectionId)}`).toBe('readwrite')
    }
  } finally {
    await w.close()
  }
}

/**
 * T-F4D-03's bound. A run of its twelve commands that gives nothing back grows Loro's heap by 3.6 MB (measured: 1.1 GB
 * after 300 runs). One that does leaves the heap at whatever is waiting for the next garbage collection: about 90 MB
 * once 300 runs have settled it, still creeping by 35 to 41 kB a run over the next 300. 512 KiB is seven times under
 * the first figure and twelve times over the second, and neither is a time, so machine load moves neither.
 */
const SETTLE_RUNS = 300
const MEASURED_RUNS = 300
const KEPT_BYTES_PER_RUN = 512 * 1024

describe('private boxes stay private while the person edits (F4d)', () => {
  it('T-F4D-01: across interleaved edits and agent calls, nothing private or unshared reaches the agent and no refused write lands', async () => {
    const tools = await listedTools()
    expect(tools.length).toBeGreaterThan(0)
    const agentArb: fc.Arbitrary<Cmd> = fc.oneof(
      ...tools.map((t, i) => templateFor(t.name, t.inputSchema).map((args): Cmd => ({ k: 'agent', tool: i, args }))),
    )
    const cmdsArb = fc.array(fc.oneof({ arbitrary: personArb as fc.Arbitrary<Cmd>, weight: 1 }, { arbitrary: agentArb, weight: 1 }, { arbitrary: fc.constant<Cmd>({ k: 'reread' }), weight: 2 }), { minLength: 4, maxLength: 30 })
    await fc.assert(
      fc.asyncProperty(cmdsArb, (cmds) => run(tools, cmds)),
      // A run opens a database and makes up to 30 calls: a tenth of the kit's count.
      fcRuns(10),
    )
    // Not vacuous: every kind of edit ran, reads succeeded after a box was made private, and refusals happened.
    expect([...seen.kinds].sort()).toEqual(['access', 'addBox', 'compact', 'deletePage', 'editBox', 'setPrivate'])
    expect(seen.cleanReads).toBeGreaterThan(0)
    expect(seen.flipsThenReads).toBeGreaterThan(0)
    expect(seen.refusals).toBeGreaterThan(0)
    // 7,131 runs took 630 s at soak depth, about 9 s per 1000 FUZZ_RUNS; 30 s keeps a margin under load.
  }, fuzzTimeout(30_000))

  it('T-F4D-02: a box made private after the agent read it is gone from the next read, from the cache too', async () => {
    const w = await world()
    try {
      const pageId = w.pages[0]!.pageId
      w.person({ k: 'addBox', page: 0, private: false, places: [...PLACES], origin: 'local' })
      const first = textOf(await w.client.callTool({ name: 'read_page', arguments: { pageId } }))
      expect(first).toContain('CNRY_0_TEXT')
      w.person({ k: 'setPrivate', page: 0, box: 0, private: true, origin: 'remote' })
      const second = textOf(await w.client.callTool({ name: 'read_page', arguments: { pageId } }))
      expect(leaks(second, w.forbidden())).toEqual([])
      expect(second).toContain('[private box omitted]')
      w.person({ k: 'access', target: 0, access: 0 })
      const third = await w.client.callTool({ name: 'read_page', arguments: { pageId } })
      expect(third).toEqual(await w.client.callTool({ name: 'read_page', arguments: { pageId: NOT_THERE } }))
    } finally {
      await w.close()
    }
  })

  it("T-F4D-03: a run gives back what it decoded, so Loro's WebAssembly heap stops growing (FX-30)", async () => {
    const tools = await listedTools()
    const add = (page: number, isPrivate: boolean): Cmd => ({ k: 'addBox', page, private: isPrivate, places: [...PLACES], origin: 'local' })
    const cmds: Cmd[] = [
      add(0, false), { k: 'reread' }, add(1, true), { k: 'reread' }, add(2, false), { k: 'reread' },
      { k: 'setPrivate', page: 0, box: 0, private: true, origin: 'remote' }, { k: 'reread' },
      { k: 'access', target: 1, access: 2 }, { k: 'reread' }, { k: 'compact', page: 0 }, { k: 'reread' },
    ]
    const runs = async (n: number) => {
      for (let i = 0; i < n; i++) await run(tools, cmds)
    }
    await runs(SETTLE_RUNS)
    const settled = loroHeapBytes()
    await runs(MEASURED_RUNS)
    expect((loroHeapBytes() - settled) / MEASURED_RUNS, 'bytes of Loro heap a run kept').toBeLessThan(KEPT_BYTES_PER_RUN)
    // 600 runs take about 11 s; the deadline is a hundred times that, for a machine shared with other suites.
  }, 20 * 60_000)
})

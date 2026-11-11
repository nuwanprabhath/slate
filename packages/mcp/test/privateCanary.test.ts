import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { NotebookDoc, PageDoc, contentToJSON, writeContent, type Access, type PMJSON } from '@slate/core'
import { createSlateMcpServer } from '../src/server'
import { memorySource } from './memorySource'

/**
 * A private box must never reach an agent, whatever tool asks. Black box: the real server over an
 * in-memory transport, the tools enumerated from the server itself (a tool added later is called
 * with arguments generated from its own input schema, so it is covered without editing this file),
 * and a canary string in every place private content can hide. A canary in any response or audit row
 * is a leak; a private box that differs after the calls was written to.
 */

const PLACES = ['TEXT', 'LINK', 'ALT', 'TODO'] as const
type Place = (typeof PLACES)[number]
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'kilo', 'lima', 'tango', 'uniform', 'zulu']

interface BoxSpec {
  private: boolean
  places: Place[]
  word: string
  x: number
  y: number
}
interface PageSpec {
  boxes: BoxSpec[]
  access: Access | null
}
interface SectionSpec {
  access: Access | null
  pages: PageSpec[]
}
type NotebookSpec = SectionSpec[]

const accessArb = fc.constantFrom<Access | null>(null, null, 'read', 'readwrite')
const boxArb: fc.Arbitrary<BoxSpec> = fc.record({
  private: fc.boolean(),
  places: fc.subarray([...PLACES], { minLength: 1 }),
  word: fc.constantFrom(...WORDS),
  x: fc.integer({ min: 0, max: 800 }),
  y: fc.integer({ min: 0, max: 2000 }),
})
const pageArb: fc.Arbitrary<PageSpec> = fc.record({ boxes: fc.array(boxArb, { maxLength: 4 }), access: accessArb })
const sectionArb: fc.Arbitrary<SectionSpec> = fc.record({ access: accessArb, pages: fc.array(pageArb, { minLength: 1, maxLength: 3 }) })
const scenarioArb: fc.Arbitrary<NotebookSpec[]> = fc.array(fc.array(sectionArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 2 })

/** The content of one box: the token goes in each place the box lists. */
function boxContent(places: Place[], word: string, token: (p: Place) => string): PMJSON[] {
  const text = (s: string): PMJSON => ({ type: 'text', text: s })
  const blocks: PMJSON[] = [{ type: 'paragraph', content: [text(word)] }]
  for (const place of places) {
    if (place === 'TEXT') blocks.push({ type: 'paragraph', content: [text(`note ${token(place)} end`)] })
    if (place === 'LINK') {
      const href = `https://example.com/${token(place)}`
      blocks.push({ type: 'paragraph', content: [text('see '), { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href } }] }] })
    }
    if (place === 'ALT') blocks.push({ type: 'image', attrs: { src: 'https://example.com/i.png', alt: token(place) } })
    if (place === 'TODO') {
      blocks.push({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [text(token(place))] }] }] })
    }
  }
  return blocks
}

interface PrivateBox {
  pageId: string
  boxId: string
  x: number
  y: number
  width: number
  content: PMJSON | null
}

interface World {
  client: Client
  audits: ReturnType<typeof memorySource>['audits']
  docs: ReturnType<typeof memorySource>['docs']
  canaries: string[]
  /** Strict substrings of the canaries: what an agent searching for a leak would type. They are never a whole canary. */
  fragments: string[]
  ids: string[]
  titles: string[]
  publicText: Map<string, string[]>
  privates: PrivateBox[]
  grantedPages: string[]
  pageCount: number
}

async function build(scenario: NotebookSpec[]): Promise<World> {
  const mem = memorySource()
  const canaries: string[] = []
  const ids: string[] = []
  const titles: string[] = []
  const publicText = new Map<string, string[]>()
  const privates: PrivateBox[] = []
  const grantedPages: string[] = []
  let n = 0
  let pageCount = 0
  scenario.forEach((sections, nbIndex) => {
    const nb = NotebookDoc.create(`Notebook ${nbIndex}`)
    const notebookId = `nb${nbIndex}`
    ids.push(notebookId)
    const pages: Array<{ pageId: string; spec: PageSpec }> = []
    sections.forEach((section, si) => {
      const sectionId = nb.addSection(`Section ${si}`)
      ids.push(sectionId)
      if (section.access) nb.setAccess(sectionId, section.access)
      section.pages.forEach((spec, pi) => {
        const title = `Page ${nbIndex}-${si}-${pi}`
        titles.push(title)
        const page = nb.addPage(sectionId, title)
        ids.push(page.pageId, page.id)
        if (spec.access) nb.setAccess(page.id, spec.access)
        pages.push({ pageId: page.pageId, spec })
        pageCount++
        if (nb.effectiveAccess(page.id)) grantedPages.push(page.pageId)
      })
    })
    mem.docs.set(`notebook:${notebookId}`, [nb.doc.export({ mode: 'snapshot' })])
    for (const { pageId, spec } of pages) {
      const doc = new PageDoc()
      const pub: string[] = []
      const boxIds: Array<{ id: string; spec: BoxSpec }> = []
      for (const box of spec.boxes) {
        const k = n++
        const token = (p: Place) => {
          if (!box.private) return `plain_${k}_${p.toLowerCase()}`
          const canary = `CNRY_${k}_${p}`
          canaries.push(canary)
          return canary
        }
        const id = doc.addBox({ x: box.x, y: box.y, width: 300 })
        writeContent(doc.contentMap(id)!, boxContent(box.places, box.word, token))
        doc.doc.commit()
        if (box.private) doc.updateBox(id, { private: true })
        else pub.push(box.word, ...box.places.map((p) => token(p)))
        boxIds.push({ id, spec: box })
      }
      publicText.set(pageId, pub)
      for (const { id, spec: box } of boxIds) {
        if (!box.private) continue
        const state = doc.getBox(id)!
        privates.push({ pageId, boxId: id, x: state.x, y: state.y, width: state.width, content: contentToJSON(doc.contentMap(id)!) })
      }
      mem.docs.set(`page:${pageId}`, [doc.doc.export({ mode: 'snapshot' })])
    }
  })
  const fragments = canaries.flatMap((c) => [c.slice(0, -1), c.slice(1), c.slice(2, -2), 'CNRY', c.split('_')[1]!, c.split('_')[2]!])
  for (const f of fragments) expect(canaries).not.toContain(f)
  const server = createSlateMcpServer(mem.source)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'canary', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, audits: mem.audits, docs: mem.docs, canaries, fragments, ids, titles, publicText, privates, grantedPages, pageCount }
}

/** An argument before the world exists: pool picks resolve against the world's ids, titles, words and fragments. */
type Template = { k: 'pick'; n: number } | { k: 'lit'; v: unknown } | { k: 'arr'; items: Template[] } | { k: 'obj'; props: Record<string, Template> }

interface Schema {
  type?: string
  enum?: unknown[]
  minLength?: number
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
}

/** Arguments for any tool, from its own input schema. A shape it cannot generate fails loudly rather than skipping the tool. */
function templateFor(tool: string, schema: Schema): fc.Arbitrary<Template> {
  if (schema.enum) return fc.constantFrom(...schema.enum).map((v) => ({ k: 'lit', v }))
  switch (schema.type) {
    case 'string':
      return fc.oneof(
        { arbitrary: fc.nat().map((n): Template => ({ k: 'pick', n })), weight: 5 },
        { arbitrary: fc.string({ minLength: schema.minLength ?? 0, maxLength: 16 }).map((v): Template => ({ k: 'lit', v })), weight: 1 },
      )
    case 'number':
    case 'integer':
      return fc.integer({ min: -5, max: 1000 }).map((v): Template => ({ k: 'lit', v }))
    case 'boolean':
      return fc.boolean().map((v): Template => ({ k: 'lit', v }))
    case 'array':
      return fc.array(templateFor(tool, schema.items ?? {}), { maxLength: 3 }).map((items): Template => ({ k: 'arr', items }))
    case 'object': {
      const keys = Object.keys(schema.properties ?? {})
      const required = new Set(schema.required ?? [])
      return fc
        .tuple(...keys.map((key) => fc.option(templateFor(tool, schema.properties![key]!), { nil: undefined, freq: required.has(key) ? Number.MAX_SAFE_INTEGER : 2 })))
        .map((values): Template => {
          const props: Record<string, Template> = {}
          keys.forEach((key, i) => {
            const v = values[i]
            if (v !== undefined) props[key] = v
          })
          return { k: 'obj', props }
        })
    }
    default:
      throw new Error(`privateCanary: cannot generate arguments for tool "${tool}" (schema ${JSON.stringify(schema)}); teach templateFor this shape so the tool stays covered`)
  }
}

function resolve(t: Template, pool: string[]): unknown {
  switch (t.k) {
    case 'pick':
      return pool[t.n % pool.length]
    case 'lit':
      return t.v
    case 'arr':
      return t.items.map((i) => resolve(i, pool))
    case 'obj':
      return Object.fromEntries(Object.entries(t.props).map(([k, v]) => [k, resolve(v, pool)]))
  }
}

const poolOf = (w: World): string[] => [...w.ids, ...w.titles, ...WORDS, ...w.fragments, 'missing-id']
const leaks = (haystack: unknown, canaries: string[]): string[] => {
  const text = JSON.stringify(haystack).toLowerCase()
  return canaries.filter((c) => text.includes(c.toLowerCase()))
}
const textOf = (r: unknown): string => ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n')

async function listedTools(): Promise<Array<{ name: string; inputSchema: Schema }>> {
  const probe = await build([[{ access: null, pages: [{ boxes: [], access: null }] }]])
  const { tools } = await probe.client.listTools()
  return tools as Array<{ name: string; inputSchema: Schema }>
}

describe('private boxes never reach an agent', () => {
  it('registers at least one tool, and every tool has an input schema this test can fill', async () => {
    const tools = await listedTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(() => templateFor(t.name, t.inputSchema)).not.toThrow()
  })

  it('no tool response or audit row holds a canary, and no call alters a private box', async () => {
    const tools = await listedTools()
    const calls = fc.tuple(...tools.map((t) => fc.array(templateFor(t.name, t.inputSchema), { minLength: 1, maxLength: 3 })))
    await fc.assert(
      fc.asyncProperty(scenarioArb, calls, async (scenario, perTool) => {
        const world = await build(scenario)
        const registered = (await world.client.listTools()).tools.map((t) => t.name)
        expect(registered.sort()).toEqual(tools.map((t) => t.name).sort())
        const pool = poolOf(world)
        const called = new Set<string>()
        for (const [i, tool] of tools.entries()) {
          for (const template of perTool[i]!) {
            const args = resolve(template, pool) as Record<string, unknown>
            const result = await world.client.callTool({ name: tool.name, arguments: args }).catch((e: unknown) => ({ protocolError: String(e) }))
            called.add(tool.name)
            expect(leaks(result, world.canaries), `${tool.name}(${JSON.stringify(args)}) leaked`).toEqual([])
          }
        }
        // Every tool the server registers was called.
        expect([...called].sort()).toEqual(registered)
        expect(leaks(world.audits, world.canaries), 'audit rows leaked').toEqual([])
        // No write touched a private box.
        for (const box of world.privates) {
          const page = PageDoc.fromUpdates(world.docs.get(`page:${box.pageId}`)!)
          const state = page.getBox(box.boxId)
          expect(state, `private box ${box.boxId} is gone`).toBeDefined()
          expect(state).toMatchObject({ private: true, x: box.x, y: box.y, width: box.width })
          expect(contentToJSON(page.contentMap(box.boxId)!)).toEqual(box.content)
        }
      }),
      { numRuns: 60, seed: 0x5c0a7e },
    )
  }, 120_000)

  it('is not vacuous: granted public content reaches the agent, private boxes become the placeholder, canary searches find nothing', async () => {
    const box = (isPrivate: boolean, word: string): BoxSpec => ({ private: isPrivate, places: [...PLACES], word, x: 0, y: isPrivate ? 300 : 0 })
    const world = await build([[{ access: 'read', pages: [{ boxes: [box(false, 'alpha'), box(true, 'bravo'), box(false, 'delta'), box(true, 'echo')], access: null }] }]])
    expect(world.canaries.length).toBe(8)
    const pageId = world.grantedPages[0]!
    const read = textOf(await world.client.callTool({ name: 'read_page', arguments: { pageId } }))
    for (const text of world.publicText.get(pageId)!) expect(read).toContain(text)
    expect(read.match(/\[private box omitted\]/g)).toHaveLength(2)
    expect(leaks(read, world.canaries)).toEqual([])
    for (const query of [...world.fragments, ...world.canaries]) {
      const found = textOf(await world.client.callTool({ name: 'search', arguments: { query } }))
      expect(leaks(found, world.canaries), `search ${query}`).toEqual([])
      // Short fragments such as "TEXT" match public text; one that carries the canary's marker or id matches nothing public.
      if (/nry|ry_\d+_/i.test(query)) expect(found, `search ${query}`).toBe('[]')
    }
    expect(world.audits.filter((a) => a.tool === 'search')).toHaveLength(world.fragments.length + world.canaries.length)
  })
})

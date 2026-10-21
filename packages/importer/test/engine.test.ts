import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PMJSON } from '@slate/core'
import { runImport, selectionToPaths } from '../src/engine'
import { GraphClient } from '../src/graph'
import type { GraphSource, ImportProgress, SectionPath } from '../src/types'
import { startFakeGraph } from './fakeGraph'
import type { FakeGraph, FakeGraphData } from './fakeGraph'
import { memorySink, memoryState } from './memorySink'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const html = (text: string, img = false) =>
  `<html><head><title>${text}</title></head><body data-absolute-enabled="true">` +
  `<div style="position:absolute;left:48px;top:100px;width:400px"><p>${text}</p>` +
  (img ? `<p><img src="https://graph.microsoft.com/v1.0/resources/img1/$value" data-src-type="image/png" alt="pic" /></p>` : '') +
  `</div></body></html>`

const page = (id: string, title: string, order: number, level = 0, body = html(title)) => ({
  id,
  title,
  level,
  order,
  lastModified: '2026-01-01T00:00:00Z',
  html: body
})

const data = (): FakeGraphData => ({
  notebooks: [
    {
      id: 'nb1',
      name: 'Work',
      sections: [{ id: 's1', name: 'Inbox', pages: [page('p2', 'Second', 2, 1), page('p1', 'First', 1, 0, html('First', true)), page('p3', 'Third', 3)] }],
      sectionGroups: [
        { id: 'g1', name: 'Projects', sections: [{ id: 's2', name: 'Alpha', pages: [page('p4', 'Alpha one', 1, 0, fixture('code-and-lossy.html'))] }], sectionGroups: [] }
      ]
    }
  ]
})

function images(blocks: PMJSON[]): string[] {
  return blocks.flatMap((b) => [...(b.type === 'image' ? [String(b.attrs?.src)] : []), ...images(b.content ?? [])])
}

describe('runImport', () => {
  let fake: FakeGraph
  let graph: GraphClient
  beforeEach(async () => {
    fake = await startFakeGraph(data())
    graph = new GraphClient({ baseUrl: fake.url, getToken: async () => 'fake-token', sleep: async () => {} })
  })
  afterEach(() => fake.close())

  async function paths(ids: string[]): Promise<SectionPath[]> {
    return selectionToPaths(await graph.listTree(), new Set(ids))
  }
  const run = async (opts: { ids: string[]; sink: ReturnType<typeof memorySink>; state: ReturnType<typeof memoryState>; graph?: GraphSource; signal?: AbortSignal; onlyFailed?: boolean; onProgress?: (p: ImportProgress) => void }) =>
    runImport({ graph: opts.graph ?? graph, sink: opts.sink, state: opts.state, paths: await paths(opts.ids), onProgress: opts.onProgress ?? (() => {}), signal: opts.signal, onlyFailed: opts.onlyFailed })

  it('imports one section in page order, with levels, mapped boxes and blob images', async () => {
    const sink = memorySink()
    const progress: ImportProgress[] = []
    const result = await run({ ids: ['s1'], sink, state: memoryState(), onProgress: (p) => progress.push(structuredClone(p)) })
    expect(result.phase).toBe('done')
    expect(result.imported).toBe(3)
    const sec = sink.notebooks.get('nb1')!.sections.get('s1')!
    expect([...sec.pages.keys()]).toEqual(['p1', 'p2', 'p3'])
    expect(sec.pages.get('p2')!.level).toBe(1)
    expect(sec.pages.get('p1')!.title).toBe('First')
    const box = sec.pages.get('p1')!.page.boxes[0]!
    expect(box.x).toBe(48)
    expect(images(box.blocks)).toEqual(['slate-blob://blob/1.png'])
    expect(progress.length).toBeGreaterThanOrEqual(3)
    expect(sink.notebooks.get('nb1')!.sections.has('s2')).toBe(false)
  })

  it('selecting a notebook imports every section, including inside groups', async () => {
    const sink = memorySink()
    const result = await run({ ids: ['nb1'], sink, state: memoryState() })
    expect(result.sectionsTotal).toBe(2)
    const nb = sink.notebooks.get('nb1')!
    expect(nb.groups.get('g1')!.name).toBe('Projects')
    expect(nb.sections.get('s2')!.parent).toBe(nb.groups.get('g1')!.treeId)
    expect(nb.sections.get('s1')!.parent).toBeNull()
    expect([...nb.sections.get('s2')!.pages.keys()]).toEqual(['p4'])
  })

  it('selectionToPaths keeps tree order without duplicates', async () => {
    const tree = await graph.listTree()
    expect(selectionToPaths(tree, new Set(['s2', 'nb1', 'g1'])).map((p) => p.section.id)).toEqual(['s1', 's2'])
    expect(selectionToPaths(tree, new Set(['g1']))[0]!.groups).toEqual([{ id: 'g1', name: 'Projects' }])
  })

  it('skips every unchanged page on a second run', async () => {
    const sink = memorySink()
    const state = memoryState()
    await run({ ids: ['nb1'], sink, state })
    const writes = sink.writes
    const again = await run({ ids: ['nb1'], sink, state })
    expect(again.skipped).toBe(4)
    expect(again.imported).toBe(0)
    expect(sink.writes).toBe(writes)
    expect(sink.notebooks.size).toBe(1)
  })

  it('re-imports only a changed page', async () => {
    const sink = memorySink()
    const state = memoryState()
    await run({ ids: ['s1'], sink, state })
    fake.setPage('s1', { ...page('p3', 'Third', 3, 0, html('Third changed')), lastModified: '2026-02-01T00:00:00Z' })
    const again = await run({ ids: ['s1'], sink, state })
    expect(again.imported).toBe(1)
    expect(again.skipped).toBe(2)
    expect(JSON.stringify(sink.notebooks.get('nb1')!.sections.get('s1')!.pages.get('p3')!.page)).toContain('Third changed')
    expect(state.map.get('p3')!.lastModified).toBe('2026-02-01T00:00:00Z')
  })

  it('a failing page does not stop the rest and can be retried alone', async () => {
    const sink = memorySink()
    const state = memoryState()
    let failOnce = true
    const flaky: GraphSource = {
      listTree: () => graph.listTree(),
      listPages: (id) => graph.listPages(id),
      resource: (url) => graph.resource(url),
      pageContent: (id) => {
        if (id === 'p2' && failOnce) {
          failOnce = false
          // 503 is retried; six in a row outlast the five retries.
          fake.failNext(503, 6)
        }
        return graph.pageContent(id)
      }
    }
    const result = await run({ ids: ['s1'], sink, state, graph: flaky })
    expect(result.imported).toBe(2)
    expect(result.failed.map((f) => f.pageId)).toEqual(['p2'])
    expect(result.failed[0]!.error).toMatch(/503/)
    expect(state.map.get('p2')!.status).toBe('failed')
    const retry = await run({ ids: ['s1'], sink, state, onlyFailed: true })
    expect(retry.imported).toBe(1)
    expect(retry.failed).toEqual([])
    expect(retry.skipped).toBe(2)
    expect(state.map.get('p2')!.status).toBe('done')
  })

  it('stops on abort and resumes on a rerun', async () => {
    const sink = memorySink()
    const state = memoryState()
    const ctrl = new AbortController()
    const first = await run({
      ids: ['s1'],
      sink,
      state,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.pagesDone === 1) ctrl.abort()
      }
    })
    expect(first.phase).toBe('cancelled')
    expect(first.imported).toBe(1)
    const rest = await run({ ids: ['s1'], sink, state })
    expect(rest.phase).toBe('done')
    expect(rest.imported).toBe(2)
    expect(rest.skipped).toBe(1)
  })

  it('reports lossy items per page', async () => {
    const result = await run({ ids: ['s2'], sink: memorySink(), state: memoryState() })
    expect(result.lossy).toHaveLength(1)
    expect(result.lossy[0]!.title).toBe('Alpha one')
    expect(result.lossy[0]!.items.join(' ')).toContain('report.pdf')
  })
})

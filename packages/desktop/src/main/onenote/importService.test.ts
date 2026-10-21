import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDoc, PageDoc, contentToJSON } from '@slate/core'
import type { ImportProgress } from '@slate/importer'
import { startFakeGraph, type FakeGraph, type FakeGraphData } from '../../../../importer/test/fakeGraph'
import { BlobStore } from '../blobs'
import { DocStore } from '../store'
import { createAuthService } from './auth'
import { ImportService } from './importService'

const html = (title: string, boxes: Array<{ x: number; y: number; text: string }>, img = false) =>
  `<html><head><title>${title}</title></head><body data-absolute-enabled="true">` +
  boxes.map((b) => `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:300px"><p>${b.text}</p></div>`).join('') +
  (img ? `<div style="position:absolute;left:48px;top:400px;width:300px"><img src="https://graph.microsoft.com/v1.0/resources/r1/$value" data-src-type="image/png" alt="pic" /></div>` : '') +
  `</body></html>`

const page = (id: string, title: string, order: number, level: number, body: string) => ({ id, title, level, order, lastModified: '2026-01-01T00:00:00Z', html: body })

const data = (): FakeGraphData => ({
  notebooks: [
    {
      id: 'nb1',
      name: 'Work',
      sections: [{ id: 'ad', name: 'AD', pages: [page('a1', 'Misc', 1, 0, html('Misc', [{ x: 48, y: 100, text: 'misc' }]))] }],
      sectionGroups: [
        {
          id: 'g1',
          name: 'Projects',
          sectionGroups: [],
          sections: [
            {
              id: 'tern',
              name: 'TERN',
              pages: [
                page('p2', 'Hot fixes', 2, 1, html('Hot fixes', [{ x: 48, y: 100, text: 'fix' }])),
                page('p1', 'Releases', 1, 0, html('Releases', [{ x: 48, y: 100, text: 'left' }, { x: 500, y: 200, text: 'right' }], true)),
                page('p3', 'Old', 3, 0, html('Old', [{ x: 48, y: 100, text: 'old' }])),
              ],
            },
          ],
        },
      ],
    },
  ],
})

describe('ImportService', () => {
  let dir: string
  let fake: FakeGraph
  let service: ImportService
  let progress: ImportProgress[]
  let onProgress: (p: ImportProgress) => void

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slate-import-'))
    fake = await startFakeGraph(data())
    progress = []
    onProgress = () => {}
    const auth = createAuthService({ clientId: null, cacheFile: join(dir, 'msal.bin'), openBrowser: async () => {}, fake: true })
    await auth.signIn()
    service = new ImportService({
      dbFile: join(dir, 'slate.db'),
      blobs: new BlobStore(join(dir, 'blobs')),
      auth,
      graphUrl: fake.url,
      emit: (p) => {
        progress.push(p)
        onProgress(p)
      },
    })
  })
  afterEach(async () => {
    service.close()
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function readBack() {
    const store = new DocStore(join(dir, 'slate.db'))
    const notebooks = store.list('notebook:').map((id) => NotebookDoc.fromUpdates(store.load(id)))
    const pageDoc = (pageId: string) => PageDoc.fromUpdates(store.load(`page:${pageId}`))
    return { store, notebooks, pageDoc }
  }

  it('imports a section into a notebook doc and page docs another connection can read', async () => {
    const result = await service.start(['tern'])
    expect(result.phase).toBe('done')
    expect(result.imported).toBe(3)
    expect(progress.length).toBeGreaterThanOrEqual(3)

    const { store, notebooks, pageDoc } = readBack()
    expect(notebooks).toHaveLength(1)
    const nb = notebooks[0]!
    expect(nb.name).toBe('Work')
    const [group] = nb.items()
    expect(group!.kind).toBe('sectionGroup')
    expect(group!.title).toBe('Projects')
    const section = group!.children[0]!
    expect(section.title).toBe('TERN')
    expect(section.children.map((p) => [p.title, p.level])).toEqual([
      ['Releases', 0],
      ['Hot fixes', 1],
      ['Old', 0],
    ])

    const releases = pageDoc(section.children[0]!.pageId!)
    const boxes = releases.listBoxes().sort((a, b) => a.y - b.y)
    expect(boxes).toHaveLength(3)
    expect(boxes[0]!.x).toBe(48)
    expect(boxes[1]!.x).toBe(500)
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y)
    expect(JSON.stringify(contentToJSON(releases.contentMap(boxes[1]!.id)!))).toContain('right')
    expect(JSON.stringify(contentToJSON(releases.contentMap(boxes[2]!.id)!))).toMatch(/slate-blob:\/\/blob\/[a-f0-9]{64}\.png/)
    store.close()
  })

  it('retries a page that failed and skips everything on a second start', async () => {
    onProgress = (p) => {
      // The engine is sequential, so the next request is the second page's content.
      if (p.pagesDone === 1 && p.imported === 1 && p.failed.length === 0) fake.failNext(500, 1)
    }
    const first = await service.start(['tern'])
    expect(first.imported).toBe(2)
    expect(first.failed.map((f) => f.title)).toEqual(['Hot fixes'])
    onProgress = () => {}

    const retry = await service.retryFailed()
    expect(retry.imported).toBe(1)
    expect(retry.failed).toEqual([])
    const { store, notebooks } = readBack()
    expect(notebooks[0]!.items()[0]!.children[0]!.children.map((p) => p.title)).toEqual(['Releases', 'Hot fixes', 'Old'])
    store.close()

    const again = await service.start(['tern'])
    expect(again.imported).toBe(0)
    expect(again.skipped).toBe(3)
    expect(readBack().notebooks).toHaveLength(1)
  })

  it('re-imports a changed page in place', async () => {
    await service.start(['tern'])
    fake.setPage('tern', { ...page('p3', 'Old renamed', 3, 0, html('Old', [{ x: 60, y: 100, text: 'new text' }])), lastModified: '2026-03-01T00:00:00Z' })
    const again = await service.start(['tern'])
    expect(again.imported).toBe(1)
    const { store, notebooks, pageDoc } = readBack()
    const old = notebooks[0]!.items()[0]!.children[0]!.children[2]!
    expect(old.title).toBe('Old renamed')
    const boxes = pageDoc(old.pageId!).listBoxes()
    expect(boxes).toHaveLength(1)
    expect(JSON.stringify(contentToJSON(pageDoc(old.pageId!).contentMap(boxes[0]!.id)!))).toContain('new text')
    store.close()
  })
})

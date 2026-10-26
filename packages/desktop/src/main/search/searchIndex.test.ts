import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDoc, PageDoc, writeContent, type PMJSON } from '@slate/core'
import type { SearchQuery } from '../../shared/api'
import { DocStore } from '../store'
import { SearchIndex } from './searchIndex'

const dirs: string[] = []
const open: Array<{ close(): void }> = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-search-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => {
  open.splice(0).forEach((o) => o.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const para = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** Writes a page doc with one box per entry; each box holds one paragraph per line. */
function writePage(store: DocStore, pageId: string, boxes: Array<{ lines: string[]; private?: boolean; y?: number }>): PageDoc {
  const page = new PageDoc()
  boxes.forEach((b, i) => {
    const id = page.addBox({ x: 0, y: b.y ?? i * 100, width: 300 })
    writeContent(page.contentMap(id)!, b.lines.map(para), page.doc)
    if (b.private) page.updateBox(id, { private: true })
    page.doc.commit()
  })
  // A fresh doc replaces the page: merged with the old one, both sets of boxes would remain.
  store.remove(`page:${pageId}`)
  store.append(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
  return page
}

function setup() {
  const file = tempDb()
  const store = new DocStore(file)
  const nb = NotebookDoc.create('Work')
  const s1 = nb.addSection('One')
  const s2 = nb.addSection('Two')
  const p1 = nb.addPage(s1, 'First')
  const p2 = nb.addPage(s2, 'Second')
  store.append('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
  writePage(store, p1.pageId, [{ lines: ['alpha beta'] }])
  writePage(store, p2.pageId, [{ lines: ['alpha gamma'] }])
  const index = new SearchIndex(store, { debounceMs: 10_000 })
  open.push(index, store)
  index.ensureBuilt()
  return { file, store, nb, s1, s2, p1, p2, index }
}

const q = (text: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({ text, matchCase: false, wholeWord: false, regex: false, scope: { kind: 'all' }, ...extra })

describe('SearchIndex', () => {
  it('indexes every page and groups matches by page with names and snippets', () => {
    const { index, p1, p2 } = setup()
    const r = index.query(q('alpha'))
    expect(r.total).toBe(2)
    expect(r.truncated).toBe(false)
    expect(r.pages.map((p) => p.pageId).sort()).toEqual([p1.pageId, p2.pageId].sort())
    const first = r.pages.find((p) => p.pageId === p1.pageId)!
    expect(first).toMatchObject({ pageTitle: 'First', sectionName: 'One', notebookName: 'Work' })
    expect(first.matches[0]!.snippet).toBe('alpha beta')
    expect(first.matches[0]!.ranges).toEqual([[0, 5]])
    expect(first.matches[0]!.occurrence).toBe(0)
  })

  it('finds substrings inside words and short queries', () => {
    const { index } = setup()
    expect(index.query(q('lph')).total).toBe(2)
    expect(index.query(q('ga')).total).toBe(1)
  })

  it('re-indexes a page after a debounced change', () => {
    const { index, store, p1 } = setup()
    writePage(store, p1.pageId, [{ lines: ['delta only'] }])
    index.docChanged(`page:${p1.pageId}`)
    // A query flushes the pending re-index, so it never returns stale rows.
    expect(index.query(q('delta')).total).toBe(1)
    expect(index.query(q('beta')).total).toBe(0)
  })

  it('drops a removed page', () => {
    const { index, store, p1 } = setup()
    store.remove(`page:${p1.pageId}`)
    index.docRemoved(`page:${p1.pageId}`)
    expect(index.query(q('alpha')).total).toBe(1)
  })

  it('filters by notebook and section scope', () => {
    const { index, s1, s2, p2 } = setup()
    expect(index.query(q('alpha', { scope: { kind: 'notebook', id: 'nb1' } })).total).toBe(2)
    expect(index.query(q('alpha', { scope: { kind: 'notebook', id: 'other' } })).total).toBe(0)
    expect(index.query(q('alpha', { scope: { kind: 'section', id: s1 } })).total).toBe(1)
    const r = index.query(q('alpha', { scope: { kind: 'section', id: s2 } }))
    expect(r.pages.map((p) => p.pageId)).toEqual([p2.pageId])
  })

  it('follows a page moved to another section', () => {
    const { index, store, nb, s2, p1 } = setup()
    nb.moveInto(p1.id, s2)
    store.append('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
    index.docChanged('notebook:nb1')
    expect(index.query(q('alpha', { scope: { kind: 'section', id: s2 } })).total).toBe(2)
  })

  it('matches regex, whole word and case exactly', () => {
    const { index } = setup()
    expect(index.query(q('al.ha (b|g)', { regex: true })).total).toBe(2)
    expect(index.query(q('alph', { wholeWord: true })).total).toBe(0)
    expect(index.query(q('alpha', { wholeWord: true })).total).toBe(2)
    expect(index.query(q('ALPHA', { matchCase: true })).total).toBe(0)
    expect(index.query(q('(', { regex: true })).total).toBe(0)
  })

  it('caps at 500 matches and says it truncated', () => {
    const { index, store, p1 } = setup()
    writePage(store, p1.pageId, [{ lines: Array.from({ length: 300 }, () => 'alpha alpha') }])
    index.docChanged(`page:${p1.pageId}`)
    const r = index.query(q('alpha'))
    expect(r.total).toBe(500)
    expect(r.truncated).toBe(true)
  })

  it('counts occurrences per box in reading order, for the in-page find bar', () => {
    const { index, store, p1 } = setup()
    writePage(store, p1.pageId, [{ lines: ['zeta', 'zeta zeta'], y: 200 }, { lines: ['zeta'], y: 0 }])
    index.docChanged(`page:${p1.pageId}`)
    const [page] = index.query(q('zeta')).pages
    expect(page!.matches.map((m) => m.occurrence)).toEqual([0, 0, 1, 2])
    expect(new Set(page!.matches.slice(1).map((m) => m.boxId)).size).toBe(1)
  })

  it('includes private boxes: the flag only hides them from AI', () => {
    const { index, store, p1 } = setup()
    writePage(store, p1.pageId, [{ lines: ['secret words'], private: true }])
    index.docChanged(`page:${p1.pageId}`)
    expect(index.query(q('secret')).total).toBe(1)
  })

  it('trims snippets to about 40 characters around the match', () => {
    const { index, store, p1 } = setup()
    writePage(store, p1.pageId, [{ lines: [`${'x'.repeat(100)} needle ${'y'.repeat(100)}`] }])
    index.docChanged(`page:${p1.pageId}`)
    const m = index.query(q('needle')).pages[0]!.matches[0]!
    expect(m.snippet.length).toBeLessThan(100)
    expect(m.snippet.slice(m.ranges[0]![0], m.ranges[0]![1])).toBe('needle')
  })

  it('builds once on startup and rebuilds when the index version changes', () => {
    const { file, index } = setup()
    index.close()
    const store = new DocStore(file)
    const again = new SearchIndex(store)
    open.push(again, store)
    expect(again.ensureBuilt()).toBe(false)
    store.setSyncMeta('search.version', new TextEncoder().encode('0'))
    expect(again.ensureBuilt()).toBe(true)
    expect(again.query(q('alpha')).total).toBe(2)
  })
})

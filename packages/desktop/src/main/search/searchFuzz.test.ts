import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileQuery, matchAll, NotebookDoc, PageDoc, writeContent, type PMJSON } from '@slate/core'
import type { SearchQuery } from '../../shared/api'
import { fcParams, fcRuns } from '../../../test/fuzz'
import { DocStore } from '../store'
import { isSearchQuery } from '../ipc'
import { MAX_MATCHES, pageRows, SearchIndex } from './searchIndex'

const dirs: string[] = []
const open: Array<{ close(): void }> = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-searchfuzz-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => {
  open.splice(0).forEach((o) => o.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

// ASCII letters, digits, punctuation and a few CJK characters: where the trigram tokenizer's case
// folding is unambiguous. No U+0000 in stored text (a phrase may carry one).
const textChar = fc.oneof(
  fc.constantFrom(...'abcABC019 .,"*:()-_'),
  fc.constantFrom('日', '本', '語'),
  fc.constantFrom('N', 'E', 'A', 'R'),
)
const text = fc.array(textChar, { maxLength: 24 }).map((cs) => cs.join(''))
// U+0000 is excluded from phrases: a phrase containing it makes `searchRows` throw "unterminated string"
// (open finding F3E-1; the IPC accepts such a query).
const phraseChar = fc.oneof(textChar, fc.constantFrom('"', '*', ':', '^', '-'))
const phrase = fc.array(phraseChar, { minLength: 3, maxLength: 10 }).map((cs) => cs.join(''))
// Phrases built from words the SQL grammar treats specially, plus text drawn from the rows' own alphabet.
const hostilePhrase = fc.oneof(
  phrase,
  fc.constantFrom('text:abc', 'a NEAR b', '"abc"', 'abc*', 'a" OR "b', '"" ""', 'NOT abc', '{text}: abc', '日本語'),
)

const para = (t: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })

describe('T-F3E: search index fuzz', () => {
  it('T-F3E-01: searchRows never throws on a phrase of 3+ characters and returns exactly the rows containing it', () => {
    fc.assert(
      fc.property(fc.array(text, { maxLength: 12 }), hostilePhrase, (texts, p) => {
        const store = new DocStore(tempDb())
        try {
          // Bad phrase may legitimately not have 3 characters after generation; skip nothing, just assert the contract.
          store.replaceSearchPage(
            { pageId: 'p1', sectionId: 's1', notebookId: 'n1' },
            texts.map((t, i) => ({ boxId: `b${i}`, ord: i, text: t })),
          )
          const got = store.searchRows(null, p).map((r) => r.text)
          const want = texts.filter((t) => t.toLowerCase().includes(p.toLowerCase()))
          expect(got.sort()).toEqual(want.sort())
        } finally {
          store.close()
        }
      }),
      { ...fcParams, ...fcRuns(20, 50) },
    )
  })

  // --- Property 2/3/4 world: one notebook, two sections, pages edited, removed and moved. ---
  type Cmd =
    | { op: 'edit'; page: number; lines: string[][] }
    | { op: 'remove'; page: number }
    | { op: 'move'; page: number; section: number }
    | { op: 'query'; text: string; matchCase: boolean; wholeWord: boolean; scope: 0 | 1 | 2 | 3 }
  const words = fc.constantFrom('abc', 'ABC', 'ab', 'c', 'a b', 'abcabc', '日本', 'x.y', 'abc,', '')
  const line = fc.array(words, { maxLength: 4 }).map((ws) => ws.join(' '))
  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ op: fc.constant('edit' as const), page: fc.nat(2), lines: fc.array(fc.array(line, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant('remove' as const), page: fc.nat(2) }),
    fc.record({ op: fc.constant('move' as const), page: fc.nat(2), section: fc.nat(1) }),
    fc.record({
      op: fc.constant('query' as const),
      text: fc.oneof(fc.constantFrom('abc', 'ABC', 'ab', 'c', 'a b', '日本', 'x.y', 'bc,', '.', 'abcabc', ' '), phrase),
      matchCase: fc.boolean(),
      wholeWord: fc.boolean(),
      scope: fc.constantFrom(0, 1, 2, 3),
    }),
  )

  function world() {
    const store = new DocStore(tempDb())
    const nb = NotebookDoc.create('Work')
    const sections = [nb.addSection('One'), nb.addSection('Two')]
    const pages = [0, 1, 2].map((i) => nb.addPage(sections[i % 2]!, `P${i}`))
    const sync = () => {
      store.remove('notebook:nb1')
      store.append('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
    }
    sync()
    const index = new SearchIndex(store, { debounceMs: 10_000 })
    open.push(index, store)
    index.ensureBuilt()
    // What each page holds, keyed by pageId, or absent once removed.
    const docs = new Map<string, PageDoc>()
    const edit = (i: number, lines: string[][]) => {
      const pageId = pages[i]!.pageId
      const page = new PageDoc()
      lines.forEach((ls, n) => {
        const id = page.addBox({ x: 0, y: n * 100, width: 300 })
        writeContent(page.contentMap(id)!, ls.map(para), page.doc)
        page.doc.commit()
      })
      store.remove(`page:${pageId}`)
      store.append(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
      docs.set(pageId, page)
      index.docChanged(`page:${pageId}`)
    }
    return { store, nb, sections, pages, sync, index, docs, edit }
  }

  /** `matchAll` over every row of every stored page the tree still lists, in scope. */
  function oracle(w: ReturnType<typeof world>, c: Extract<Cmd, { op: 'query' }>): string[] {
    const re = compileQuery(c.text, { matchCase: c.matchCase, wholeWord: c.wholeWord, regex: false })
    const out: string[] = []
    if (!re) return out
    w.pages.forEach((p) => {
      const doc = w.docs.get(p.pageId)
      const item = w.nb.findPage(p.pageId)
      if (!doc || !item) return
      const inScope = c.scope === 0 || c.scope === 3 || w.nb.pageIdsUnder(w.sections[c.scope - 1]!).includes(p.pageId)
      if (!inScope) return
      // `occurrence` counts per box across its paragraphs, as the in-page find bar numbers them.
      const seen = new Map<string, number>()
      for (const row of pageRows(doc)) {
        for (const _ of matchAll(row.text, re, c.wholeWord)) {
          const n = seen.get(row.boxId) ?? 0
          seen.set(row.boxId, n + 1)
          out.push(`${p.pageId}|${row.boxId}|${n}`)
        }
      }
    })
    return out.sort()
  }

  function run(cmds: Cmd[]): void {
    const w = world()
    const removed = new Set<number>()
    for (const c of cmds) {
      if (c.op === 'edit') {
        // An edit of a page the tree no longer lists still stores its doc; queries must skip it.
        w.edit(c.page, c.lines)
      } else if (c.op === 'remove') {
        const p = w.pages[c.page]!
        w.store.remove(`page:${p.pageId}`)
        w.docs.delete(p.pageId)
        if (!removed.has(c.page)) {
          if (w.nb.findPage(p.pageId)) w.nb.delete(p.id)
          w.sync()
          w.index.docRemoved(`page:${p.pageId}`)
          w.index.docChanged('notebook:nb1')
        }
        removed.add(c.page)
      } else if (c.op === 'move') {
        const p = w.pages[c.page]!
        if (removed.has(c.page)) continue
        w.nb.moveInto(p.id, w.sections[c.section]!)
        w.sync()
        w.index.docChanged('notebook:nb1')
      } else {
        const q: SearchQuery = {
          text: c.text,
          matchCase: c.matchCase,
          wholeWord: c.wholeWord,
          regex: false,
          scope: c.scope === 0 ? { kind: 'all' } : c.scope === 3 ? { kind: 'notebook', id: 'nb1' } : { kind: 'section', id: w.sections[c.scope - 1]! },
        }
        w.index.flush()
        const r = w.index.query(q)
        const got = r.pages.flatMap((pg) => pg.matches.map((m) => `${pg.pageId}|${m.boxId}|${m.occurrence}`)).sort()
        expect(got).toEqual(oracle(w, c))
        expect(r.total).toBeLessThanOrEqual(MAX_MATCHES)
        expect(r.total).toBe(got.length)
        expect(r.truncated).toBe(false)
      }
    }
  }

  it('T-F3E-02: a literal query equals matchAll over pageRows after any edit, removal and move', () => {
    fc.assert(fc.property(fc.array(cmd, { minLength: 1, maxLength: 14 }), run), { ...fcParams, ...fcRuns(40, 25) })
  })

  it('T-F3E-03: total never exceeds MAX_MATCHES and truncated is true exactly when something was cut', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 60 }), (rows, per) => {
        const w = world()
        const line = Array.from({ length: per }, () => 'xyz').join(' ')
        w.edit(0, [Array.from({ length: rows }, () => line)])
        const r = w.index.query({ text: 'xyz', matchCase: false, wholeWord: false, regex: false, scope: { kind: 'all' } })
        const all = rows * per
        expect(r.total).toBe(Math.min(all, MAX_MATCHES))
        expect(r.truncated).toBe(all > MAX_MATCHES)
        expect(r.pages.reduce((n, p) => n + p.matches.length, 0)).toBe(r.total)
      }),
      { ...fcParams, ...fcRuns(40, 30) },
    )
  })

  // Regex patterns come only from the linear grammar: FX-1 owns the rest.
  const linearPatterns = ['a+', '[a-c]{2}', 'ab|cd', '\\w+', '(', '(?', '\\', '日.', '^abc$', 'x{2,3}', '[', 'a*?']
  const anyQuery = fc.record({
    text: fc.oneof(text, phrase, fc.constantFrom(...linearPatterns), fc.string({ maxLength: 8 })),
    matchCase: fc.boolean(),
    wholeWord: fc.boolean(),
    regex: fc.boolean(),
    scope: fc.oneof(
      fc.constant({ kind: 'all' as const }),
      fc.record({ kind: fc.constantFrom('section' as const, 'notebook' as const), id: fc.oneof(fc.constantFrom('nb1', 's1'), fc.string({ maxLength: 6 })) }),
    ),
  })
  const mess = fc.oneof(anyQuery, fc.anything(), fc.record({ text: fc.string({ maxLength: 5 }), matchCase: fc.anything(), wholeWord: fc.anything(), regex: fc.anything(), scope: fc.anything() }))

  it('T-F3E-04: any value isSearchQuery accepts, query handles without throwing', () => {
    const w = world()
    w.edit(0, [['abc ABC 日本語 a+b (x) "q"', 'xx xxx aab']])
    w.index.flush()
    let accepted = 0
    fc.assert(
      fc.property(mess, (v) => {
        if (!isSearchQuery(v)) return
        if (v.text.includes('\u0000')) return // F3E-1
        accepted++
        // A regex query is run only when its text is from the linear grammar (FX-1 owns the rest).
        const q = v.regex && !linearPatterns.includes(v.text) ? { ...v, regex: false } : v
        const r = w.index.query(q)
        expect(r.total).toBeLessThanOrEqual(MAX_MATCHES)
        expect(r.total).toBe(r.pages.reduce((n, p) => n + p.matches.length, 0))
      }),
      { ...fcParams, ...fcRuns(2, 200) },
    )
    expect(accepted).toBeGreaterThan(0)
  })
})

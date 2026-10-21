import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import { PageDoc } from '@slate/core'
import { schema } from '../src/extensions'
import { writeContent } from '../src/content'
import { compileQuery, findHighlightPlugin, findInDoc, findInPage, findMatches, findStore, type FindOptions } from '../src/find'

const plain: FindOptions = { matchCase: false, wholeWord: false, regex: false }

describe('findMatches', () => {
  it('is case-insensitive by default and honours Match Case', () => {
    expect(findMatches('Foo foo FOO', 'foo', plain)).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ])
    expect(findMatches('Foo foo FOO', 'foo', { ...plain, matchCase: true })).toEqual([[4, 7]])
  })

  it('matches substrings unless Match Whole Word is on', () => {
    expect(findMatches('Foo foo food', 'foo', plain)).toHaveLength(3)
    expect(findMatches('Foo foo food', 'foo', { ...plain, wholeWord: true })).toEqual([
      [0, 3],
      [4, 7],
    ])
  })

  it('treats underscores, digits and non-ASCII letters as word characters', () => {
    const ww = { ...plain, wholeWord: true }
    expect(findMatches('foo_bar foo1 éfoo foo', 'foo', ww)).toEqual([[18, 21]])
    expect(findMatches('(foo).foo-foo', 'foo', ww)).toHaveLength(3)
  })

  it('escapes regex characters when regex is off', () => {
    expect(findMatches('a.b axb (a.b)', 'a.b', plain)).toEqual([
      [0, 3],
      [9, 12],
    ])
    expect(findMatches('cost $5 [x]', '$5 [x]', plain)).toEqual([[5, 11]])
  })

  it('supports regular expressions with groups', () => {
    expect(findMatches('food fod fooood fd', 'fo+d', { ...plain, regex: true })).toEqual([
      [0, 4],
      [5, 8],
      [9, 15],
    ])
    expect(findMatches('ab abab', '(ab)+', { ...plain, regex: true })).toEqual([
      [0, 2],
      [3, 7],
    ])
  })

  it('skips zero-length regex matches without looping forever', () => {
    expect(findMatches('abc', 'x*', { ...plain, regex: true })).toEqual([])
    expect(findMatches('abc', '^', { ...plain, regex: true })).toEqual([])
    expect(findMatches('aXbX', 'X*', { ...plain, regex: true })).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('returns nothing for an empty query or an invalid regex, without throwing', () => {
    expect(findMatches('abc', '', plain)).toEqual([])
    expect(findMatches('abc', '(', { ...plain, regex: true })).toEqual([])
    expect(compileQuery('(', { ...plain, regex: true })).toBeNull()
    expect(compileQuery('(', plain)).not.toBeNull()
  })

  it('handles astral characters', () => {
    expect(findMatches('😀foo', 'foo', { ...plain, wholeWord: true })).toEqual([[2, 5]])
  })
})

const doc = (json: object) => schema.nodeFromJSON({ type: 'doc', content: json })
const p = (...content: object[]) => ({ type: 'paragraph', content })
const t = (s: string, marks?: string[]) => ({ type: 'text', text: s, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) })

describe('findInDoc', () => {
  it('maps matches to ProseMirror positions, across marks', () => {
    const d = doc([p(t('fo'), t('o', ['bold']), t('d foo'))])
    const ranges = findInDoc(d, 'foo', plain)
    expect(ranges).toEqual([
      { from: 1, to: 4 },
      { from: 6, to: 9 },
    ])
    expect(d.textBetween(6, 9)).toBe('foo')
  })

  it('does not match across block boundaries and finds text in nested blocks', () => {
    const d = doc([
      p(t('ab')),
      p(t('cd')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('xcd'))] }] },
      { type: 'codeBlock', content: [t('cd()')] },
    ])
    expect(findInDoc(d, 'bc', plain)).toEqual([])
    const ranges = findInDoc(d, 'cd', plain)
    expect(ranges.map((r) => d.textBetween(r.from, r.to))).toEqual(['cd', 'cd', 'cd'])
  })

  it('counts a hard break as a character so later positions stay right', () => {
    const d = doc([p(t('a'), { type: 'hardBreak' }, t('foo'))])
    const [r] = findInDoc(d, 'foo', plain)
    expect(d.textBetween(r.from, r.to)).toBe('foo')
  })
})

describe('findInPage', () => {
  it('searches every box, private ones too, in reading order', () => {
    const page = new PageDoc()
    const add = (x: number, y: number, s: string) => {
      const id = page.addBox({ x, y, width: 100 })
      writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: s }] }], page.doc)
      page.doc.commit()
      return id
    }
    const c = add(0, 300, 'foo three')
    const b = add(200, 0, 'foo two')
    const a = add(0, 0, 'foo one')
    page.updateBox(c, { private: true })
    const matches = findInPage(page, schema, 'foo', plain)
    expect(matches.map((m) => m.boxId)).toEqual([a, b, c])
  })
})

describe('findHighlightPlugin', () => {
  it('decorates only while the store has matches for its box, never touching the doc', () => {
    const d = doc([p(t('foo foo'))])
    let state = EditorState.create({ doc: d, plugins: [findHighlightPlugin('b1')] })
    const decos = () => findHighlightPlugin.decorations(state).find()
    expect(decos()).toHaveLength(0)
    findStore.setMatches([
      { boxId: 'b1', from: 1, to: 4 },
      { boxId: 'b1', from: 5, to: 8 },
    ], 1)
    state = state.apply(state.tr.setMeta(findHighlightPlugin.key, true))
    expect(decos().map((x) => x.spec.current)).toEqual([false, true])
    expect(state.doc.eq(d)).toBe(true)
    findStore.setMatches([], -1)
    state = state.apply(state.tr.setMeta(findHighlightPlugin.key, true))
    expect(decos()).toHaveLength(0)
  })

  it('picks up its matches once an editor that started empty is filled', () => {
    findStore.setMatches([{ boxId: 'b2', from: 1, to: 4 }], 0)
    let state = EditorState.create({ schema, plugins: [findHighlightPlugin('b2')] })
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, doc([p(t('foo'))]).content))
    expect(findHighlightPlugin.decorations(state).find()).toHaveLength(1)
    findStore.setMatches([], -1)
  })
})

import { describe, expect, it } from 'vitest'
import { contentToJSON, writeContent } from '../src/content'
import { compileQuery, type FindOptions } from '../src/find'
import { PageDoc } from '../src/page'
import type { PMJSON } from '../src/plaintext'
import { expandReplacement, preserveCaseOf, replaceInPage } from '../src/replace'

const plain: FindOptions = { matchCase: false, wholeWord: false, regex: false }
const regex: FindOptions = { matchCase: true, wholeWord: false, regex: true }

function pageWith(...boxes: PMJSON[][]): { page: PageDoc; ids: string[] } {
  const page = new PageDoc()
  const ids = boxes.map((blocks, i) => {
    const id = page.addBox({ x: 0, y: i * 100, width: 400 })
    writeContent(page.contentMap(id)!, blocks, page.doc)
    page.doc.commit()
    return id
  })
  return { page, ids }
}

const para = (...content: PMJSON[]): PMJSON => ({ type: 'paragraph', content })
const text = (t: string, ...marks: string[]): PMJSON => ({ type: 'text', text: t, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) })
const boxJSON = (page: PageDoc, id: string) => contentToJSON(page.contentMap(id)!)

describe('preserveCaseOf', () => {
  it('keeps all caps, Capitalised and lower', () => {
    expect(preserveCaseOf('CAT', 'dog')).toBe('DOG')
    expect(preserveCaseOf('Cat', 'dog')).toBe('Dog')
    expect(preserveCaseOf('cat', 'Dog')).toBe('dog')
  })

  it('leaves the replacement alone when the match has no case pattern', () => {
    expect(preserveCaseOf('123', 'Dog')).toBe('Dog')
    expect(preserveCaseOf('cAT', 'dog')).toBe('dog')
    expect(preserveCaseOf('Cat', '')).toBe('')
  })
})

describe('expandReplacement', () => {
  it('fills $1…$9 and $& from a regex match, and $$ is a dollar', () => {
    const re = compileQuery('(\\w+)@(\\w+)', regex)!
    const s = 'mail ann@site now'
    expect(expandReplacement(s, 5, 13, re, '$2 at $1 ($&) $$5', regex, false)).toBe('site at ann (ann@site) $5')
  })

  it('keeps a $n past the last group as typed', () => {
    const re = compileQuery('(a)', regex)!
    expect(expandReplacement('a', 0, 1, re, '$1$2', regex, false)).toBe('a$2')
  })

  it('is literal when the query is not a regex', () => {
    const re = compileQuery('cat', plain)!
    expect(expandReplacement('a cat', 2, 5, re, '$1 $&', plain, false)).toBe('$1 $&')
  })

  it('applies Preserve Case after expanding', () => {
    const re = compileQuery('cat', plain)!
    expect(expandReplacement('A CAT', 2, 5, re, 'dog', plain, true)).toBe('DOG')
  })
})

describe('replaceInPage', () => {
  it('replaces every match in every box and counts them', () => {
    const { page, ids } = pageWith([para(text('cat and Cat'))], [para(text('no match')), para(text('cat'))])
    expect(replaceInPage(page, 'cat', plain, 'dog', { preserveCase: true })).toBe(3)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('dog and Dog'))])
    expect(boxJSON(page, ids[1]!)!.content).toEqual([para(text('no match')), para(text('dog'))])
  })

  it('replaces only the picked occurrences, counted per box as the find bar does', () => {
    const { page, ids } = pageWith([para(text('a1 a2')), para(text('a3'))], [para(text('a4'))])
    const only = (boxId: string, occurrence: number) => (boxId === ids[0] && occurrence === 2) || (boxId === ids[1] && occurrence === 0)
    expect(replaceInPage(page, 'a', plain, 'b', { preserveCase: false, only })).toBe(2)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('a1 a2')), para(text('b3'))])
    expect(boxJSON(page, ids[1]!)!.content).toEqual([para(text('b4'))])
  })

  it('gives the replacement the marks of the first character of the match', () => {
    const { page, ids } = pageWith([para(text('x '), text('bo', 'bold'), text('ld', 'italic'), text(' y'))])
    replaceInPage(page, 'bold', plain, 'strong', { preserveCase: false })
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('x '), { type: 'text', text: 'strong', marks: [{ type: 'bold', attrs: {} }] }, text(' y'))])
  })

  it('does not let a mark before the match spread over an unmarked replacement', () => {
    const { page, ids } = pageWith([para(text('ab', 'bold'), text('cd'))])
    replaceInPage(page, 'cd', plain, 'XY', { preserveCase: false })
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para({ type: 'text', text: 'ab', marks: [{ type: 'bold', attrs: {} }] }, text('XY'))])
  })

  it('expands regex groups per match', () => {
    const { page, ids } = pageWith([para(text('2026-10-30 and 2025-01-02'))])
    expect(replaceInPage(page, '(\\d+)-(\\d+)-(\\d+)', regex, '$3/$2/$1', { preserveCase: false })).toBe(2)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('30/10/2026 and 02/01/2025'))])
  })

  it('counts a match across a hard break as an occurrence but never replaces it', () => {
    const { page, ids } = pageWith([para(text('ab'), { type: 'hardBreak' }, text('ab'))])
    const only = (_: string, occurrence: number) => occurrence === 1
    expect(replaceInPage(page, 'b.a', regex, 'X', { preserveCase: false })).toBe(0)
    expect(replaceInPage(page, 'ab', plain, 'X', { preserveCase: false, only })).toBe(1)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('ab'), { type: 'hardBreak' }, text('X'))])
  })

  it('handles text before an emoji (UTF-16 offsets)', () => {
    const { page, ids } = pageWith([para(text('😀 cat 😀 cat'))])
    replaceInPage(page, 'cat', plain, 'dog', { preserveCase: false })
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('😀 dog 😀 dog'))])
  })

  it('replaces nothing for an empty or invalid query, and an empty replacement deletes', () => {
    const { page, ids } = pageWith([para(text('a(b'))])
    expect(replaceInPage(page, '', plain, 'x', { preserveCase: false })).toBe(0)
    expect(replaceInPage(page, '(', regex, 'x', { preserveCase: false })).toBe(0)
    expect(replaceInPage(page, '(', plain, '', { preserveCase: false })).toBe(1)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('ab'))])
  })

  it('honours whole word', () => {
    const { page, ids } = pageWith([para(text('cat cats'))])
    replaceInPage(page, 'cat', { ...plain, wholeWord: true }, 'dog', { preserveCase: false })
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('dog cats'))])
  })

  it('searches table cells and list items like any other block', () => {
    const cell = (t: string): PMJSON => ({ type: 'tableCell', content: [para(text(t))] })
    const { page, ids } = pageWith([
      { type: 'table', content: [{ type: 'tableRow', content: [cell('cat'), cell('a cat')] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('cat'))] }] },
    ])
    expect(replaceInPage(page, 'cat', plain, 'dog', { preserveCase: false })).toBe(3)
    expect(JSON.stringify(boxJSON(page, ids[0]!))).not.toContain('cat')
  })

  it('leaves the edit uncommitted so the caller picks the origin', () => {
    const { page } = pageWith([para(text('cat'))])
    const origins: Array<string | undefined> = []
    page.doc.subscribe((e) => origins.push(e.origin))
    replaceInPage(page, 'cat', plain, 'dog', { preserveCase: false })
    expect(origins).toEqual([])
    page.doc.commit({ origin: 'mine' })
    expect(origins).toEqual(['mine'])
  })
})

describe('replaceInPage with characters outside the BMP', () => {
  it('replaces a match that starts with an emoji, keeping its marks', () => {
    const { page, ids } = pageWith([para(text('hi '), text('😀 there', 'bold'))])
    expect(replaceInPage(page, '😀', plain, ':)', { preserveCase: false })).toBe(1)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('hi '), { type: 'text', text: ':) there', marks: [{ type: 'bold', attrs: {} }] })])
  })

  it('replaces a regex across boxes when a later match starts with an emoji', () => {
    const { page, ids } = pageWith([para(text('cat'))], [para(text('hi 😀'))])
    expect(replaceInPage(page, 'cat|😀', regex, 'X', { preserveCase: false })).toBe(2)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('X'))])
    expect(boxJSON(page, ids[1]!)!.content).toEqual([para(text('hi X'))])
  })

  it('writes nothing when planning fails part way', () => {
    const { page, ids } = pageWith([para(text('cat'))], [para(text('cat'))])
    const only = (boxId: string) => {
      if (boxId === ids[1]) throw new Error('boom')
      return true
    }
    expect(() => replaceInPage(page, 'cat', plain, 'dog', { preserveCase: false, only })).toThrow('boom')
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('cat'))])
  })

  it('passes each match’s text to `only`, so a caller can skip a pick that no longer matches', () => {
    const { page, ids } = pageWith([para(text('Cat cat'))])
    expect(replaceInPage(page, 'cat', plain, 'dog', { preserveCase: false, only: (_, __, matched) => matched === 'cat' })).toBe(1)
    expect(boxJSON(page, ids[0]!)!.content).toEqual([para(text('Cat dog'))])
  })
})

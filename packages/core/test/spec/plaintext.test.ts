// @product-rule copy-as-plain-text (CLAUDE.md, Product rules). A guarded spec: its expectations only grow, and only the maintainer changes the rule.
import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../../src/plaintext'

const t = (text: string): PMJSON => ({ type: 'text', text })
const p = (text: string): PMJSON => ({ type: 'paragraph', content: text ? [t(text)] : [] })
const li = (...content: PMJSON[]): PMJSON => ({ type: 'listItem', content })
const ol = (items: PMJSON[], start = 1): PMJSON => ({ type: 'orderedList', attrs: { start }, content: items })
const ul = (items: PMJSON[]): PMJSON => ({ type: 'bulletList', content: items })

describe('toPlainText', () => {
  it('joins blocks with a single LF', () => {
    expect(toPlainText([p('one'), { type: 'heading', attrs: { level: 1 }, content: [t('two')] }])).toBe('one\ntwo')
  })

  it('numbers ordered lists with real numbers and indents nested lists by 2 spaces', () => {
    const doc = [ol([li(p('one')), li(p('two'), ul([li(p('a')), li(p('b'))])), li(p('three'))])]
    expect(toPlainText(doc)).toBe('1. one\n2. two\n  - a\n  - b\n3. three')
  })

  it('honours the ordered list start attribute', () => {
    expect(toPlainText([ol([li(p('x')), li(p('y'))], 5)])).toBe('5. x\n6. y')
  })

  it('numbers nested ordered lists independently', () => {
    expect(toPlainText([ol([li(p('a'), ol([li(p('b')), li(p('c'))]))])])).toBe('1. a\n  1. b\n  2. c')
  })

  it('copies code blocks verbatim, only normalising CRLF', () => {
    const code: PMJSON = { type: 'codeBlock', attrs: { language: 'js' }, content: [t('if (a) {\r\n    b()\r\n}')] }
    expect(toPlainText([code])).toBe('if (a) {\n    b()\n}')
  })

  it('replaces NBSP and strips zero-width characters in text', () => {
    expect(toPlainText([p('a\u00A0b\u200Bc\uFEFFd\u2060')])).toBe('a bcd')
  })

  it('turns hard breaks into LF and normalises CRLF', () => {
    expect(toPlainText([{ type: 'paragraph', content: [t('a\r\nb'), { type: 'hardBreak' }, t('c')] }])).toBe('a\nb\nc')
  })

  it('tab-separates table cells, one row per line', () => {
    const cell = (s: string): PMJSON => ({ type: 'tableCell', content: [p(s)] })
    const table: PMJSON = { type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }, { type: 'tableRow', content: [cell('c'), cell('d')] }] }
    expect(toPlainText([table])).toBe('a\tb\nc\td')
  })

  it('prefixes blockquote lines and renders horizontal rules', () => {
    expect(toPlainText([{ type: 'blockquote', content: [p('q1'), p('q2')] }, { type: 'horizontalRule' }])).toBe('> q1\n> q2\n---')
  })

  it('handles bare inline nodes from partial selections', () => {
    expect(toPlainText([t('hi '), t('there')])).toBe('hi there')
  })

  it('trims trailing newlines so a terminal paste never auto-runs', () => {
    expect(toPlainText([p('ls -la'), p(''), p('')])).toBe('ls -la')
  })

  it('skips images', () => {
    expect(toPlainText([p('a'), { type: 'image', attrs: { src: 'slate-blob://blob/x.png' } }, p('b')])).toBe('a\nb')
  })

  it('writes letter and roman markers for styled numbered lists', () => {
    const items = [li(p('a')), li(p('b')), li(p('c')), li(p('d'))]
    const styled = (listStyle: string, start = 1): PMJSON => ({ type: 'orderedList', attrs: { start, listStyle }, content: items })
    expect(toPlainText([styled('lower-alpha')])).toBe('a. a\nb. b\nc. c\nd. d')
    expect(toPlainText([styled('upper-alpha')])).toBe('A. a\nB. b\nC. c\nD. d')
    expect(toPlainText([styled('lower-roman')])).toBe('i. a\nii. b\niii. c\niv. d')
    expect(toPlainText([styled('upper-roman', 8)])).toBe('VIII. a\nIX. b\nX. c\nXI. d')
    expect(toPlainText([styled('lower-alpha', 26)]).split('\n')[1]).toBe('aa. b')
    expect(toPlainText([styled('decimal')])).toBe('1. a\n2. b\n3. c\n4. d')
  })

  it('uses "- " for every bullet style', () => {
    for (const listStyle of ['disc', 'circle', 'square']) {
      expect(toPlainText([{ type: 'bulletList', attrs: { listStyle }, content: [li(p('x'))] }])).toBe('- x')
    }
  })
})

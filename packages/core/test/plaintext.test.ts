import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../src/plaintext'

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
    expect(toPlainText([p('a b​c﻿d⁠')])).toBe('a bcd')
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
})

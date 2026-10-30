import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../src/plaintext'

const t = (text: string): PMJSON => ({ type: 'text', text })
const p = (text: string): PMJSON => ({ type: 'paragraph', content: text ? [t(text)] : [] })
const todo = (checked: boolean, ...content: PMJSON[]): PMJSON => ({ type: 'listItem', attrs: { checked }, content })
const ul = (items: PMJSON[]): PMJSON => ({ type: 'bulletList', content: items })

describe('toPlainText: to-do lists (phase 15)', () => {
  it('writes `- [ ]` and `- [x]` and nests by 2 spaces', () => {
    const doc = [ul([todo(false, p('milk')), todo(true, p('eggs'), ul([todo(true, p('brown')), todo(false, p('white'))]))])]
    expect(toPlainText(doc)).toBe('- [ ] milk\n- [x] eggs\n  - [x] brown\n  - [ ] white')
  })

  it('an empty to-do keeps its box (with the space a Markdown task needs); a plain bullet beside it has none', () => {
    expect(toPlainText([ul([todo(false, p('')), { type: 'listItem', content: [p('plain')] }])])).toBe('- [ ] \n- plain')
  })

  it('keeps sub- and superscript characters as they are', () => {
    const run = (text: string, verticalAlign: string): PMJSON => ({ type: 'text', text, marks: [{ type: 'textStyle', attrs: { verticalAlign } }] })
    expect(toPlainText([{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [t('H'), run('2', 'sub'), t('O x'), run('2', 'super')] }])).toBe('H2O x2')
  })
})

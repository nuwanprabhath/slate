import { describe, expect, it } from 'vitest'
import { markdownToBlocks, toMarkdown } from '../src/markdown'
import type { PMJSON } from '../src/plaintext'

const t = (text: string, marks?: PMJSON['marks']): PMJSON => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content: PMJSON[]): PMJSON => ({ type: 'paragraph', content })
const li = (...content: PMJSON[]): PMJSON => ({ type: 'listItem', content })

describe('toMarkdown', () => {
  it('renders headings, paragraphs and inline marks', () => {
    const doc = [
      { type: 'heading', attrs: { level: 2 }, content: [t('Deploy')] },
      p(t('run '), t('kubectl', [{ type: 'code' }]), t(' and '), t('check', [{ type: 'bold' }]), t(' '), t('logs', [{ type: 'italic' }])),
      p(t('docs', [{ type: 'link', attrs: { href: 'https://x.dev' } }]), t(' '), t('old', [{ type: 'strike' }])),
    ]
    expect(toMarkdown(doc)).toBe('## Deploy\n\nrun `kubectl` and **check** _logs_\n\n[docs](https://x.dev) ~~old~~')
  })

  it('renders nested lists with real numbers', () => {
    const doc = [{ type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('a')), { type: 'bulletList', content: [li(p(t('b')))] }), li(p(t('c')))] }]
    expect(toMarkdown(doc)).toBe('3. a\n   - b\n4. c')
  })

  it('fences code blocks with their language', () => {
    expect(toMarkdown([{ type: 'codeBlock', attrs: { language: 'sh' }, content: [t('ls -la')] }])).toBe('```sh\nls -la\n```')
  })

  it('renders tables as GFM with the first row as header', () => {
    const cell = (s: string): PMJSON => ({ type: 'tableCell', content: [p(t(s))] })
    const table = { type: 'table', content: [{ type: 'tableRow', content: [cell('k'), cell('v')] }, { type: 'tableRow', content: [cell('a'), cell('1')] }] }
    expect(toMarkdown([table])).toBe('| k | v |\n| --- | --- |\n| a | 1 |')
  })

  it('renders images and rules', () => {
    expect(toMarkdown([{ type: 'image', attrs: { src: 'slate-blob://blob/x.png' } }, { type: 'horizontalRule' }])).toBe('![](slate-blob://blob/x.png)\n\n---')
  })
})

describe('markdownToBlocks', () => {
  it('parses headings, paragraphs, lists and fenced code', () => {
    const md = '# Title\n\nfirst line\nsecond line\n\n- a\n- b\n\n2. x\n3. y\n\n```sh\nls -la\n  echo hi\n```'
    expect(markdownToBlocks(md)).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'first line' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second line' }] },
      { type: 'bulletList', content: ['a', 'b'].map((s) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })) },
      { type: 'orderedList', attrs: { start: 2 }, content: ['x', 'y'].map((s) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })) },
      { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'ls -la\n  echo hi' }] },
    ])
  })

  it('returns an empty paragraph list for blank input', () => {
    expect(markdownToBlocks('  \n\n')).toEqual([])
  })
})

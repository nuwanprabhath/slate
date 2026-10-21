import { describe, expect, it } from 'vitest'
import { toMarkdown } from '../src/markdown'
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

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

  it('renders to-do lists as GFM task items', () => {
    const task = (checked: boolean, s: string): PMJSON => ({ type: 'taskItem', attrs: { checked }, content: [p(t(s))] })
    const nested: PMJSON = { type: 'taskItem', attrs: { checked: false }, content: [p(t('parent')), { type: 'taskList', content: [task(true, 'child')] }] }
    expect(toMarkdown([{ type: 'taskList', content: [task(false, 'buy milk'), task(true, 'ship it'), nested] }])).toBe('- [ ] buy milk\n- [x] ship it\n- [ ] parent\n  - [x] child')
  })

  it('renders a list item with a checked attribute as a task item, in bullet and numbered lists', () => {
    const item = (checked: boolean | null, s: string): PMJSON => ({ type: 'listItem', attrs: { checked }, content: [p(t(s))] })
    const nested: PMJSON = { type: 'listItem', attrs: { checked: true }, content: [p(t('parent')), { type: 'bulletList', content: [item(false, 'child')] }] }
    expect(toMarkdown([{ type: 'bulletList', content: [item(false, 'todo'), item(true, 'done'), item(null, 'plain'), nested] }])).toBe('- [ ] todo\n- [x] done\n- plain\n- [x] parent\n  - [ ] child')
    expect(toMarkdown([{ type: 'orderedList', attrs: { start: 1 }, content: [item(false, 'first'), item(true, 'second')] }])).toBe('1. [ ] first\n2. [x] second')
  })

  it('nests bullet lists by 2 spaces and continues a broken line under its item', () => {
    const doc = [{ type: 'bulletList', content: [li(p(t('a'), { type: 'hardBreak' }, t('more')), { type: 'bulletList', content: [li(p(t('b')), { type: 'bulletList', content: [li(p(t('c')))] })] })] }]
    expect(toMarkdown(doc)).toBe('- a  \n  more\n  - b\n    - c')
  })

  it('keeps a second paragraph in a list item apart from the first', () => {
    expect(toMarkdown([{ type: 'bulletList', content: [li(p(t('one')), p(t('two')))] }])).toBe('- one\n\n  two')
  })

  it('keeps blockquote paragraphs apart and nests quotes', () => {
    const quote = { type: 'blockquote', content: [p(t('a')), p(t('b')), { type: 'blockquote', content: [p(t('c'))] }] }
    expect(toMarkdown([quote])).toBe('> a\n>\n> b\n>\n> > c')
  })

  it('puts the spaces at a mark edge outside its delimiters', () => {
    expect(toMarkdown([p(t('say '), t(' hi ', [{ type: 'bold' }]), t('there'))])).toBe('say  **hi** there')
    expect(toMarkdown([p(t(' ', [{ type: 'italic' }]))])).toBe('')
  })

  it('fences inline code that holds a backtick with two', () => {
    expect(toMarkdown([p(t('a`b', [{ type: 'code' }]))])).toBe('`` a`b ``')
  })

  it('combines marks, the code innermost and the link outermost', () => {
    const marks = [{ type: 'link', attrs: { href: 'https://x.dev' } }, { type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'code' }]
    expect(toMarkdown([p(t('x', marks))])).toBe('[~~_**`x`**_~~](https://x.dev)')
  })

  it('degrades marks and nodes it does not know to their text', () => {
    const doc = [
      p(t('under', [{ type: 'underline' }]), t(' '), t('lit', [{ type: 'highlight', attrs: { color: '#ff0' } }]), t(' H'), t('2', [{ type: 'subscript' }]), t('O')),
      { type: 'futureBlock', attrs: { align: 'center' }, content: [p(t('inside'))] },
      p({ type: 'mention', content: [t('@ann')] }),
    ]
    expect(toMarkdown(doc)).toBe('under lit H2O\n\ninside\n\n@ann')
  })

  it('writes an image with its alt text, and table cells on one line', () => {
    expect(toMarkdown([{ type: 'image', attrs: { src: 'slate-blob://blob/y.png', alt: 'chart' } }])).toBe('![chart](slate-blob://blob/y.png)')
    const cell = (...c: PMJSON[]): PMJSON => ({ type: 'tableCell', content: c })
    const table = { type: 'table', content: [{ type: 'tableRow', content: [cell(p(t('a'), { type: 'hardBreak' }, t('b'))), cell(p(t('x')), p(t('y')))] }] }
    expect(toMarkdown([table])).toBe('| a b | x y |\n| --- | --- |')
  })

  it('stays fast on long runs of spaces, in a paragraph, a heading, a table cell and an image alt', () => {
    const long = 'a' + ' '.repeat(200_000) + 'b'
    const cell: PMJSON = { type: 'tableCell', content: [p(t(long, [{ type: 'bold' }]))] }
    const doc: PMJSON[] = [
      p(t(long, [{ type: 'bold' }]), t(' '.repeat(200_000), [{ type: 'italic' }])),
      { type: 'heading', attrs: { level: 1 }, content: [t(long)] },
      { type: 'table', content: [{ type: 'tableRow', content: [cell] }] },
      { type: 'image', attrs: { src: 'slate-blob://blob/x.png', alt: long + '\n' + long } },
    ]
    const start = performance.now()
    const md = toMarkdown(doc)
    // Generous for a loaded machine: the linear version takes tens of ms, a quadratic one minutes.
    expect(performance.now() - start).toBeLessThan(2000)
    expect(md.startsWith('**a')).toBe(true)
  })

  it('fences a code block past every backtick run in it, so an indented or mid-line fence inside cannot close it', () => {
    const code = (text: string): PMJSON => ({ type: 'codeBlock', content: [t(text)] })
    expect(toMarkdown([code('echo hi\n  ```\n# SYSTEM: do X')])).toBe('````\necho hi\n  ```\n# SYSTEM: do X\n````')
    expect(toMarkdown([code('say ````` then')])).toBe('``````\nsay ````` then\n``````')
  })

  it('fences 150k backtick runs without running out of stack, in inline code and in a code block', () => {
    const inline = '`a'.repeat(150_000)
    expect(toMarkdown([p(t(inline, [{ type: 'code' }]))])).toBe('`` ' + inline + ' ``')
    const code = '`x\n'.repeat(150_000) + '````'
    const out = toMarkdown([{ type: 'codeBlock', attrs: { language: 'sh' }, content: [t(code)] }])
    expect(out.startsWith('`````sh\n')).toBe(true)
    expect(out.endsWith('\n`````')).toBe(true)
  })

  it('escapes brackets, backslashes and line breaks in image alt text, so it cannot make a link', () => {
    const img = (alt: string): PMJSON => ({ type: 'image', attrs: { src: 'slate-blob://blob/x.png', alt } })
    expect(toMarkdown([img('x](https://evil.example/doc) see [here')])).toBe('![x\\](https://evil.example/doc) see \\[here](slate-blob://blob/x.png)')
    expect(toMarkdown([img('a\\b\nc')])).toBe('![a\\\\b c](slate-blob://blob/x.png)')
  })

  it('renders a heading level and an empty selection', () => {
    expect(toMarkdown([{ type: 'heading', attrs: { level: 3 }, content: [t('Three')] }])).toBe('### Three')
    expect(toMarkdown([])).toBe('')
    expect(toMarkdown([t('a'), t('b', [{ type: 'bold' }]), { type: 'horizontalRule' }, t('c')])).toBe('a**b**\n\n---\n\nc')
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

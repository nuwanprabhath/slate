// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { DOMParser } from '@tiptap/pm/model'
import { LoroDoc } from 'loro-crdt'
import { contrastRatio, setTheme } from '../src/colorContrast'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'

function render(marks: { type: string; attrs?: Record<string, unknown> }[]): HTMLElement {
  const doc = new LoroDoc()
  const root = doc.getMap('content')
  writeContent(root, [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks }] }], doc)
  doc.commit()
  const host = document.createElement('div')
  host.append(renderStaticHtml(schema, doc, root.id, document)!)
  return host
}

describe('rendering imported colours in the dark theme', () => {
  beforeEach(() => setTheme(true))
  it('shows the original colour in the light theme', () => {
    setTheme(false)
    const span = render([{ type: 'textStyle', attrs: { color: 'rgb(0,0,0)' } }]).querySelector('span')!
    expect(span.style.color.replace(/\s/g, '')).toBe('rgb(0,0,0)')
  })
  it('draws black text light, keeping the original in data-color', () => {
    const span = render([{ type: 'textStyle', attrs: { color: 'rgb(0,0,0)' } }]).querySelector('span')!
    expect(span.getAttribute('data-color')).toBe('rgb(0,0,0)')
    expect(contrastRatio(span.style.color, '#1e1e1e')).toBeGreaterThanOrEqual(3)
  })
  it('leaves red alone', () => {
    const span = render([{ type: 'textStyle', attrs: { color: 'rgb(255,0,0)' } }]).querySelector('span')!
    expect(span.style.color.replace(/\s/g, '')).toBe('rgb(255,0,0)')
  })
  it('darkens a light highlight so light text stays readable', () => {
    const mark = render([{ type: 'highlight', attrs: { color: '#ffffff' } }]).querySelector('mark')!
    expect(mark.getAttribute('data-color')).toBe('#ffffff')
    expect(contrastRatio('#e6e6e6', mark.style.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
  it('parses the original colour back from data-color', () => {
    const span = render([{ type: 'textStyle', attrs: { color: 'rgb(0,0,0)' } }]).querySelector('span')!
    const parsed = DOMParser.fromSchema(schema).parse(span.parentElement!.parentElement!)
    expect(JSON.stringify(parsed.toJSON())).toContain('"color":"rgb(0,0,0)"')
  })
})

describe('colours follow the applied theme', () => {
  it('adapts to the page background and text a theme sets, and notifies boxes', async () => {
    const { setThemeColors, currentTheme, onThemeChange } = await import('../src/colorContrast')
    let calls = 0
    const off = onThemeChange(() => calls++)
    setThemeColors({ background: '#f4ecd8ff', text: '#2b2418ff' })
    expect(calls).toBe(1)
    expect(currentTheme().dark).toBe(false)
    const black = render([{ type: 'textStyle', attrs: { color: 'rgb(0,0,0)' } }]).querySelector('span')!
    expect(black.style.color.replace(/\s/g, '')).toBe('rgb(0,0,0)')
    setThemeColors({ background: '#0b1020', text: '#e6e6e6' })
    expect(currentTheme().dark).toBe(true)
    const adapted = render([{ type: 'textStyle', attrs: { color: 'rgb(0,0,0)' } }]).querySelector('span')!
    expect(contrastRatio(adapted.style.color, '#0b1020')).toBeGreaterThanOrEqual(3)
    setThemeColors({ background: '#0b1020', text: '#e6e6e6' })
    expect(calls).toBe(2)
    off()
  })
})

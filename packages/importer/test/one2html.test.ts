import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapOneNotePage, normalizeOne2HtmlPage, parseOne2HtmlSection } from '../src'

const dir = join(__dirname, 'fixtures/one2html')
const page = readFileSync(join(dir, 'New Section 1/Test Page.html'), 'utf8')
const index = readFileSync(join(dir, 'New Section 1.html'), 'utf8')

const textOf = (node: unknown): string => JSON.stringify(node)

describe('normalizeOne2HtmlPage', () => {
  const mapped = mapOneNotePage(normalizeOne2HtmlPage(page))

  it('keeps the title and the box position and width', () => {
    expect(mapped.title).toBe('Test Page')
    const body = mapped.boxes.find((b) => textOf(b.blocks).includes('Lorem'))!
    expect(body.width).toBe(576)
    expect(body.x).toBe(48)
    // y is relative to the topmost box, which sits at the top margin
    expect(mapped.boxes[0]!.y).toBe(40)
  })

  it('drops the title block but keeps the body text, marks, lists and tables', () => {
    const all = textOf(mapped.boxes)
    expect(all).not.toContain('Tuesday, 27. October 2020')
    expect(all).toContain('ABCDEF')
    expect(all).toContain('"type":"heading"')
    expect(all).toContain('"type":"bold"')
    expect(all).toContain('"type":"italic"')
    expect(all).toContain('"type":"bulletList"')
    expect(all).toContain('"type":"orderedList"')
    expect(all).toContain('"type":"table"')
    expect(all).toContain('https://example.com')
  })

  it('turns tagged checkboxes into to-do text and removes tag icons', () => {
    const all = textOf(mapped.boxes)
    expect(all).toContain('"text":"☐ "')
    expect(all).toContain('"text":"☑ "')
    // Calibri is the page default, so a quoted "Calibri", sans-serif must not become a font mark.
    expect(all).not.toContain('sans-serif')
    expect(all).not.toContain('Unchecked')
  })

  it('keeps the image with its relative src', () => {
    expect(textOf(mapped.boxes)).toContain('"src":"testimages_screenshot.jpg"')
  })

  it('reports ink as lossy', () => {
    expect(mapped.lossy).toContain('Ink drawing (not imported)')
  })

  it('does not carry converter classes or scripts', () => {
    const out = normalizeOne2HtmlPage(page)
    expect(out).not.toContain('outline-element')
    expect(out).not.toContain('<script')
    expect(out).toContain('data-absolute-enabled="true"')
  })
})

describe('OneNote hyperlink field codes', () => {
  const pageWith = (inner: string) =>
    `<html><head><title>T</title></head><body><div class="container-outline" style="left: 48px; position: absolute; top: 24px; max-width: 600px;"><div class="outline-element"><span>${inner}</span></div></div></body></html>`

  it('turns a field-code hyperlink left in the text into a real link', () => {
    const md = textOf(mapOneNotePage(normalizeOne2HtmlPage(pageWith('rather than MCP﷟HYPERLINK "https://github.com/obra/Superpowers"Claude superpowers'))).boxes)
    expect(md).not.toContain('HYPERLINK')
    expect(md).not.toContain('﷟')
    expect(md).toContain('"text":"rather than MCP"')
    expect(md).toContain('{"type":"text","text":"Claude superpowers","marks":[{"type":"link","attrs":{"href":"https://github.com/obra/Superpowers"}}]}')
  })

  it('converts every field code on the page, in separate and in the same text runs', () => {
    const inner = 'a ﷟HYPERLINK "https://one.dev"One</span><span> b ﷟HYPERLINK "https://two.dev"Two﷟HYPERLINK "https://three.dev"Three'
    const md = textOf(mapOneNotePage(normalizeOne2HtmlPage(pageWith(inner))).boxes)
    expect(md).not.toContain('HYPERLINK')
    for (const [text, href] of [['One', 'https://one.dev'], ['Two', 'https://two.dev'], ['Three', 'https://three.dev']]) {
      expect(md).toContain(`{"type":"text","text":"${text}","marks":[{"type":"link","attrs":{"href":"${href}"}}]}`)
    }
  })

  it('handles a field code whose display text is empty by showing the URL', () => {
    const md = textOf(mapOneNotePage(normalizeOne2HtmlPage(pageWith('see ﷟HYPERLINK "https://x.dev/a"'))).boxes)
    expect(md).toContain('{"type":"text","text":"https://x.dev/a","marks":[{"type":"link","attrs":{"href":"https://x.dev/a"}}]}')
  })
})

describe('parseOne2HtmlSection', () => {
  it('lists pages in nav order with decoded files', () => {
    expect(parseOne2HtmlSection(index)).toEqual([{ title: 'Test Page', file: 'New Section 1/Test Page.html', level: 0 }])
  })

  it('uses the lN class for the level', () => {
    const html = '<nav><ul><li><a href="S/A%2Ehtml" class="l1" title="A">A</a></li><li><a href="S/B%2Ehtml" class="l2" title="B">B</a></li></ul></nav>'
    expect(parseOne2HtmlSection(html).map((p) => [p.title, p.level])).toEqual([['A', 0], ['B', 1]])
  })
})

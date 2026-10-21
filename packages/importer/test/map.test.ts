import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PMJSON } from '@slate/core'
import { mapOneNotePage } from '../src/map'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')

const text = (value: string, marks?: PMJSON['marks']): PMJSON => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const para = (...content: PMJSON[]): PMJSON => (content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' })

describe('mapOneNotePage', () => {
  it('maps positioned divs to boxes with the smallest y shifted to 40', () => {
    expect(mapOneNotePage(fixture('simple'))).toEqual({
      title: 'Deploy notes',
      boxes: [
        { x: 48, y: 40, width: 624, blocks: [para(text('First box line')), para(text('Second line'))] },
        { x: 700, y: 85, width: 300, blocks: [para(text('Right box'))] },
      ],
      lossy: [],
    })
  })

  it('maps inline formatting to marks and drops the body default font', () => {
    const page = mapOneNotePage(fixture('formatting'))
    expect(page.boxes).toEqual([
      {
        x: 48,
        y: 40,
        width: 500,
        blocks: [
          para(
            text('Bold', [{ type: 'bold' }]),
            text(' and '),
            text('span bold', [{ type: 'bold' }]),
            text(' then '),
            text('italic', [{ type: 'italic' }]),
            text(' '),
            text('under', [{ type: 'underline' }]),
          ),
          para(
            text('red', [{ type: 'textStyle', attrs: { color: '#FF0000' } }]),
            text(' '),
            text('mono', [{ type: 'textStyle', attrs: { fontFamily: 'Consolas', fontSize: '10pt' } }]),
            text(' '),
            text('marked', [{ type: 'highlight', attrs: { color: 'yellow' } }]),
          ),
          para(text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]), { type: 'hardBreak' }, text('after break')),
          para(text('☐ Buy milk')),
          para(text('☑ Done thing')),
          para(text('default font')),
        ],
      },
    ])
    expect(page.lossy).toEqual([])
  })

  it('maps lists, tables and Graph images', () => {
    const src = "https://graph.microsoft.com/v1.0/users('x')/onenote/resources/abc/$value"
    expect(mapOneNotePage(fixture('lists-tables')).boxes).toEqual([
      {
        x: 48,
        y: 40,
        width: 500,
        blocks: [
          {
            type: 'orderedList',
            attrs: { start: 3 },
            content: [
              {
                type: 'listItem',
                content: [
                  para(text('Three')),
                  { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('Nested bullet'))] }] },
                ],
              },
              { type: 'listItem', content: [para(text('Four'))] },
            ],
          },
          {
            type: 'table',
            content: [
              { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('Name'))] }, { type: 'tableHeader', content: [para(text('Role'))] }] },
              { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('Ann'))] }, { type: 'tableCell', content: [para(text('Dev'))] }] },
            ],
          },
          { type: 'image', attrs: { src, alt: 'diagram', width: 100, height: 50 } },
        ],
      },
    ])
  })

  it('merges monospace paragraphs into a code block and records lossy items', () => {
    const page = mapOneNotePage(fixture('code-and-lossy'))
    expect(page.boxes).toEqual([
      {
        x: 48,
        y: 40,
        width: 500,
        blocks: [
          { type: 'codeBlock', attrs: { language: 'plaintext' }, content: [text('line one\nline two\n  line three')] },
          para(text('After code')),
          para(text('[Attachment: report.pdf]')),
          para(text('https://www.youtube.com/watch?v=x', [{ type: 'link', attrs: { href: 'https://www.youtube.com/watch?v=x' } }])),
        ],
      },
      { x: 48, y: 120, width: 480, blocks: [para(text('Trailing loose paragraph'))] },
    ])
    expect(page.lossy).toEqual(['Attachment "report.pdf"', 'Embedded content (www.youtube.com)'])
  })

  it('keeps at most one empty paragraph in a row and strips zero-width characters', () => {
    const html =
      '<html><head><title> T </title></head><body data-absolute-enabled="true"><div style="position:absolute;left:10px;top:30px">' +
      '<p>a​b</p><p>&nbsp;</p><p></p><p>c</p></div></body></html>'
    const page = mapOneNotePage(html)
    expect(page.title).toBe('T')
    expect(page.boxes[0].blocks).toEqual([para(text('ab')), para(), para(text('c'))])
    expect(page.boxes[0].width).toBe(480)
  })

  it('converts pt sizes and flags external and ink images', () => {
    const html =
      '<html><head><title>T</title></head><body><div style="position:absolute;left:30pt;top:60pt;width:150pt">' +
      '<p><img src="https://example.com/a.png" alt="ext" /></p><p><img src="https://g/onenote/resources/i/$value" data-src-type="image/png" alt="Ink drawing" /></p>' +
      '<div data-ink="true"></div></div></body></html>'
    const page = mapOneNotePage(html)
    expect(page.boxes[0]).toMatchObject({ x: 40, y: 40, width: 200 })
    expect(page.lossy).toEqual(['External image', 'Ink drawing (imported as image)', 'Ink drawing (not imported)'])
  })

  it('keeps the displayed image size from max-width/max-height styles (one2html) or width/height', () => {
    const html = `<html><head><title>T</title></head><body data-absolute-enabled="true">
<div style="position:absolute;left:48px;top:40px;width:600px">
<img src="data:image/png;base64,AA" style="max-height: 74px; max-width: 357px;" />
<img src="data:image/png;base64,BB" style="width: 120px; height: 60px" />
<img src="data:image/png;base64,CC" />
</div></body></html>`
    const images = mapOneNotePage(html).boxes[0]!.blocks.filter((b) => b.type === 'image').map((b) => b.attrs)
    expect(images).toEqual([
      { src: 'data:image/png;base64,AA', alt: '', width: 357, height: 74 },
      { src: 'data:image/png;base64,BB', alt: '', width: 120, height: 60 },
      { src: 'data:image/png;base64,CC', alt: '' },
    ])
  })
})

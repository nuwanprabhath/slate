// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model'
import { cleanPastedHtml, storeDataImages } from '../src/clipboard'
import { schema } from '../src/extensions'
import { fcParams, fcRuns, fuzzTimeout, relativeCost } from '../../desktop/test/fuzz'
import { hostileHtml, unsafeMarkup } from '../../desktop/test/fuzzHtml'
import { replayCorpus } from '../../desktop/test/fuzzCorpus'

// T-F3B: the default paste path. cleanPastedHtml's own promise (what it keeps), then the whole path through the
// schema (what can run). happy-dom's parser is not Chromium's; F3f replays this corpus in the real browser.

const DROPPED = ['script', 'style', 'meta', 'link', 'title', 'font', 'span']
const KEEP_PASTE_ATTRS = new Set(['href', 'src', 'alt', 'start', 'colspan', 'rowspan'])
// Image src may be the blob store's address; links are http, https and mailto (TipTap's Link refuses the rest).
// The real scheme the blob store serves note images on (BLOB_SCHEME, src/main/blobs.ts).
const SCHEMES = ['http', 'https', 'mailto', 'slate-blob']

// happy-dom reports every parsed <iframe> it refuses to load on the original console, which vitest hands it
// before a test can spy on it; thousands of hostile inputs make over a megabyte, which overflows the Stop
// hook's spawnSync buffer. Only that line is dropped; the refusal itself is what we want.
beforeAll(() => {
  const write = process.stderr.write.bind(process.stderr)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) =>
    String(chunk).includes('Iframe page loading is disabled') ? true : write(chunk),
  )
})
afterAll(() => vi.restoreAllMocks())

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

/** Property 1: what survives cleanPastedHtml, read back by a parser. */
function cleanViolations(cleaned: string): string[] {
  const found: string[] = []
  for (const el of Array.from(parse(cleaned).body.querySelectorAll<HTMLElement>('*'))) {
    const tag = el.localName.toLowerCase()
    if (DROPPED.includes(tag)) found.push(`<${tag}>`)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (KEEP_PASTE_ATTRS.has(name)) continue
      if (tag === 'input' && (name === 'type' || name === 'checked')) continue
      if (tag === 'img' && name === 'width') continue
      if (name === 'style') {
        const props = attr.value.split(';').map((d) => d.split(':')[0]!.trim().toLowerCase()).filter(Boolean)
        if (props.every((p) => p === 'text-align' || p === 'margin-left')) continue
      }
      found.push(`<${tag} ${name}>`)
    }
  }
  return found
}

/** Property 3: the paste as it lands in a page, written out again as the editor draws it. */
function throughSchema(html: string): HTMLElement {
  const doc = PMDOMParser.fromSchema(schema).parse(parse(cleanPastedHtml(html)).body)
  const host = document.createElement('div')
  host.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document }))
  return host
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// FX-F3B-3 (not a Slate defect): happy-dom's HTMLSerializer reads `.content` from any element named `template`
// (html-serializer/HTMLSerializer.js, `tagName === 'template' ? root.content[nodeArray]`), but inside svg or math
// the parser makes a foreign-namespace element with no `.content`, so innerHTML throws a TypeError. The HTML
// serialisation algorithm special-cases only the HTML-namespace template, so a real DOM serialises it normally.
// Excluded here only because the test environment cannot serialise it; F3f's Chromium run covers it.
const pasteHtml = hostileHtml.filter((h) => !/<(svg|math)\b[\s\S]*<template/i.test(h))
describe('T-F3B clipboard corpus', () => {
  replayCorpus('editor', 'paste-html', (bytes) => {
    const cleaned = cleanPastedHtml(text(bytes))
    expect(cleanViolations(cleaned)).toEqual([])
    expect(cleanPastedHtml(cleaned)).toBe(cleaned)
    expect(unsafeMarkup(throughSchema(text(bytes)), SCHEMES)).toEqual([])
  })
})

describe('T-F3B cleanPastedHtml', () => {
  it('T-F3B-01: keeps no dropped element and no attribute outside the kept set', () => {
    fc.assert(
      fc.property(pasteHtml, (html) => {
        expect(cleanViolations(cleanPastedHtml(html))).toEqual([])
      }),
      fcParams,
    )
  }, fuzzTimeout(60_000))

  it('T-F3B-02: never throws, and cleaning its own output changes nothing', () => {
    fc.assert(
      fc.property(pasteHtml, (html) => {
        const once = cleanPastedHtml(html)
        expect(cleanPastedHtml(once)).toBe(once)
      }),
      fcParams,
    )
  }, fuzzTimeout(60_000))

  it('T-F3B-03: costs within a ratio of a plain paragraph of the same length', () => {
    const samples = fc.sample(pasteHtml, { numRuns: fcRuns(4, 200).numRuns, seed: fcParams.seed })
    const longest = Math.max(1, ...samples.map((s) => s.length))
    const plain = `<p>${'x'.repeat(longest)}</p>`
    const cost = relativeCost(() => cleanPastedHtml(plain), { calibrationRuns: 300, meanCeilingMs: 100, absoluteCeilingMs: 5_000 })
    for (const html of samples) cost.time(() => cleanPastedHtml(html))
    cost.check()
  }, fuzzTimeout(20_000))

  it('T-F3B-04: end to end through the schema, nothing that can run survives', () => {
    fc.assert(
      fc.property(pasteHtml, (html) => {
        expect(unsafeMarkup(throughSchema(html), SCHEMES)).toEqual([])
      }),
      fcRuns(2, 300),
    )
  }, fuzzTimeout(60_000))
})

const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const dataSrc = fc
  .tuple(
    fc.constantFrom(...PICTURE_TYPES, 'image/svg+xml', 'IMAGE/PNG', 'text/html', 'image/x-icon'),
    fc.constantFrom(';base64,', ',', ';charset=utf-8;base64,'),
    fc.oneof(fc.base64String({ maxLength: 40 }), fc.string({ maxLength: 20 }), fc.constantFrom('!!!', '====', 'a', 'ab=c', '\n QUJD \t')),
    fc.constantFrom('data:', 'DATA:', ' data:', '\tda\nta:', '&#100;ata:'),
  )
  .map(([mime, sep, body, scheme]) => `${scheme}${mime}${sep}${body}`)
const imagesHtml = fc
  .array(fc.oneof(dataSrc.map((src) => `<img src="${src.replace(/"/g, '')}">`), pasteHtml), { maxLength: 6 })
  .map((parts) => parts.join(''))

describe('T-F3B storeDataImages', () => {
  it('T-F3B-05: stores only the five picture types, leaves no data: src, never throws', async () => {
    await fc.assert(
      fc.asyncProperty(imagesHtml, async (html) => {
        const types: string[] = []
        const out = await storeDataImages(html, async (_bytes, mime) => {
          types.push(mime)
          return 'slate-blob://blob/x'
        })
        for (const t of types) expect(PICTURE_TYPES).toContain(t)
        for (const img of Array.from(parse(out).querySelectorAll('img'))) {
          // eslint-disable-next-line no-control-regex -- the URL parser strips exactly these
          const src = (img.getAttribute('src') ?? '').replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '')
          expect(src).not.toMatch(/^data:/i)
        }
      }),
      fcParams,
    )
  }, fuzzTimeout(60_000))
})

describe('T-F3B fixed findings', () => {
  it('FX-11: a pasted image whose src is not http, https, data or slate-blob is dropped', () => {
    for (const src of ['javascript:alert(1)', 'java&#9;script:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'relative.png']) {
      expect(cleanPastedHtml(`<p>a</p><img src="${src}"><p>b</p>`)).toBe('<p>a</p><p>b</p>')
    }
    for (const src of ['https://example.com/a.png', 'http://example.com/a.png', 'slate-blob://img/abc', 'data:image/png;base64,AAAA']) {
      expect(cleanPastedHtml(`<img src="${src}">`)).toBe(`<img src="${src}">`)
    }
  })

  it('FX-11: the Image node neither parses nor draws an unsafe src', () => {
    const img = schema.nodes.image!.create({ src: 'javascript:alert(1)' })
    const host = document.createElement('div')
    host.append(DOMSerializer.fromSchema(schema).serializeNode(img, { document }))
    expect(host.innerHTML).not.toContain('javascript')
    const parsed = PMDOMParser.fromSchema(schema).parse(parse('<img src="file:///x.png">').body)
    expect(JSON.stringify(parsed.toJSON())).not.toContain('file:')
  })

  it('FX-12: cleaning is idempotent for a cell outside a table', () => {
    const once = cleanPastedHtml('<table><td>cell')
    expect(once).toContain('cell')
    expect(cleanPastedHtml(once)).toBe(once)
  })

  it('FX-14: a 2,000-deep div paste lands with its text', () => {
    const deep = '<div>'.repeat(2000) + 'deep text' + '</div>'.repeat(2000)
    expect(throughSchema(deep).textContent).toContain('deep text')
  })
})

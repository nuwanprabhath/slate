// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model'
import { cleanPastedHtml, IMAGE_SCHEMES, isSafeImageSrc, MAX_PASTE_DEPTH, settlePaste, storeDataImages } from '../src/clipboard'
import { schema } from '../src/extensions'
import { fcParams, fcRuns, fuzzTimeout, relativeCost } from '../../desktop/test/fuzz'
import { LINK_SCHEMES, hostileHtml, unsafeMarkup } from '../../desktop/test/fuzzHtml'
import { replayCorpus } from '../../desktop/test/fuzzCorpus'

// T-F3B: the default paste path. cleanPastedHtml's own promise (what it keeps), then the whole path through the
// schema (what can run). happy-dom's parser is not Chromium's; F3f replays this corpus in the real browser.

const DROPPED = ['script', 'style', 'meta', 'link', 'title', 'font', 'span']
const KEEP_PASTE_ATTRS = new Set(['href', 'src', 'alt', 'start', 'colspan', 'rowspan'])
// Links are held to the kit's LINK_SCHEMES and pictures to the product's IMAGE_SCHEMES; neither list is restated here.
const unsafe = (out: ParentNode): string[] => unsafeMarkup(out, LINK_SCHEMES, IMAGE_SCHEMES)

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

// FX-42: happy-dom keeps every document its DOMParser makes (about 30 KB, more for a cleaned paste) until the event
// loop next turns; a full GC alone frees none of it. A synchronous property never turns the loop, so at soak depth
// (200,000 cases) the worker ran out of V8 heap. Every property here yields a macrotask every YIELD_EVERY cases,
// which bounds what is held to a few hundred documents whatever the depth.
//
// The turn alone does not free a document holding an element with a hyphen in its name (<annotation-xml>, <-->):
// happy-dom takes it for a custom element not yet defined and parks a callback bound to it in the window's registry
// (HTMLElement.js, connectedToDocument) until the element leaves its document, which a parsed document's never do.
// About 4% of hostile cases, a whole document each. The registry's list is emptied at every yield.
const YIELD_EVERY = 250
function forgetUndefinedCustomElements(): void {
  // happy-dom's PropertySymbol.callbacks, found by its description: the symbol itself is not part of its public API.
  const registry = window.customElements as unknown as Record<symbol, unknown>
  const key = Object.getOwnPropertySymbols(registry).find((symbol) => symbol.description === 'callbacks')
  const pending = key === undefined ? undefined : registry[key]
  if (pending instanceof Map) pending.clear()
}
const turnEventLoop = (): Promise<void> => {
  forgetUndefinedCustomElements()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A property over pasted HTML that lets happy-dom release its documents as it goes (FX-42). */
function releasing<T>(arb: fc.Arbitrary<T>, check: (value: T) => void | Promise<void>): fc.IAsyncProperty<[T]> {
  let run = 0
  return fc.asyncProperty(arb, async (value) => {
    await check(value)
    if (++run % YIELD_EVERY === 0) await turnEventLoop()
  })
}

setFlagsFromString('--expose_gc')
// The flag takes effect for new contexts; a fresh one hands over its `gc`.
const fullGc = runInNewContext('gc') as () => void

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
const foreignTemplate = (h: string): boolean => /<(svg|math)\b[\s\S]*<template/i.test(h)
const pasteHtml = hostileHtml.filter((h) => !foreignTemplate(h))
describe('T-F3B clipboard corpus', () => {
  replayCorpus('editor', 'paste-html', (bytes) => {
    const cleaned = cleanPastedHtml(text(bytes))
    expect(cleanViolations(cleaned)).toEqual([])
    expect(cleanPastedHtml(cleaned)).toBe(cleaned)
    expect(unsafe(throughSchema(text(bytes)))).toEqual([])
  })
})

describe('T-F3B cleanPastedHtml', () => {
  it('T-F3B-01: keeps no dropped element and no attribute outside the kept set', async () => {
    await fc.assert(
      releasing(pasteHtml, (html) => {
        expect(cleanViolations(cleanPastedHtml(html))).toEqual([])
      }),
      fcParams,
    )
  }, fuzzTimeout(60_000))

  it('T-F3B-02: never throws, and cleaning its own output changes nothing', async () => {
    await fc.assert(
      releasing(pasteHtml, (html) => {
        // Falling back to the text would make the second line true of anything, so the fallback is itself a failure.
        const { html: once, settled } = settlePaste(html)
        expect(settled).toBe(true)
        expect(cleanPastedHtml(once)).toBe(once)
      }),
      fcParams,
    )
  }, fuzzTimeout(60_000))

  it('T-F3B-03: costs within a ratio of a plain paragraph of the same length', async () => {
    const samples = fc.sample(pasteHtml, { numRuns: fcRuns(4, 200).numRuns, seed: fcParams.seed })
    const longest = Math.max(1, ...samples.map((s) => s.length))
    const plain = `<p>${'x'.repeat(longest)}</p>`
    const cost = relativeCost(() => cleanPastedHtml(plain), { calibrationRuns: 300, meanCeilingMs: 100, absoluteCeilingMs: 5_000 })
    // The loop turns between timings, never inside one (FX-42).
    for (const [i, html] of samples.entries()) {
      cost.time(() => cleanPastedHtml(html))
      if ((i + 1) % YIELD_EVERY === 0) await turnEventLoop()
    }
    cost.check()
  }, fuzzTimeout(20_000))

  it('T-F3B-04: end to end through the schema, nothing that can run survives', async () => {
    await fc.assert(
      releasing(pasteHtml, (html) => {
        expect(unsafe(throughSchema(html))).toEqual([])
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
  // FX-F3B-3 again: joining puts one part's <svg in front of another's <template, which no part holds alone
  // (seed 1, path "2409" of T-F3B-05). The same happy-dom serialiser fault, so the same exclusion.
  .filter((h) => !foreignTemplate(h))

describe('T-F3B storeDataImages', () => {
  it('T-F3B-05: stores only the five picture types, leaves no data: src, never throws', async () => {
    await fc.assert(
      releasing(imagesHtml, async (html) => {
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
  it('FX-11: a pasted image whose src is not http, https or slate-blob is dropped', () => {
    for (const src of ['javascript:alert(1)', 'java&#9;script:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'relative.png']) {
      expect(cleanPastedHtml(`<p>a</p><img src="${src}"><p>b</p>`)).toBe('<p>a</p><p>b</p>')
    }
    for (const src of ['https://example.com/a.png', 'http://example.com/a.png', 'slate-blob://img/abc']) {
      expect(cleanPastedHtml(`<img src="${src}">`)).toBe(`<img src="${src}">`)
    }
  })

  // storeDataImages runs before the cleaner (pasteHtml), so a data: src that reaches it was not stored: a spelling
  // TipTap's `:not([src^="data:"])` does not see would otherwise land in the page with its bytes.
  it('FX-41: a pasted image whose src is still a data: URL is dropped, in any spelling', () => {
    for (const src of ['data:', 'data:image/png;base64,AAAA', 'DATA:image/png;base64,AAAA', ' data:image/svg+xml,x', 'da&#9;ta:image/png;base64,AAAA']) {
      expect(cleanPastedHtml(`<p>a</p><img src="${src}"><p>b</p>`), src).toBe('<p>a</p><p>b</p>')
      expect(throughSchema(`<p>a</p><img src="${src}"><p>b</p>`).querySelector('img'), src).toBeNull()
    }
  })

  // The decision, pinned: the oracles follow IMAGE_SCHEMES, so a scheme added to it has to be added here on purpose.
  it('FX-41: a picture may be http, https or slate-blob, and nothing a link or a script may be', () => {
    expect([...IMAGE_SCHEMES].sort()).toEqual(['http', 'https', 'slate-blob'])
    for (const scheme of ['data', 'mailto', 'javascript', 'vbscript', 'file', 'blob', 'app', 'slate-image']) {
      expect(isSafeImageSrc(`${scheme}:x`), scheme).toBe(false)
    }
    const drawn = parse('<a href="mailto:a@example.com">x</a><img src="mailto:a@example.com"><img srcset="data:x 1x"><a href="slate-blob://img/abc">y</a>')
    expect(unsafe(drawn.body)).toEqual(['<img src="mailto:">', '<img srcset="data:">', '<a href="slate-blob:">'])
  })

  it('FX-41: the Image node neither parses nor draws a data: src', () => {
    const img = schema.nodes.image!.create({ src: 'DATA:image/png;base64,AAAA' })
    const host = document.createElement('div')
    host.append(DOMSerializer.fromSchema(schema).serializeNode(img, { document }))
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false)
    const parsed = PMDOMParser.fromSchema(schema).parse(parse('<img src=" data:image/png;base64,AAAA">').body)
    expect(JSON.stringify(parsed.toJSON())).not.toMatch(/data:/i)
  })

  it('FX-11: the Image node neither parses nor draws an unsafe src', () => {
    const img = schema.nodes.image!.create({ src: 'javascript:alert(1)' })
    const host = document.createElement('div')
    host.append(DOMSerializer.fromSchema(schema).serializeNode(img, { document }))
    expect(host.innerHTML).not.toContain('javascript')
    const parsed = PMDOMParser.fromSchema(schema).parse(parse('<img src="file:///x.png">').body)
    expect(JSON.stringify(parsed.toJSON())).not.toContain('file:')
  })

  // A synchronous property kept about 38 KB a case, so 200,000 soak cases ran the worker out of heap. Bytes, not
  // time: the bound is a twentieth of what one case kept, and a case that releases keeps none.
  it('FX-42: a paste property keeps nothing per case while it runs', async () => {
    const cases = 6_000
    let run = 0
    const heap: number[] = []
    // Read inside the property, at its middle and last case: what the whole run holds, not what is left after it.
    const check = (html: string): void => {
      cleanPastedHtml(cleanPastedHtml(html))
      if (++run !== cases / 2 && run !== cases) return
      fullGc()
      heap.push(process.memoryUsage().heapUsed)
    }
    await fc.assert(releasing(fc.constant('<p>a<b>b</b></p>'), check), { ...fcParams, numRuns: cases })
    expect(run).toBe(cases)
    const perCase = (heap[1]! - heap[0]!) / (cases / 2)
    expect(perCase).toBeLessThan(2_000)
  }, fuzzTimeout(60_000))

  // The same oracle for the documents the event loop does not free: one with a hyphenated element stayed whole
  // (about 30 KB), which only showed once every property here ran to soak depth in one worker.
  it('FX-42: a paste property keeps nothing per case for an element with a hyphen in its name', async () => {
    const cases = 6_000
    let run = 0
    const heap: number[] = []
    const check = (html: string): void => {
      cleanPastedHtml(html)
      if (++run !== cases / 2 && run !== cases) return
      fullGc()
      heap.push(process.memoryUsage().heapUsed)
    }
    await fc.assert(releasing(fc.constant('<annotation-xml><p>a</p></annotation-xml><-->b</-->'), check), { ...fcParams, numRuns: cases })
    expect(run).toBe(cases)
    const perCase = (heap[1]! - heap[0]!) / (cases / 2)
    expect(perCase).toBeLessThan(2_000)
  }, fuzzTimeout(60_000))

  it('FX-12: cleaning is idempotent for a cell outside a table', () => {
    const once = cleanPastedHtml('<table><td>cell')
    expect(once).toContain('cell')
    expect(cleanPastedHtml(once)).toBe(once)
  })

  // Seed 1, path "174276". Inside svg the parser makes `table` and `tr` in the SVG namespace, where tagName keeps its
  // case: a selector finds them, the uppercase table maps do not, and they are no part of any HTML table.
  it('FX-46: table-named elements inside svg are not table parts, and settling them never throws', () => {
    const found =
      "<svg is='\t&#x61;pp&#58;text/html,<script>alert(1)</script>' href=\u0000File&colon;alert(1) srcdoc=alert(1)><table></foreignObject><foreignObject xlink:href=\" h\nttps\n\n&colon;//user:pass@%2e%2e%2f%2e%2e%2f\" src=\"color: red; background: url(javascript:alert(1))\" width=><tr><img src='dAta%3a//evil.example@alert(1)'><iframe/></link>"
    expect(() => cleanPastedHtml(found)).not.toThrow()
    // The smallest of it: the svg `table` holds an element, which the lookup by its lowercase name missed.
    const once = cleanPastedHtml('<table><tr><td>cell</td></tr></table><svg><table><tr>x</tr></table></svg>')
    expect(once).toBe('<table><tbody><tr><td>cell</td></tr></tbody></table><svg><table><tr>x</tr></table></svg>')
    expect(cleanPastedHtml(once)).toBe(once)
  })

  // Seed 1, path "7418". The textarea and the `<<tr` are noise: what a second parse read differently was a link
  // inside a link, which a parser builds when a table foster-parents the inner one and never reads back.
  it('FX-47: a link the parser put inside a link is settled before the paste is returned', () => {
    const found =
      "<a onclick=\u0001&#x6a;avascript://user:pass@example.com/ onload=\" &#x6a;avascript&colon;abc123\" data='alert(1)'><textarea is='' class=\"alert(1)\"/><table></template><script id=\" mailto://evil.example@example.com/\" width=\u0000javascRipt&#58;//evil.example@abc123/><<tr formaction=\"alert(1)\"><a href='color: red; background: url(javascript:alert(1))' onload=javascript%3a%2e%2e%2f%2e%2e%2f></i>"
    const hostile = cleanPastedHtml(found)
    expect(cleanPastedHtml(hostile)).toBe(hostile)
    const nested = cleanPastedHtml('<a href="https://a.example/">one<table><a href="https://b.example/">two</a></table></a>')
    expect(cleanPastedHtml(nested)).toBe(nested)
    expect(parse(nested).querySelector('a a')).toBeNull()
    expect(parse(nested).body.textContent).toBe('onetwo')
  })

  // The same class, found by hand next to FX-47: an unwrap (span, font, the depth cap) leaves a child where no
  // parser lets it stand. Which of these a parser restructures differs between happy-dom and Chromium.
  it('FX-47: what an unwrap leaves where a parser would not is settled too', () => {
    const shapes = [
      '<p><span><div>x</div></span></p>',
      '<li><span><li>x</li></span></li>',
      '<h1><font><h1>x</h1></font></h1>',
      '<div>'.repeat(MAX_PASTE_DEPTH - 1) + '<table><tr><td>x</td></tr></table>',
    ]
    for (const html of shapes) {
      const once = cleanPastedHtml(html)
      expect(cleanPastedHtml(once), html).toBe(once)
      expect(parse(once).body.textContent, html).toBe('x')
    }
  })

  it('FX-47: a paste that never settles lands as its text', () => {
    const nested = '<a href="https://a.example/">one<table><a href="https://b.example/">two</a></table></a>'
    expect(settlePaste(nested).settled).toBe(true)
    // A single pass is never confirmed by a second, which stands in for an input that changes on every parse.
    const unsettled = settlePaste(`  ${nested}<p>a &amp; b &lt;i&gt;</p>`, 1)
    expect(unsettled).toEqual({ html: 'onetwoa &amp; b &lt;i&gt;', settled: false })
    expect(settlePaste(unsettled.html)).toEqual({ html: unsettled.html, settled: true })
  })

  // Found with FX-47: the wrapper stood between the table's parts, so settling moved it out, and the cells with it.
  it('FX-47: bold or italic set on a table, section or row goes into its cells, which stay in the table', () => {
    expect(cleanPastedHtml('<table><tbody><tr style="font-weight:bold"><td>x</td><th>h</th></tr><tr><td>y</td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td><strong>x</strong></td><th>h</th></tr><tr><td>y</td></tr></tbody></table>',
    )
    expect(cleanPastedHtml('<table style="font-style:italic"><tbody><tr><td>x<table><tbody><tr><td>in</td></tr></tbody></table></td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td><em>x<table><tbody><tr><td>in</td></tr></tbody></table></em></td></tr></tbody></table>',
    )
  })

  it('FX-14: a 2,000-deep div paste lands with its text', () => {
    const deep = '<div>'.repeat(2000) + 'deep text' + '</div>'.repeat(2000)
    expect(throughSchema(deep).textContent).toContain('deep text')
  })
})

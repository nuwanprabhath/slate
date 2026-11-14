// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { LoroDoc } from 'loro-crdt'
import type { PMJSON } from '@slate/core'
import { IMAGE_SCHEMES } from '../src/clipboard'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'
import { fcRuns, fuzzTimeout } from '../../desktop/test/fuzz'
import { LINK_SCHEMES, hostileUrl, unsafeMarkup } from '../../desktop/test/fuzzHtml'

// T-F3B: off-screen boxes are drawn from Loro without an editor, so a content map a hostile peer or an agent
// wrote goes straight to the page. Whatever it holds, the fragment carries nothing that can run.

// Links are held to the kit's LINK_SCHEMES and pictures to the product's IMAGE_SCHEMES; neither list is restated here.
const unsafe = (out: ParentNode): string[] => unsafeMarkup(out, LINK_SCHEMES, IMAGE_SCHEMES)
const NODE_TYPES = [...Object.keys(schema.nodes), 'script', 'iframe', 'svg', 'object', 'unknownNode']
const MARK_TYPES = [...Object.keys(schema.marks), 'script', 'unknownMark']
const ATTR_NAMES = ['href', 'src', 'onerror', 'onclick', 'style', 'class', 'srcdoc', 'width', 'color', 'target', 'rel', 'textAlign', 'indent', 'checked', 'language', 'x', 'y', 'level', 'start', 'colspan']
const attrValue = fc.oneof(hostileUrl, fc.constantFrom('alert(1)', '" onerror="alert(1)', 'color: red; background: url(javascript:alert(1))', '', null, 3, -1, true), fc.string({ maxLength: 8 }))
const attrs = fc.dictionary(fc.constantFrom(...ATTR_NAMES), attrValue, { maxKeys: 4 })

const textNode: fc.Arbitrary<PMJSON> = fc.record({
  type: fc.constant('text'),
  text: fc.oneof(fc.constantFrom('x', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>'), fc.string({ minLength: 1, maxLength: 6 })),
  marks: fc.array(fc.record({ type: fc.constantFrom(...MARK_TYPES), attrs }), { maxLength: 3 }),
}) as fc.Arbitrary<PMJSON>

const { node } = fc.letrec<{ node: PMJSON }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    textNode,
    fc.record({ type: fc.constantFrom(...NODE_TYPES), attrs, content: fc.array(tie('node'), { maxLength: 4 }) }) as fc.Arbitrary<PMJSON>,
  ),
}))

// Mostly content the schema accepts, with hostile attributes, so most cases reach the serialiser instead of
// being refused for shape.
const para = (type: string) => fc.record({ type: fc.constant(type), attrs, content: fc.array(textNode, { minLength: 1, maxLength: 3 }) }) as fc.Arbitrary<PMJSON>
const block: fc.Arbitrary<PMJSON> = fc.oneof(
  { weight: 3, arbitrary: para('paragraph') },
  para('heading'),
  para('codeBlock'),
  fc.record({ type: fc.constant('image'), attrs }) as fc.Arbitrary<PMJSON>,
  para('paragraph').map((p) => ({ type: 'blockquote', content: [p] }) as PMJSON),
  para('paragraph').map((p) => ({ type: 'bulletList', content: [{ type: 'listItem', content: [p] }] }) as PMJSON),
  node,
)


/** The fragment, or null when the content is empty; an error the schema raised means the box is not drawn. */
function render(content: PMJSON[]): HTMLElement | 'refused' | null {
  const doc = new LoroDoc()
  const root = doc.getMap('content')
  writeContent(root, content, doc)
  doc.commit()
  let fragment: DocumentFragment | null
  try {
    fragment = renderStaticHtml(schema, doc, root.id, document)
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    return 'refused'
  }
  if (!fragment) return null
  const host = document.createElement('div')
  host.append(fragment)
  return host
}

describe('T-F3B renderStaticHtml', () => {
  it('T-F3B-06: a hostile content map renders nothing that can run, or is refused', () => {
    let rendered = 0
    fc.assert(
      fc.property(fc.array(block, { maxLength: 5 }), (content) => {
        const out = render(content)
        if (out instanceof HTMLElement) rendered++
        const found = out instanceof HTMLElement ? unsafe(out) : []
        expect(found).toEqual([])
      }),
      fcRuns(4, 300),
    )
    // The harness is only worth something if most cases are drawn rather than refused.
    expect(rendered).toBeGreaterThan(fcRuns(4, 300).numRuns / 4)
  }, fuzzTimeout(60_000))

  it('T-F3B-07: a link mark with a hostile href is never drawn with that scheme', () => {
    fc.assert(
      fc.property(hostileUrl, (href) => {
        const out = render([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] }])
        expect(out instanceof HTMLElement ? unsafe(out) : []).toEqual([])
      }),
      fcRuns(4, 300),
    )
  }, fuzzTimeout(60_000))
})

describe('T-F3B fixed findings', () => {
  // The soak's counterexample was [ '<img src="data:">' ]: a content map a peer wrote, never a paste, since paste
  // stores an embedded picture first. A page holds a picture's address and never its bytes, so the src is not drawn.
  it('FX-41: a stored image whose src is a data: URL is drawn without it', () => {
    for (const src of ['data:', 'data:image/png;base64,AAAA', 'DATA:image/svg+xml,<svg onload=alert(1)>', ' da\tta:text/html,<script>alert(1)</script>']) {
      const out = render([{ type: 'image', attrs: { src } }])
      expect(out, src).toBeInstanceOf(HTMLElement)
      if (!(out instanceof HTMLElement)) continue
      expect(unsafe(out), src).toEqual([])
      expect(out.querySelector('img')?.hasAttribute('src'), src).toBe(false)
    }
  })

  it('FX-41: a stored image keeps an http, https or slate-blob src', () => {
    for (const src of ['https://example.com/a.png', 'http://example.com/a.png', 'slate-blob://img/abc']) {
      const out = render([{ type: 'image', attrs: { src } }])
      expect(out instanceof HTMLElement ? out.querySelector('img')?.getAttribute('src') : null).toBe(src)
    }
  })
})

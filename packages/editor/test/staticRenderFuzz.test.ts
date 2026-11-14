// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as loro from 'loro-crdt'
import { LoroDoc } from 'loro-crdt'
import type { PMJSON } from '@slate/core'
import { IMAGE_SCHEMES } from '../src/clipboard'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'
import { FUZZ_SEED, fcRuns, fuzzTimeout } from '../../desktop/test/fuzz'
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
  try {
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
  } finally {
    root.free()
    doc.free()
  }
}

/**
 * A run of cases must not be one job. Loro frees a document only when every handle read from it is gone, and the
 * handles a render reads (the content map, loro-prosemirror's children) go when Loro's FinalizationRegistry runs,
 * in a task of its own; happy-dom's `querySelectorAll` keeps its result in a WeakRef, which holds the drawn tree
 * until the job ends. A property that never yields therefore kept 32 kB of Loro heap and 40 kB of JavaScript heap
 * a case, and V8 pays for every growth of a WebAssembly memory by its size: 0.7 ms a growth at 126 MB, 6.6 ms at
 * 751 MB (FX-43). With a timer every 64 cases, Loro's heap is about 100 MB after 50,000 and a case costs the same
 * at the end as at the start.
 */
const CASES_PER_JOB = 64
let casesThisJob = 0
async function yieldToFinalizers(): Promise<void> {
  if (++casesThisJob < CASES_PER_JOB) return
  casesThisJob = 0
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One case, as both properties run it: what was drawn, and what in it could run. */
async function judged(content: PMJSON[]): Promise<{ drawn: boolean; found: string[] }> {
  const out = render(content)
  const drawn = out instanceof HTMLElement
  const found = drawn ? unsafe(out) : []
  await yieldToFinalizers()
  return { drawn, found }
}

const loroHeapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

/**
 * T-F3B-08's bound. A run that is one job grows Loro's heap by 32 kB a case (measured: 930 MB after 30,000). One
 * that yields leaves it at whatever waits for the next garbage collection: 52 to 58 MB once 4000 cases have settled
 * it, still creeping by 0.8 to 2.4 kB a case over the next 4000. 12 KiB is under half the first figure and five
 * times the second, and neither is a time, so machine load moves neither.
 */
const SETTLE_CASES = 4000
const MEASURED_CASES = 4000
const KEPT_BYTES_PER_CASE = 12 * 1024

describe('T-F3B renderStaticHtml', () => {
  it('T-F3B-06: a hostile content map renders nothing that can run, or is refused', async () => {
    let rendered = 0
    await fc.assert(
      fc.asyncProperty(fc.array(block, { maxLength: 5 }), async (content) => {
        const { drawn, found } = await judged(content)
        if (drawn) rendered++
        expect(found).toEqual([])
      }),
      fcRuns(4, 300),
    )
    // The harness is only worth something if most cases are drawn rather than refused.
    expect(rendered).toBeGreaterThan(fcRuns(4, 300).numRuns / 4)
  }, fuzzTimeout(60_000))

  it('T-F3B-07: a link mark with a hostile href is never drawn with that scheme', async () => {
    await fc.assert(
      fc.asyncProperty(hostileUrl, async (href) => {
        const { found } = await judged([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] }])
        expect(found).toEqual([])
      }),
      fcRuns(4, 300),
    )
  }, fuzzTimeout(60_000))

  it("T-F3B-08: a case gives back the document it drew, so Loro's WebAssembly heap stops growing (FX-43)", async () => {
    const cases = fc.sample(fc.array(block, { maxLength: 5 }), { numRuns: 500, seed: FUZZ_SEED })
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) await judged(cases[i % cases.length]!)
    }
    await run(SETTLE_CASES)
    const settled = loroHeapBytes()
    await run(MEASURED_CASES)
    expect((loroHeapBytes() - settled) / MEASURED_CASES, 'bytes of Loro heap a case kept').toBeLessThan(KEPT_BYTES_PER_CASE)
  }, 600_000)
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

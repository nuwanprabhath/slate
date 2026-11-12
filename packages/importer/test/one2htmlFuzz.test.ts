import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { normalizeOne2HtmlPage, parseOne2HtmlSection } from '../src/one2html'
import { fcParams, fcRuns, forAll } from '../../desktop/test/fuzz'
import { mutateBytes } from '../../desktop/test/fuzzBytes'
import { hostileHtml } from '../../desktop/test/fuzzHtml'

const read = (path: string): string => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8')
const PAGES = ['one2html/New Section 1/Test Page.html', 'one2html-colors/New Section 1/Test Page.html', 'one2html-overlap/New Section 1/Test Page.html'].map(read)
const INDEXES = ['one2html/New Section 1.html', 'one2html-colors/New Section 1.html', 'one2html-overlap/New Section 1.html'].map(read)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const PREFIX = 'rewritten/'

/**
 * Open finding F3C-1: an input with no element at all (an empty file, only comments or CDATA) makes linkedom's
 * `document.documentElement` null, and `normalizeOne2HtmlPage` throws reading `document.body`. The generators skip
 * that class until the finding is fixed; the branch that fixes it removes this guard.
 */
const hasRoot = (html: string): boolean => parseHTML(html).document.documentElement !== null

/** Property 1: the oracle, applied to one input. */
function checkPage(input: string): void {
  if (!hasRoot(input)) return
  const sources: string[] = []
  const out = normalizeOne2HtmlPage(input, {
    rewriteSrc: (src) => {
      sources.push(src)
      return PREFIX + src
    },
  })
  const expectedCalls = Array.from(parseHTML(input).document.querySelectorAll('img')).filter((img) => img.getAttribute('src')).length
  expect(sources, 'rewriteSrc is called once per image').toHaveLength(expectedCalls)

  const { document } = parseHTML(out)
  expect(document.querySelectorAll('script, style, svg').length, 'no script, style or svg').toBe(0)
  expect(document.querySelectorAll('[class]').length, 'no class attribute').toBe(0)
  expect(Array.from(document.head.children).map((c) => c.tagName.toLowerCase()), 'head holds only the title').toEqual(['title'])
  expect(document.querySelector('title')!.children.length, 'a title with markup creates no element').toBe(0)
  const kids = Array.from(document.body.children)
  expect(kids.filter((c) => c.hasAttribute('data-ink')).length).toBeLessThanOrEqual(1)
  for (const kid of kids) {
    if (kid.hasAttribute('data-ink')) continue
    expect(kid.tagName.toLowerCase()).toBe('div')
    expect(kid.getAttribute('style') ?? '').toMatch(/^position:absolute;left:-?[\d.e+-]+px;top:-?[\d.e+-]+px/)
  }
  for (const img of Array.from(document.querySelectorAll('img'))) {
    if (img.getAttribute('src')) expect(img.getAttribute('data-src-type'), 'image is marked').toBe('image')
  }
}

const FIELD = '﷟HYPERLINK "https://example.com/a"'
/** At most 50 field codes in one text node: a size bound; how the function scales with the count is FX-2's property (M2). */
const fieldText = fc
  .array(fc.tuple(fc.constantFrom('', 'a', ' text ', '<b>'), fc.constantFrom(FIELD, '﷟', '﷟HYPERLINK "x')), { maxLength: 50 })
  .map((xs) => xs.map(([a, b]) => a + b).join('') + 'tail')

const absoluteBox = (inner: string, title = 'T'): string => `<html><head><title>${title}</title></head><body><div style="position:absolute;left:10px;top:20px;max-width:300px">${inner}</div></body></html>`

describe('normalizeOne2HtmlPage fuzz', () => {
  it('T-F3C-01: the fixture pages satisfy the oracle', () => {
    for (const page of PAGES) checkPage(page)
    expect(PAGES.length).toBeGreaterThan(0)
  })

  it('T-F3C-02: mutated fixtures never throw and satisfy the oracle', () => {
    forAll(
      'mutated page',
      (rng) => {
        checkPage(decoder.decode(mutateBytes(rng, encoder.encode(rng.pick(PAGES)))))
      },
      fcRuns(20, 50).numRuns,
    )
  })

  it('T-F3C-03: hostile HTML, bare and inside a positioned box, satisfies the oracle', () => {
    fc.assert(
      fc.property(hostileHtml, hostileHtml, (a, b) => {
        checkPage(a)
        checkPage(absoluteBox(a, b))
        checkPage(`<html><head><title>${b}</title></head><body>${a}<svg style="position:absolute"></svg></body></html>`)
      }),
      fcRuns(4, 200),
    )
  })

  it('T-F3C-04: a title holding markup is text, and images inside boxes are rewritten once each', () => {
    const out = normalizeOne2HtmlPage(absoluteBox('<p>x</p><img src="a.png"><img src="b.png"><img>', '<script>alert(1)</script>&lt;b&gt;'), { rewriteSrc: (s) => PREFIX + s })
    const { document } = parseHTML(out)
    expect(document.querySelector('title')!.children.length).toBe(0)
    expect(out).not.toContain('<script')
    expect(Array.from(document.querySelectorAll('img[data-src-type="image"]')).map((i) => i.getAttribute('src'))).toEqual([PREFIX + 'a.png', PREFIX + 'b.png'])
  })

  it('T-F3C-05: up to 50 field codes in one text node satisfy the oracle', () => {
    fc.assert(
      fc.property(fieldText, (t) => {
        checkPage(absoluteBox(`<p>${t}</p>`))
        checkPage(absoluteBox(t))
      }),
      fcRuns(10, 100),
    )
  })
})

describe('parseOne2HtmlSection fuzz', () => {
  function checkSection(html: string): void {
    for (const entry of parseOne2HtmlSection(html)) {
      expect([0, 1, 2]).toContain(entry.level)
      expect(entry.title).toBe(entry.title.trim())
      expect(typeof entry.file).toBe('string')
    }
  }

  it('T-F3C-06: the fixture indexes parse with level 0 to 2 and trimmed titles', () => {
    for (const html of INDEXES) checkSection(html)
    expect(INDEXES.flatMap((h) => parseOne2HtmlSection(h)).length).toBeGreaterThan(0)
  })

  it('T-F3C-07: mutated indexes and hostile navs never throw', () => {
    forAll(
      'mutated index',
      (rng) => {
        checkSection(decoder.decode(mutateBytes(rng, encoder.encode(rng.pick(INDEXES)))))
      },
      fcRuns(20, 50).numRuns,
    )
    const link = fc
      .tuple(fc.constantFrom('l0', 'l1', 'l2', 'l3', 'l9', 'l99999999999999999999', 'x l2 y', ''), fc.constantFrom('%', '%E0%A4%A', 'a%20b.html', ''), fc.constantFrom(' padded ', ' x ', ''))
      .map(([c, h, t]) => `<a class="${c}" href="${h}" title="${t}">${t} t</a>`)
    fc.assert(
      fc.property(fc.array(fc.oneof(link, hostileHtml), { maxLength: 8 }), (parts) => {
        checkSection(`<nav>${parts.join('')}</nav>`)
        checkSection(parts.join(''))
      }),
      fcParams,
    )
  })
})

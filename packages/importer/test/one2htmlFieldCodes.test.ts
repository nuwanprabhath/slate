import { describe, expect, it } from 'vitest'
import { normalizeOne2HtmlPage } from '../src/one2html'

/** One paragraph holding `n` Word-style field codes, as one2html leaves OneNote's links. */
function page(n: number): string {
  let p = ''
  for (let i = 0; i < n; i++) p += `﷟HYPERLINK "https://e.test/${i}"t${i} `
  return `<html><body><div style="position:absolute;left:0px;top:0px"><div class="outline-element"><p>${p}</p></div></div></body></html>`
}

const links = (html: string): number => html.split('<a href="').length - 1

// Best of three, so one scheduling hiccup on a loaded machine does not decide a ratio.
function best(n: number): number {
  const html = page(n)
  let min = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    normalizeOne2HtmlPage(html)
    min = Math.min(min, performance.now() - t)
  }
  return min
}

describe('one2html field codes (M2)', () => {
  it.each([3000, 8000, 50000])('T-FX2-01: %i field codes in one paragraph all become links without throwing', (n) => {
    const out = normalizeOne2HtmlPage(page(n))
    expect(links(out)).toBe(n)
    expect(out).toContain(`<a href="https://e.test/${n - 1}">t${n - 1} </a>`)
  })

  it('T-FX2-02: 8,000 field codes cost under thirty times 800', () => {
    best(800) // warm the JIT
    expect(best(8000)).toBeLessThan(30 * best(800))
  })
})

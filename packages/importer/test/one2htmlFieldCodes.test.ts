import { describe, expect, it } from 'vitest'
import { normalizeOne2HtmlPage } from '../src/one2html'

/** One paragraph holding `n` Word-style field codes, as one2html leaves OneNote's links. */
function page(n: number): string {
  let p = ''
  for (let i = 0; i < n; i++) p += `﷟HYPERLINK "https://e.test/${i}"t${i} `
  return `<html><body><div style="position:absolute;left:0px;top:0px"><div class="outline-element"><p>${p}</p></div></div></body></html>`
}

const links = (html: string): number => html.split('<a href="').length - 1

/** This process's CPU time in ms: other programs and other test files running at once do not count. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

// CPU time, not the clock: on a machine busy with other work the longer 8,000-code run is preempted more,
// which turned a linear 10x into 31x (load 20; reproduced 3 runs in 10 under 24 busy loops on 10 cores).
// Best of three still drops a garbage collection that lands in one run.
function best(n: number): number {
  const html = page(n)
  let min = Infinity
  for (let i = 0; i < 3; i++) {
    const t = cpuMs()
    normalizeOne2HtmlPage(html)
    min = Math.min(min, cpuMs() - t)
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

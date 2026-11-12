// @vitest-environment happy-dom
// The fuzz kit's own checks: every later fuzz task trusts these helpers to be deterministic and honest.
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { fcParams, fcRuns, relativeCost, Rng } from './fuzz'
import { chunkings, minimizeBytes, mutateBytes } from './fuzzBytes'
import { corpusEntries } from './fuzzCorpus'
import { regexDeadline } from './fuzzDeadline'
import { hostileHtml, hostileUrl, unsafeMarkup } from './fuzzHtml'

// A whole document, so <body onload> keeps its attribute.
const parse = (html: string): ParentNode => new DOMParser().parseFromString(html, 'text/html')

describe('T-F5A-01: seeds and run counts', () => {
  it('the same seed gives the same mutated bytes, and a different seed different ones', () => {
    const base = Uint8Array.from({ length: 64 }, (_, i) => i)
    const run = (seed: number) => Array.from({ length: 50 }, () => 0).map((_, i) => Array.from(mutateBytes(new Rng(seed + i), base, 256)))
    expect(run(7)).toEqual(run(7))
    expect(run(7)).not.toEqual(run(8))
    for (const out of run(9)) expect(out.length).toBeLessThanOrEqual(256)
  })

  it('fcRuns divides the run count, keeps the seed, and respects its floor', () => {
    expect(fcRuns(1)).toEqual(fcParams)
    expect(fcRuns(10).numRuns).toBe(Math.max(1, Math.floor(fcParams.numRuns / 10)))
    expect(fcRuns(1_000_000, 300).numRuns).toBe(300)
    expect(fcRuns(10).seed).toBe(fcParams.seed)
    expect(fcRuns(10).endOnFailure).toBe(true)
  })

  it('chunkings joins back to the original stream', () => {
    const bytes = Uint8Array.from({ length: 40 }, (_, i) => i * 3)
    fc.assert(
      fc.property(chunkings(bytes), (chunks) => {
        const joined = chunks.flatMap((c) => Array.from(c))
        expect(joined).toEqual(Array.from(bytes))
      }),
      fcRuns(10),
    )
  })

  it('relativeCost passes a call as cheap as the benign one', () => {
    const work = () => {
      let s = 0
      // Heavy enough (tens of microseconds) that timer resolution and one preemption cannot dominate the p99.
      for (let i = 0; i < 20_000; i++) s += Math.sqrt(i)
      return s
    }
    const cost = relativeCost(() => void work(), { calibrationRuns: 500 })
    for (let i = 0; i < 500; i++) cost.time(() => void work())
    cost.check()
  })
})

describe('T-F5A-02: minimizeBytes', () => {
  it('returns an input that still fails and is no longer than the original', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), fc.integer({ min: 0, max: 255 }), (noise, needle) => {
        const input = Uint8Array.from([...noise, needle, needle])
        const stillFails = (c: Uint8Array) => c.some((b, i) => b === needle && c[i + 1] === needle)
        const out = minimizeBytes(input, stillFails)
        expect(stillFails(out)).toBe(true)
        expect(out.length).toBeLessThanOrEqual(input.length)
        expect(out.length).toBe(2)
      }),
      fcRuns(20),
    )
  })
})

describe('T-F5A-03: regexDeadline', () => {
  const deadline = regexDeadline()
  afterAll(() => deadline.close())

  it('reports timeout for (a|a)+$ on 30 a and a !, within its deadline, and stays usable', async () => {
    const t = performance.now()
    expect(await deadline.exec('(a|a)+$', '', 'a'.repeat(30) + '!', 200)).toBe('timeout')
    expect(performance.now() - t).toBeLessThan(20_000)
    expect(await deadline.exec('a+$', '', 'aaa', 20_000)).toBe('done')
    expect(await deadline.exec('b', 'g', 'abcb', 20_000)).toBe('done')
  })
})

// Twenty snippets that each carry script, in the forms a sanitiser has to catch.
const SCRIPTED = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href=" \u0001javascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  // No src: happy-dom would try to load one, and logs that it may not.
  '<iframe name="x"></iframe>',
  // Not <svg><script>: happy-dom's parser drops a script inside svg, which a browser keeps.
  '<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>',
  '<svg onload=alert(1)></svg>',
  '<math><a xlink:href="javascript:alert(1)">x</a></math>',
  '<body onload=alert(1)>',
  '<object data="x.swf"></object>',
  '<embed src="x.swf">',
  '<form action="javascript:alert(1)"><button>x</button></form>',
  '<img src="vbscript:msgbox(1)">',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<div style="x" onmouseover="alert(1)">x</div>',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
]

// The shape of what Slate copies (semantic tags, colour, text-align and the indent's margin-left).
const SLATE_COPIED = [
  '<h1>Title</h1><p>Plain <strong>bold</strong> <em>italic</em> <s>gone</s> <code>x()</code></p>',
  '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul><ol start="3"><li><p>three</p></li></ol>',
  '<p style="text-align: center">mid</p><p style="margin-left: 2em">indent</p><p><span style="color: #c0392b">red</span></p>',
  '<pre><code>const a = 1\n</code></pre><blockquote><p>quote</p></blockquote>',
  '<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>',
  '<p><a href="https://example.com/a?b=c">link</a> <a href="mailto:me@example.com">mail</a></p>',
  '<p><img src="slate-image://abc123" width="320"></p>',
  '<ul data-type="taskList"><li data-checked="true"><p>done</p></li></ul>',
]

describe('T-F5A-04: unsafeMarkup', () => {
  for (const [i, html] of SCRIPTED.entries()) {
    it(`flags script-carrying snippet ${i + 1}: ${html}`, () => {
      expect(unsafeMarkup(parse(html), ['http', 'https', 'mailto', 'slate-image'])).not.toEqual([])
    })
  }

  it("flags nothing in Slate's own copied HTML", () => {
    for (const html of SLATE_COPIED) expect(unsafeMarkup(parse(html), ['http', 'https', 'mailto', 'slate-image']), html).toEqual([])
  })

  it('the hostile generators produce strings, deterministically', () => {
    const a = fc.sample(fc.tuple(hostileHtml, hostileUrl), { seed: fcParams.seed, numRuns: 50 })
    const b = fc.sample(fc.tuple(hostileHtml, hostileUrl), { seed: fcParams.seed, numRuns: 50 })
    expect(a).toEqual(b)
    for (const [h, u] of a) {
      expect(typeof h).toBe('string')
      expect(typeof u).toBe('string')
      expect(() => unsafeMarkup(parse(h))).not.toThrow()
    }
  })
})

describe('T-F5A-05: corpusEntries', () => {
  it('a target with no folder has no entries', () => {
    expect(corpusEntries('desktop', 'no-such-target')).toEqual([])
  })
})

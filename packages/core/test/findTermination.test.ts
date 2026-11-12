import { afterAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { compileQuery, type FindOptions } from '../src/find'
import { fcRuns } from '../../desktop/test/fuzz'
import { regexDeadline } from '../../desktop/test/fuzzDeadline'

// Finding M1: a person's pattern runs over stored text on the renderer thread (in-page find) and on
// main (search). Whatever `compileQuery` accepts must finish; what cannot be shown to finish is refused.
const regex: FindOptions = { regex: true, matchCase: false, wholeWord: false }
// `MAX_REGEX_TEXT` in `desktop/src/main/search/searchIndex.ts`: main scans at most this much of a row.
const MAX_REGEX_TEXT = 20_000
const DEADLINE_MS = 1_000

const deadline = regexDeadline()
afterAll(() => deadline.close())

const finishes = async (source: string, text: string): Promise<boolean> => {
  const re = compileQuery(source, regex)
  if (!re) return true
  return (await deadline.exec(re.source, re.flags, text, DEADLINE_MS)) === 'done'
}

describe('compileQuery refuses patterns that do not finish (M1)', () => {
  it('T-FX1-01: refuses the three measured patterns', async () => {
    const cases: Array<[string, string]> = [
      ['(a|a)+$', 'a'.repeat(26) + '!'],
      ['(a|aa)+$', 'a'.repeat(34) + '!'],
      ['(.*a){12}$', 'a'.repeat(60) + '!'],
    ]
    for (const [source, text] of cases) {
      expect(compileQuery(source, regex), source).toBeNull()
      expect(await finishes(source, text), source).toBe(true)
    }
  })

  it('T-FX1-02: still compiles ordinary patterns people type', () => {
    for (const source of ['a+', '(ab)+', '(foo|bar)+', 'al.ha (b|g)', '^to.?do$', '\\d{3}-\\d{4}', '(a+){2}', '\\bword\\b', 'colou?r', '[a-z]+@[a-z]+\\.com', '(?<y>\\d{4})-\\k<y>', '(?=x)y+'])
      expect(compileQuery(source, regex), source).not.toBeNull()
  })

  // The grammar the plan names: overlapping alternation under `+`, `*` and `{n,}`; bounded repeats of
  // unbounded groups; adjacent overlapping quantifiers; backreferences; lookarounds.
  const atom = fc.constantFrom('a', 'b', '.', '\\s', '[ab]', '\\w', 'aa')
  const quant = fc.constantFrom('', '', '*', '+', '?', '{2,}', '{3}', '{1,6}', '{12}')
  const pattern = fc.letrec<{ node: string }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.tuple(atom, quant).map(([a, q]) => (a.length > 1 && q !== '' && !a.startsWith('\\') && !a.startsWith('[') ? `(?:${a})${q}` : a + q)),
      fc.tuple(fc.array(tie('node'), { minLength: 2, maxLength: 3 }), fc.constantFrom('', '+', '*', '{2,}', '{12}', '{3}')).map(([b, q]) => `(${b.join('|')})${q}`),
      fc.tuple(fc.array(tie('node'), { minLength: 1, maxLength: 4 }), quant).map(([s, q]) => `(?:${s.join('')})${q}`),
      fc.tuple(tie('node'), fc.constantFrom('', '*', '+')).map(([n, q]) => `(${n})\\1${q}`),
      fc.tuple(fc.constantFrom('(?=', '(?!', '(?<=', '(?<!'), tie('node')).map(([l, n]) => `${l}${n})`),
    ),
  })).node
  const anchored = fc.tuple(fc.constantFrom('', '^'), fc.array(pattern, { minLength: 1, maxLength: 3 }), fc.constantFrom('$', '!', '', 'b$')).map(([h, p, t]) => h + p.join('') + t)
  const pump = fc
    .tuple(fc.stringMatching(/^[ab ]{0,3}$/), fc.stringMatching(/^[ab ]{1,3}$/), fc.constantFrom('!', '', 'c', ' '), fc.integer({ min: 10, max: MAX_REGEX_TEXT }))
    .map(([pre, p, suf, len]) => (pre + p.repeat(Math.ceil(len / p.length)) + suf).slice(0, MAX_REGEX_TEXT))

  it('T-FX1-03: every pattern compileQuery accepts finishes on pump strings within the deadline', async () => {
    await fc.assert(
      fc.asyncProperty(anchored, pump, async (source, text) => {
        expect(await finishes(source, text), source).toBe(true)
      }),
      fcRuns(10, 200),
    )
  }, 600_000)
})

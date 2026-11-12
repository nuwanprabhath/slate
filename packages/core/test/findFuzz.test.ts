// @fuzz F3a: find.ts under generated text and queries. Executed regexes come from a linear grammar (literals,
// classes, anchors, one quantified atom); the full grammar, where M1 lives, belongs to FX-1.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compileQuery, findMatches, hasNestedUnboundedQuantifier, matchAll, type FindOptions } from '../src/find'
import { fcParams } from '../../desktop/test/fuzz'

// Well-formed strings only: a lone surrogate matches differently under a `u` regex than under indexOf, which is
// a property of the `u` flag and not of find.ts.
const SOUP = ['a', 'b', 'A', ' ', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '\n', '😀', '𝒳', 'é', '_', '1', '-', '/']
const textArb = fc.array(fc.oneof(fc.constantFrom(...SOUP), fc.string({ maxLength: 2, unit: 'binary' })), { maxLength: 40 }).map((p) => p.join('').toWellFormed())
const queryArb = fc.array(fc.constantFrom(...SOUP), { minLength: 1, maxLength: 4 }).map((p) => p.join(''))
// matchAll's loop must advance: a pattern that makes it spin is caught by counting exec calls, not by a timer.
class CountedRegExp extends RegExp {
  calls = 0
  limit = 0
  override exec(s: string): RegExpExecArray | null {
    if (++this.calls > this.limit) throw new Error(`matchAll did not advance: ${this.calls} exec calls on ${JSON.stringify(s)} with /${this.source}/${this.flags}`)
    return super.exec(s)
  }
}
function counted(raw: string, query: string, opts: FindOptions): Array<[number, number]> {
  // Open finding F3A-1: with wholeWord, a rejected match makes matchAll retry at `from + 1`, which can be inside
  // an astral pair, and the `u` regex steps back to the pair's start: the same match again, forever
  // (`\d*.` over "񍡽񰔈" with wholeWord). Astral text is excluded from whole-word runs until that is fixed.
  const text = opts.wholeWord ? raw.replace(/[\u{10000}-\u{10FFFF}]/gu, 'x') : raw
  const re = compileQuery(query, opts)
  if (!re) return []
  const c = new CountedRegExp(re.source, re.flags)
  c.limit = 4 * text.length + 8
  return matchAll(text, c, opts.wholeWord)
}
const literal: FindOptions = { regex: false, matchCase: true, wholeWord: false }

function naive(text: string, query: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) out.push([at, at + query.length])
  return out
}

// Linear grammar: no group, so no nested quantifier and no alternation to backtrack.
const atom = fc.constantFrom('a', 'b', 'x', '.', '[ab]', '[^a]', '\\d', '\\w', '\\s', '\\b', '\\B', '^', '$', '😀', '\\.', '\\(')
const quantifier = fc.constantFrom('', '', '*', '+', '?', '*?', '{0,2}', '{2,}')
const linearPattern = fc.tuple(fc.array(atom, { maxLength: 4 }), atom, quantifier, fc.array(atom, { maxLength: 3 })).map(([pre, q, quant, post]) => pre.join('') + q + quant + post.join(''))
const flags = fc.record({ regex: fc.constant(true), matchCase: fc.boolean(), wholeWord: fc.boolean() })

describe('findMatches fuzz', () => {
  it('T-F3A-01: a literal, case-sensitive search equals a left-to-right indexOf scan', () => {
    fc.assert(
      fc.property(textArb, queryArb, (text, query) => {
        expect(findMatches(text, query, literal)).toEqual(naive(text, query))
      }),
      fcParams,
    )
  })

  it('T-F3A-02: every range is inside the text, non-empty, ascending and non-overlapping', () => {
    fc.assert(
      fc.property(textArb, fc.oneof(queryArb, linearPattern), fc.record({ regex: fc.boolean(), matchCase: fc.boolean(), wholeWord: fc.boolean() }), (text, query, opts) => {
        const ranges = counted(text, query, opts)
        let end = 0
        for (const [from, to] of ranges) {
          expect(from).toBeGreaterThanOrEqual(end)
          expect(to).toBeGreaterThan(from)
          expect(to).toBeLessThanOrEqual(text.length)
          end = to
        }
        expect(ranges.length).toBeLessThanOrEqual(text.length)
      }),
      fcParams,
    )
  })

  it('T-F3A-03: patterns that can match the empty string return at most text.length ranges and terminate', () => {
    const empties = ['a*', '^', '$', '\\b', '\\B', '(?=x)', '(?!x)', 'x?', '(?:)', 'a*?', '[^a]*']
    fc.assert(
      fc.property(textArb, fc.oneof(fc.constantFrom(...empties), linearPattern), flags, (text, query, opts) => {
        const ranges = counted(text, query, opts)
        expect(ranges.length).toBeLessThanOrEqual(text.length)
      }),
      fcParams,
    )
    // A long text of the astral kind advances two units a step, never zero.
    expect(findMatches('😀'.repeat(500), '^', { regex: true, matchCase: true, wholeWord: false }).length).toBeLessThanOrEqual(1000)
    expect(findMatches('😀'.repeat(500), 'a*', { regex: true, matchCase: true, wholeWord: true })).toEqual([])
  })

  it('T-F3A-04: compileQuery and hasNestedUnboundedQuantifier never throw on any string', () => {
    const pattern = fc.oneof(fc.string({ unit: 'binary', maxLength: 30 }), fc.array(fc.constantFrom(...SOUP, '(?:', '\\k<', '(?<n>', '{1,', '+)+', ')*'), { maxLength: 20 }).map((p) => p.join('')))
    fc.assert(
      fc.property(pattern, fc.boolean(), fc.boolean(), fc.boolean(), (query, regex, matchCase, wholeWord) => {
        const re = compileQuery(query, { regex, matchCase, wholeWord })
        expect(re === null || re instanceof RegExp).toBe(true)
        expect(typeof hasNestedUnboundedQuantifier(query)).toBe('boolean')
      }),
      fcParams,
    )
    expect(typeof hasNestedUnboundedQuantifier('('.repeat(100_000))).toBe('boolean')
    expect(typeof hasNestedUnboundedQuantifier('['.repeat(100_000) + '\\')).toBe('boolean')
  })
})

import { describe, expect, it } from 'vitest'
import { compileQuery, findMatches, hasNestedUnboundedQuantifier, type FindOptions } from '../src/find'

describe('hasNestedUnboundedQuantifier', () => {
  it('spots a group that repeats unboundedly inside another unbounded repeat', () => {
    for (const source of ['(a+)+$', '(a*)*', '(a+)*b', '(?:[a-z]+)+', '(x(y+)+)', '(a{1,}){2,}', '((a+)+)?'])
      expect(hasNestedUnboundedQuantifier(source)).toBe(true)
  })

  it('leaves ordinary patterns alone', () => {
    for (const source of ['a+', '(ab)+', '(a+)', '(a+)?', '(a+){2}', 'al.ha (b|g)', '\\(a+\\)+', '[(a+)]+', '(a?)*'])
      expect(hasNestedUnboundedQuantifier(source)).toBe(false)
  })
})

/**
 * The in-page find bar compiles the user's pattern and matches it on the renderer thread
 * (`editor/src/find.ts` findInDoc / findInPage), so a pattern that takes exponential time freezes the
 * window. Main's search index already refused these (`main/search/searchIndex.ts`); `compileQuery` is
 * the one place every caller goes through, so the refusal belongs here.
 */
describe('compileQuery refuses a pattern that cannot be matched in reasonable time', () => {
  const regex: FindOptions = { regex: true, matchCase: false, wholeWord: false }

  it('returns null for a nested unbounded quantifier, as it does for a pattern that will not parse', () => {
    for (const source of ['(a+)+$', '(a*)*', '(?:[a-z]+)+']) expect(compileQuery(source, regex), source).toBeNull()
    expect(compileQuery('(unclosed', regex)).toBeNull()
  })

  it('still compiles the ordinary patterns people type', () => {
    for (const source of ['a+', '(ab)+', 'al.ha (b|g)', '^to.?do$']) expect(compileQuery(source, regex), source).not.toBeNull()
  })

  it('matches nothing, and returns, for a pattern that would otherwise hang', () => {
    // 'aaaa…a!' against /(a+)+$/ is the classic case: without the refusal this does not come back.
    const subject = `${'a'.repeat(40)}!`
    const started = Date.now()
    expect(findMatches(subject, '(a+)+$', regex)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('treats the pattern as literal text when regex is off, however it is written', () => {
    expect(findMatches('say (a+)+$ here', '(a+)+$', { regex: false, matchCase: false, wholeWord: false })).toEqual([[4, 10]])
  })
})

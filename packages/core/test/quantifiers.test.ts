import { describe, expect, it } from 'vitest'
import { hasNestedUnboundedQuantifier } from '../src/find'

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

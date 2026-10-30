import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../src/plaintext'

/** Phase 15 WP-C2: an indented paragraph or heading copies with two spaces per level, like list nesting. */
const p = (text: string, indent?: number, type = 'paragraph'): PMJSON => ({ type, ...(indent ? { attrs: { indent } } : {}), content: [{ type: 'text', text }] })

describe('toPlainText indent', () => {
  it('prefixes two spaces per indent level on every line of the block', () => {
    const lines: PMJSON = { type: 'paragraph', attrs: { indent: 1 }, content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }
    expect(toPlainText([p('top'), p('one', 1), p('Title', 2, 'heading'), lines])).toBe('top\n  one\n    Title\n  a\n  b')
  })

  it('ignores a missing, zero or nonsense indent', () => {
    expect(toPlainText([p('x', 0), { type: 'paragraph', attrs: { indent: 'big' }, content: [{ type: 'text', text: 'y' }] }])).toBe('x\ny')
  })
})

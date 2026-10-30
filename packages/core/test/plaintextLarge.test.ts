import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../src/plaintext'

/** Huge blocks: spreading every line into push() as arguments overflows the stack past ~100k lines. */
const LINES = 500_000

describe('toPlainText on huge blocks', () => {
  it('copies a code block, a paragraph and a list item of half a million lines each', () => {
    const many = 'x\n'.repeat(LINES) + 'end'
    const code: PMJSON = { type: 'codeBlock', content: [{ type: 'text', text: many }] }
    const para: PMJSON = { type: 'paragraph', content: [{ type: 'text', text: many }] }
    const list: PMJSON = { type: 'bulletList', content: [{ type: 'listItem', content: [para, code] }] }
    for (const node of [code, para]) {
      const out = toPlainText([node])
      expect(out.split('\n')).toHaveLength(LINES + 1)
      expect(out.endsWith('x\nend')).toBe(true)
    }
    const listed = toPlainText([list]).split('\n')
    expect(listed).toHaveLength(2 * (LINES + 1))
    expect(listed[0]).toBe('- x')
    expect(listed.at(-1)).toBe('  end')
  })
})

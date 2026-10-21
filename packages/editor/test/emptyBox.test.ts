import { describe, expect, it } from 'vitest'
import { isEmptyContent } from '../src/emptyBox'

describe('isEmptyContent', () => {
  it('treats missing content and one empty paragraph as empty', () => {
    expect(isEmptyContent(null)).toBe(true)
    expect(isEmptyContent({ type: 'doc' })).toBe(true)
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true)
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBe(true)
  })

  it('treats text, an image, a second paragraph or another block as content', () => {
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] })).toBe(false)
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] })).toBe(false)
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] })).toBe(false)
    expect(isEmptyContent({ type: 'doc', content: [{ type: 'heading' }] })).toBe(false)
  })
})

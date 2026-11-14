import { describe, expect, it } from 'vitest'
import { isDocId, isId, newId } from '../src'

describe('the document-id grammar', () => {
  it('accepts a page or notebook kind followed by an id newId makes', () => {
    const id = newId()
    expect(isId(id)).toBe(true)
    expect(isDocId(`page:${id}`)).toBe(true)
    expect(isDocId(`notebook:${id}`)).toBe(true)
  })

  it('refuses any other kind, a missing or malformed id, and non-strings', () => {
    const id = newId()
    for (const bad of ['', 'w', ':', `:${id}`, `page:`, `meta:${id}`, `blob:${id}`, `page:${id.toUpperCase()}`, `page:${id}x`, `page:${id}:x`, `page_${id}`, ` page:${id}`, 'page:../..', 42, null, undefined]) {
      expect(isDocId(bad), String(bad)).toBe(false)
    }
  })
})

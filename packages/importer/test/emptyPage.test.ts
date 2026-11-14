// FX-9: a page that parses to no element is a typed, page-naming error, not linkedom's TypeError.
import { describe, expect, it } from 'vitest'
import { ImportPageError, mapOneNotePage, normalizeOne2HtmlPage } from '../src'

const EMPTY = ['', '<![CDATA[x]]>', '<!-- just a comment -->', 'bare text']

describe('FX-9: a page with no element', () => {
  for (const html of EMPTY) {
    it(`normalizeOne2HtmlPage throws ImportPageError for ${JSON.stringify(html)}`, () => {
      expect(() => normalizeOne2HtmlPage(html, { page: 'Notes/Test Page' })).toThrow(ImportPageError)
      expect(() => normalizeOne2HtmlPage(html, { page: 'Notes/Test Page' })).toThrow(/Notes\/Test Page/)
    })
    it(`mapOneNotePage throws ImportPageError for ${JSON.stringify(html)}`, () => {
      expect(() => mapOneNotePage(html, { page: 'Notes/Test Page' })).toThrow(ImportPageError)
    })
  }
  it('names the page in the message', () => {
    try {
      mapOneNotePage('', { page: 'Q3 plan' })
    } catch (e) {
      expect((e as Error).message).toContain('Q3 plan')
      return
    }
    expect.unreachable()
  })
})

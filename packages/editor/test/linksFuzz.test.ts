// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { normalizeLinkInput } from '../src/links'
import { fcParams, fuzzTimeout } from '../../desktop/test/fuzz'
import { hostileUrl } from '../../desktop/test/fuzzHtml'

// T-F3B: what the link popover accepts. Whatever is typed, an accepted href is one the URL parser reads as
// http, https or mailto.

const SAFE = new Set(['http:', 'https:', 'mailto:'])

/** The scheme a URL parser reads: tabs and newlines anywhere, leading and trailing controls and spaces, removed. */
function parsedScheme(href: string): string | null {
  // eslint-disable-next-line no-control-regex -- the URL standard strips exactly these
  const v = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v)
  return m ? `${m[1]!.toLowerCase()}:` : null
}

const typed = fc.oneof(
  hostileUrl,
  fc.tuple(fc.constantFrom('', ' ', '\t', '\u0000', '\u000b', ' ', ' ', '﻿'), hostileUrl, fc.constantFrom('', ' ', '\n')).map((p) => p.join('')),
  fc.constantFrom('example.com', 'example.com:8080/x', 'localhost:3000', 'javascript:8080/x', 'java­script:alert(1)', 'www.example.com'),
  fc.string({ maxLength: 30 }),
)

describe('T-F3B normalizeLinkInput', () => {
  it('T-F3B-08: an accepted href is read as http, https or mailto by a URL parser', () => {
    fc.assert(
      fc.property(typed, (raw) => {
        const out = normalizeLinkInput(raw)
        if (!('href' in out)) {
          expect(out.error).toBeTypeOf('string')
          return
        }
        const scheme = parsedScheme(out.href)
        expect(scheme === null || SAFE.has(scheme), `${JSON.stringify(raw)} -> ${JSON.stringify(out.href)}`).toBe(true)
        let protocol: string | null = null
        try {
          protocol = new URL(out.href).protocol
        } catch {
          protocol = null
        }
        expect(protocol === null || SAFE.has(protocol), `URL reads ${String(protocol)} from ${JSON.stringify(out.href)}`).toBe(true)
      }),
      fcParams,
    )
  }, fuzzTimeout())
})

import { describe, expect, it } from 'vitest'
import type { LibraryNotebook } from '../types'
import { effectiveScope, resolveScope, summaryText } from './scope'

const library: LibraryNotebook[] = [{ id: 'nb1', name: 'Work', sections: [{ id: 's1', name: 'One', pages: [] }] }]

describe('search scope', () => {
  it('turns the remembered choice into a query scope', () => {
    expect(resolveScope({ kind: 'all' }, library, 'nb1')).toEqual({ kind: 'all' })
    expect(resolveScope({ kind: 'notebook' }, library, 'nb1')).toEqual({ kind: 'notebook', id: 'nb1' })
    expect(resolveScope({ kind: 'section', id: 's1' }, library, 'nb1')).toEqual({ kind: 'section', id: 's1' })
  })

  it('falls back to this notebook when the remembered section is gone', () => {
    expect(effectiveScope({ kind: 'section', id: 'gone' }, library, 'nb1')).toEqual({ kind: 'notebook' })
    expect(resolveScope({ kind: 'section', id: 'gone' }, library, 'nb1')).toEqual({ kind: 'notebook', id: 'nb1' })
  })

  it('treats anything unrecognised as all notebooks', () => {
    expect(effectiveScope(undefined, library, 'nb1')).toEqual({ kind: 'all' })
    expect(effectiveScope({ kind: 'nonsense' } as never, library, 'nb1')).toEqual({ kind: 'all' })
  })

  it('summarises like VS Code', () => {
    expect(summaryText({ pages: [], total: 0, truncated: false })).toBe('No results')
    expect(summaryText({ pages: [{} as never], total: 1, truncated: false })).toBe('1 result in 1 page')
    expect(summaryText({ pages: Array(4).fill({}), total: 22, truncated: false })).toBe('22 results in 4 pages')
    expect(summaryText({ pages: Array(2).fill({}), total: 500, truncated: true })).toBe('500 results in 2 pages (showing the first 500)')
  })
})

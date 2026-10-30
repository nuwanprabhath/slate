import { describe, expect, it } from 'vitest'
import type { SearchResults } from '../../../../shared/api'
import { confirmText, replaceRequest, tickKey } from './replacePlan'

const match = (boxId: string, occurrence: number) => ({ boxId, occurrence, snippet: 'cat', ranges: [[0, 3]] as Array<[number, number]> })
const page = (pageId: string, ...matches: ReturnType<typeof match>[]) => ({ pageId, pageTitle: pageId, sectionId: 's', sectionName: 'S', notebookId: 'n', notebookName: 'N', matches })
const results: SearchResults = { pages: [page('A', match('a', 0), match('a', 1)), page('B', match('b', 0))], total: 3, truncated: false }
const base = { query: 'cat', opts: { matchCase: false, wholeWord: false, regex: false }, replacement: 'dog', preserveCase: false }

describe('replace preview', () => {
  it('asks for every match when nothing is unticked', () => {
    const request = replaceRequest(results, new Set(), base)
    expect(request.pages).toEqual([
      { pageId: 'A', picks: [{ boxId: 'a', occurrence: 0 }, { boxId: 'a', occurrence: 1 }] },
      { pageId: 'B', picks: [{ boxId: 'b', occurrence: 0 }] },
    ])
    expect(confirmText(request)).toBe('Replace 3 in 2 pages')
  })

  it('leaves out unticked matches and pages with none ticked', () => {
    const request = replaceRequest(results, new Set([tickKey('A', 1), tickKey('B', 0)]), base)
    expect(request.pages).toEqual([{ pageId: 'A', picks: [{ boxId: 'a', occurrence: 0 }] }])
    expect(confirmText(request)).toBe('Replace 1 in 1 page')
  })
})

import { describe, expect, it } from 'vitest'
import type { SearchResults } from '../../../../shared/api'
import { confirmText, replaceNotice, replaceRequest, sameMatches, tickKey } from './replacePlan'

const match = (boxId: string, occurrence: number) => ({ boxId, occurrence, snippet: 'cat', ranges: [[0, 3]] as Array<[number, number]> })
const page = (pageId: string, ...matches: ReturnType<typeof match>[]) => ({ pageId, pageTitle: pageId, sectionId: 's', sectionName: 'S', notebookId: 'n', notebookName: 'N', matches })
const results: SearchResults = { pages: [page('A', match('a', 0), match('a', 1)), page('B', match('b', 0))], total: 3, truncated: false }
const base = { query: 'cat', opts: { matchCase: false, wholeWord: false, regex: false }, replacement: 'dog', preserveCase: false }

describe('replace preview', () => {
  it('asks for every match when nothing is unticked', () => {
    const request = replaceRequest(results, new Set(), base)
    expect(request.pages).toEqual([
      { pageId: 'A', picks: [{ boxId: 'a', occurrence: 0, matched: 'cat' }, { boxId: 'a', occurrence: 1, matched: 'cat' }] },
      { pageId: 'B', picks: [{ boxId: 'b', occurrence: 0, matched: 'cat' }] },
    ])
    expect(confirmText(request)).toBe('Replace 3 in 2 pages')
  })

  it('leaves out unticked matches and pages with none ticked', () => {
    const request = replaceRequest(results, new Set([tickKey('A', 1), tickKey('B', 0)]), base)
    expect(request.pages).toEqual([{ pageId: 'A', picks: [{ boxId: 'a', occurrence: 0, matched: 'cat' }] }])
    expect(confirmText(request)).toBe('Replace 1 in 1 page')
  })

  it('sees the notes changed when a listed page’s matches moved, e.g. a match added before an unticked one', () => {
    expect(sameMatches(results, structuredClone(results))).toBe(true)
    const moved: SearchResults = { ...results, pages: [page('A', match('a', 0), match('a', 1), match('a', 2)), results.pages[1]!] }
    expect(sameMatches(results, moved)).toBe(false)
    expect(sameMatches(results, { ...results, pages: [results.pages[0]!] })).toBe(false)
    // A page that only gained matches outside the preview's pages does not matter.
    expect(sameMatches(results, { ...results, pages: [...results.pages, page('C', match('c', 0))] })).toBe(true)
  })

  it('says what was left alone after a replace', () => {
    expect(replaceNotice({ replaced: 3, pages: 2, skipped: 0, failed: 0 })).toBeNull()
    expect(replaceNotice({ replaced: 2, pages: 1, skipped: 1, failed: 1 })).toBe('Replaced 2 in 1 page. 1 match had changed and was left as it was. 1 page could not be changed.')
  })
})

import { describe, expect, it } from 'vitest'
import { currentToReplace } from './currentMatch'

const m = (boxId: string, from: number) => ({ boxId, from, to: from + 3 })

describe('currentToReplace', () => {
  it('gives the current match and its index in its box when the matches are still the same', () => {
    const matches = [m('a', 1), m('b', 1), m('b', 9)]
    expect(currentToReplace(matches, 2, [...matches])).toEqual({ boxId: 'b', occurrence: 1 })
  })

  it('refuses when the page changed since the highlights were drawn', () => {
    // A match was typed before the current one: occurrence 1 is now a different match.
    expect(currentToReplace([m('b', 1), m('b', 9)], 1, [m('b', 1), m('b', 5), m('b', 13)])).toBeNull()
    expect(currentToReplace([m('a', 1)], 0, [])).toBeNull()
    expect(currentToReplace([], -1, [])).toBeNull()
  })
})

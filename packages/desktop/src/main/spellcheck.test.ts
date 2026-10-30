import { describe, expect, it } from 'vitest'
import { applySpellcheck } from './spellcheck'

describe('applySpellcheck', () => {
  it("runs the session's spell checker only while misspelled words are to be underlined", () => {
    const calls: boolean[] = []
    const session = { setSpellCheckerEnabled: (on: boolean) => void calls.push(on) }
    applySpellcheck(session, { spellcheckUnderline: false })
    applySpellcheck(session, { spellcheckUnderline: true })
    expect(calls).toEqual([false, true])
  })
})

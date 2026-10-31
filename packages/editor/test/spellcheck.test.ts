import { describe, expect, it } from 'vitest'
import { boxEditorAttributes } from '../src/BoxEditor'

describe('box editor attributes', () => {
  it('ask the browser to underline misspelled words only when the setting is on', () => {
    expect(boxEditorAttributes({ spellcheckUnderline: false }).spellcheck).toBe('false')
    expect(boxEditorAttributes({ spellcheckUnderline: true }).spellcheck).toBe('true')
  })

  it('never let the browser correct or capitalise, whatever the setting', () => {
    for (const spellcheckUnderline of [false, true]) {
      expect(boxEditorAttributes({ spellcheckUnderline })).toMatchObject({ autocorrect: 'off', autocapitalize: 'off' })
    }
  })
})

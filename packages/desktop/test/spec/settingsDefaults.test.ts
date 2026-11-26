// @product-rule no-auto-formatting (CLAUDE.md, Product rules). A guarded spec: its expectations only
// grow, and only the maintainer changes the rule. The defaults that make "off by default" true.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/settings/schema'

describe('auto-formatting defaults', () => {
  it('Markdown Shortcuts start off and autoBullets starts on', () => {
    expect(DEFAULT_SETTINGS.markdownShortcuts).toBe(false)
    expect(DEFAULT_SETTINGS.autoBullets).toBe(true)
  })

  it('pasted addresses become links by default (the maintainer decided in 0.4.2)', () => {
    expect(DEFAULT_SETTINGS.linkPastedUrls).toBe(true)
  })

  it('misspelled words are not underlined by default, and never corrected (phase 15 WP-D)', () => {
    expect(DEFAULT_SETTINGS.spellcheckUnderline).toBe(false)
  })
})

// GDPR Art. 25 (privacy by default), the maintainer's §3.0 item 1 of docs/reviews/gdpr-compliance-review.md:
// a fresh install sends nothing anywhere until the person grants a feature.
describe('privacy defaults', () => {
  it('strict mode starts on, with no consent granted', () => {
    expect(DEFAULT_SETTINGS.gdprStrictMode).toBe(true)
    expect(DEFAULT_SETTINGS.consents).toEqual({})
  })
})

// @product-rule no-auto-formatting (CLAUDE.md, Product rules). A guarded spec: its expectations only
// grow, and only the maintainer changes the rule. The defaults that make "off by default" true.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/settings/schema'

describe('auto-formatting defaults', () => {
  it('Markdown Shortcuts start off and autoBullets starts on', () => {
    expect(DEFAULT_SETTINGS.markdownShortcuts).toBe(false)
    expect(DEFAULT_SETTINGS.autoBullets).toBe(true)
  })
})

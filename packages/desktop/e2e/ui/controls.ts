/** Assertions on the shared control look (controls.css), for the UI scenarios. */
import type { Locator, Page } from '@playwright/test'
import { expect, MOD } from '../fixtures'
import { BUILTIN_THEMES } from '../../src/shared/theme/builtins'
import { composite, contrastRatio, parseColor, type RGBA } from '../../src/shared/theme/color'
import type { ReviewTheme } from './review'

/**
 * Every built-in theme by the name `reviewUi` takes. review.ts's `ReviewTheme` lists only the four
 * a scenario runs in by default, but `setTheme` applies any `builtin:<name>`.
 */
export const EVERY_THEME = BUILTIN_THEMES.map((b) => b.id.replace(/^builtin:/, '')) as ReviewTheme[]

function rgba(css: string): RGBA {
  const c = parseColor(css)
  expect(c, css).not.toBeNull()
  return c!
}

/** The accent as the page resolves it, in the `rgb(…)` form computed styles use. */
async function accent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
}

/**
 * One focus indicator: no outline, and the ring is the accent border plus a flush 1px accent
 * box-shadow (2px in all, no gap). The maintainer saw the border and an outline 1px outside it.
 */
export async function expectOneRing(field: Locator, name: string): Promise<void> {
  await expect(field, name).toBeFocused()
  const ring = await field.evaluate((el) => {
    const s = getComputedStyle(el)
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, border: s.borderTopColor, shadow: s.boxShadow }
  })
  const colour = await accent(field.page())
  expect(ring.outlineStyle === 'none' || ring.outlineWidth === '0px', `${name}: no outline (${ring.outlineStyle} ${ring.outlineWidth})`).toBe(true)
  expect(ring.border, `${name}: border`).toBe(colour)
  expect(ring.shadow, `${name}: box-shadow`).toBe(`${colour} 0px 0px 0px 1px`)
}

export async function openSearchScope(p: Page): Promise<Locator> {
  if (!(await p.getByTestId('search-panel').isVisible())) {
    await p.keyboard.press(`${MOD}+Shift+f`)
    await expect(p.getByTestId('search-panel')).toBeVisible()
  }
  const scope = p.getByTestId('search-scope')
  // By keyboard from the search field, as a person tabs to it: :focus-visible matches for certain.
  await p.getByTestId('search-input').focus()
  for (let i = 0; i < 8 && !(await scope.evaluate((el) => el === document.activeElement)); i++) await p.keyboard.press('Tab')
  return scope
}

/**
 * A secondary button's edge stands out from the panel it sits on at 3:1 (WCAG 1.4.11), and its fill
 * is not the panel's own: in Folio both were within 1.1:1, so "Check now" read as a label.
 */
export async function expectButtonVisible(button: Locator, name: string): Promise<void> {
  const c = await button.evaluate((el) => {
    let surface: Element | null = el.parentElement
    while (surface !== null && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement
    const s = getComputedStyle(el)
    return { edge: s.borderTopColor, fill: s.backgroundColor, surface: getComputedStyle(surface ?? document.body).backgroundColor, window: getComputedStyle(document.body).backgroundColor }
  })
  const window = { ...rgba(c.window), a: 1 }
  const surface = composite(rgba(c.surface), window)
  expect(contrastRatio(rgba(c.edge), surface), `${name}: edge ${c.edge} on ${c.surface}`).toBeGreaterThanOrEqual(3)
  expect(contrastRatio(composite(rgba(c.fill), surface), surface), `${name}: fill ${c.fill} on ${c.surface}`).toBeGreaterThan(1.02)
}

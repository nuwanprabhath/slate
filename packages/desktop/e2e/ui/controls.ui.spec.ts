import { expect, MOD, test } from '../fixtures'
import { EVERY_THEME, expectOneRing, openSearchScope } from './controls'
import { reviewUi } from './review'

/** The library's "Search in" dropdown and Settings' search field, focused, in every built-in theme. */
test('UI: a focused dropdown and search field show one ring', async ({ app, page }) => {
  test.setTimeout(480_000)
  await expect(page.getByTestId('canvas')).toBeVisible()
  await reviewUi(app, page, 'focused notebook dropdown', {
    themes: EVERY_THEME,
    open: async (p) => expectOneRing(await openSearchScope(p), 'search scope'),
  })
  await reviewUi(app, page, 'focused settings search', {
    themes: EVERY_THEME,
    close: (p) => p.keyboard.press('Escape'),
    open: async (p) => {
      if (!(await p.getByTestId('settings-dialog').isVisible())) await p.keyboard.press(`${MOD}+,`)
      const search = p.getByTestId('settings-search')
      await search.click()
      await expectOneRing(search, 'settings search')
    },
  })
})

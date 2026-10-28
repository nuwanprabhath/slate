/**
 * `reviewUi`: the UI quality gate for one state of the app. For each theme and window width it
 * applies the theme, sizes the window, runs `open`, audits (./audit.ts) and saves a screenshot to
 * `ui-review/shots/<name>--<theme>-<width>.png` at the repo root. Any audit violation fails the
 * scenario, listed with the element and the screenshot it is in.
 *
 * The screenshots are for eyes: the lead reviews them against .claude/skills/ui-review/SKILL.md, and
 * `npm run ui:review` lays them out on one page (`ui-review/index.html`).
 *
 * Opening a state (a menu, the find bar, a settings section) is the scenario's job: pass it as
 * `open`, so it runs again after each resize and theme change, as a person would see it. Pass
 * `close` to put it away before the next pass when `open` cannot run twice.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { auditUi, type UiViolation } from './audit'

/** The built-in themes every scenario is checked in (shared/theme/builtins.ts). */
export type ReviewTheme = 'dark' | 'light' | 'paper' | 'glass'
export const THEMES: readonly ReviewTheme[] = ['dark', 'light', 'paper', 'glass']

/**
 * The window widths a scenario may be checked at. `createWindow` sets no minimum, so 800 stands for
 * the narrowest window a person keeps Slate in (half a 1600 px laptop screen); 1280 is the size a new
 * window opens at (windows.ts). Not any number: a failing width is a defect to fix, never a width to
 * move (see the skill).
 */
export type UiWidth = 800 | 1280
export const NARROW: UiWidth = 800
export const WIDE: UiWidth = 1280

export interface ReviewOptions {
  /** Brings the state on screen; runs after every resize and theme change. */
  open?: (page: Page) => Promise<void>
  /** Puts it away again before the next pass (Escape a menu). */
  close?: (page: Page) => Promise<void>
  /** Default: both widths. */
  widths?: UiWidth[]
  /** Default: all four built-in themes. */
  themes?: ReviewTheme[]
  height?: number
  /** Audit only inside this element (a CSS selector; default the whole window). */
  within?: string
  /**
   * A scrolling pane (CSS selector) to page through: each screenful is audited and saved
   * (`…-p2.png`, `…-p3.png`), so what is below the fold is checked too.
   */
  scroll?: string
}

const SHOTS = resolve(__dirname, '..', '..', '..', '..', 'ui-review', 'shots')

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Sizes every window's content to `width` × `height` and waits until the page has the new size. */
export async function sizeWindow(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const w of BrowserWindow.getAllWindows()) w.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight].join('x'))).toBe(`${String(width)}x${String(height)}`)
}

/**
 * Applies a built-in theme the way the app does. A notes window saves it as the setting; the lock and
 * self-test windows cannot write settings, so main sends them the settings-changed event their theme
 * follows (CH.settingsChanged), as it does when the setting changes.
 */
export async function setTheme(app: ElectronApplication, page: Page, theme: ReviewTheme): Promise<void> {
  const themeId = `builtin:${theme}`
  const saved = await page.evaluate((id) => window.slate.settings.set({ themeId: id, followSystem: false }).then(() => true, () => false), themeId)
  if (!saved) {
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', { themeId: id, followSystem: false, fontOverrides: {} })
    }, themeId)
  }
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('')
  await settled(page)
}

/** Waits until nothing has moved for 4 frames (at most 3 s): layout, fonts and observers have run. */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const signature = (): string => {
      const parts: string[] = []
      for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
        if (el.offsetWidth !== 0) parts.push(`${String(el.offsetLeft)},${String(el.offsetTop)},${String(el.offsetWidth)},${String(el.offsetHeight)}`)
      }
      return parts.join(';')
    }
    await document.fonts.ready
    const deadline = performance.now() + 3000
    let last = signature()
    let still = 0
    while (still < 4 && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r))
      const now = signature()
      still = now === last ? still + 1 : 0
      last = now
    }
  })
}

/** Check one UI state at each theme and width; fail on any audit violation. */
export async function reviewUi(app: ElectronApplication, page: Page, name: string, opts: ReviewOptions = {}): Promise<void> {
  const widths = opts.widths ?? [NARROW, WIDE]
  const themes = opts.themes ?? THEMES
  const height = opts.height ?? 820
  mkdirSync(SHOTS, { recursive: true })
  // Each pass (theme × width × screenful) takes a few seconds; the scenario's own budget is for its steps.
  test.info().setTimeout(test.info().timeout + themes.length * widths.length * 15_000)
  const found: Array<UiViolation & { shot: string }> = []
  for (const theme of themes) {
    await setTheme(app, page, theme)
    for (const width of widths) {
      await sizeWindow(app, page, width, height)
      // Parked in the corner: left where the scenario last clicked, the pointer would hover a row.
      await page.mouse.move(1, height - 1)
      await settled(page)
      await opts.open?.(page)
      await settled(page)
      const base = `${slug(name)}--${theme}-${String(width)}`
      const pages = opts.scroll === undefined ? 1 : await page.evaluate((sel) => {
        const pane = document.querySelector(sel)
        if (pane === null) return 1
        pane.scrollTop = 0
        return Math.max(1, Math.ceil((pane.scrollHeight - 1) / Math.max(1, pane.clientHeight * 0.85)))
      }, opts.scroll)
      for (let p = 0; p < pages; p++) {
        if (opts.scroll !== undefined && p > 0) {
          await page.evaluate(({ sel, step }) => {
            const pane = document.querySelector(sel)
            if (pane !== null) pane.scrollTop = Math.round(pane.clientHeight * 0.85 * step)
          }, { sel: opts.scroll, step: p })
          await settled(page)
        }
        const shot = `${base}${p === 0 ? '' : `-p${String(p + 1)}`}.png`
        await page.screenshot({ path: resolve(SHOTS, shot) })
        const within = opts.within
        for (const v of await page.evaluate(auditUi, within === undefined ? {} : { within })) found.push({ ...v, shot })
      }
      if (opts.scroll !== undefined) await page.evaluate((sel) => document.querySelector(sel)?.scrollTo(0, 0), opts.scroll)
      await opts.close?.(page)
    }
  }
  const byDefect = new Map<string, string[]>()
  for (const v of found) {
    const key = `  ${v.rule}: ${v.where}: ${v.detail}`
    byDefect.set(key, [...(byDefect.get(key) ?? []), v.shot])
  }
  const report = [...byDefect].map(([k, shots]) => `${k}  (${shots[0] ?? ''}${shots.length > 1 ? ` +${String(shots.length - 1)}` : ''})`)
  // Soft, so a scenario that loops (every settings section) reports every state, not the first.
  expect.soft(report, `UI audit of "${name}" found ${String(report.length)} defect(s); screenshots in ui-review/shots/:\n${report.join('\n')}\n`).toEqual([])
}

import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './fixtures'

/**
 * Audit C8 (§4.4, §6.7): the window only ever shows Slate's own page, links leave through the
 * external opener, and the renderer gets no device or notification permission.
 */

/** Replaces Electron's shell.openExternal with a recorder, so no browser opens during the test. */
async function stubExternalOpener(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as { __opened: string[] }).__opened = opened
    shell.openExternal = async (url: string) => void opened.push(url)
  })
  return () => app.evaluate(() => [...(globalThis as unknown as { __opened: string[] }).__opened])
}

const windowCount = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

test('T-B-01: location.href to a remote page leaves the window on the app and hands the URL to the browser', async ({ app, page }) => {
  const opened = await stubExternalOpener(app)
  await expect(page.getByTestId('notebook-picker')).toBeVisible()
  await page.evaluate(() => {
    location.href = 'https://example.invalid/'
  })
  await expect.poll(opened).toEqual(['https://example.invalid/'])
  expect(page.url()).toMatch(/^app:\/\/slate\//)
  expect(await page.evaluate(() => typeof window.slate.docs.load)).toBe('function')
})

test('review M1: navigating to about:blank, about:srcdoc, file: or data: leaves the window on the app', async ({ app, page }) => {
  await expect(page.getByTestId('notebook-picker')).toBeVisible()
  const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL())
  // app://slate/assets/: another app file is not the app (review L-R1); the window goes back to the entry.
  for (const target of ['app://slate/assets/', 'about:blank', 'about:srcdoc', 'file:///etc/hosts', 'data:text/html,x']) {
    await page.evaluate((to) => {
      location.href = to
    }, target)
    // The page may be torn down and replaced; poll main's view of the window rather than the page.
    await expect.poll(url, { message: target, timeout: 10_000 }).toMatch(/^app:\/\/slate\/(index\.html)?(\?|$)/)
    await expect.poll(() => page.evaluate(() => typeof window.slate?.docs?.load).catch(() => 'reloading'), { message: target, timeout: 10_000 }).toBe('function')
  }
})

test('T-B-01: window.open opens no window; the URL goes to the browser', async ({ app, page }) => {
  const opened = await stubExternalOpener(app)
  await expect(page.getByTestId('notebook-picker')).toBeVisible()
  const before = await windowCount(app)
  const handle = await page.evaluate(() => window.open('https://example.invalid/') === null)
  expect(handle).toBe(true)
  await expect.poll(opened).toEqual(['https://example.invalid/'])
  expect(await windowCount(app)).toBe(before)
})

test('red team R1: clicking a link, with or without target=_blank, ends in the external opener and the window stays on the app', async ({ app, page }) => {
  const opened = await stubExternalOpener(app)
  await expect(page.getByTestId('notebook-picker')).toBeVisible()
  const before = await windowCount(app)
  for (const [id, target] of [
    ['link-blank', '_blank'],
    ['link-self', ''],
  ] as const) {
    await page.evaluate(
      ({ linkId, linkTarget }) => {
        const a = document.createElement('a')
        a.id = linkId
        a.href = `https://example.invalid/${linkId}`
        if (linkTarget) a.target = linkTarget
        a.textContent = linkId
        document.body.append(a)
      },
      { linkId: id, linkTarget: target },
    )
    // A DOM click, as a user's would be: the link sits outside the app's layout, where a pointer click cannot reach it.
    await page.evaluate((linkId) => document.getElementById(linkId)!.click(), id)
  }
  await expect.poll(opened).toEqual(['https://example.invalid/link-blank', 'https://example.invalid/link-self'])
  expect(page.url()).toMatch(/^app:\/\/slate\//)
  expect(await windowCount(app)).toBe(before)
})

test('T-B-04: the camera, microphone and location are denied, and so are notifications', async ({ page }) => {
  await expect(page.getByTestId('notebook-picker')).toBeVisible()
  // getUserMedia itself is not called: on macOS it goes through the system's camera and microphone
  // consent first and never settles in a hidden window, and it could put a dialog on the user's
  // screen. The permission check handler answers these queries; the request handler's denial of
  // `media` is a unit test (hardening.test.ts).
  const states = await page.evaluate(async () =>
    Promise.all((['camera', 'microphone', 'geolocation'] as const).map(async (name) => (await navigator.permissions.query({ name: name as PermissionName })).state)),
  )
  expect(states).toEqual(['denied', 'denied', 'denied'])
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
})

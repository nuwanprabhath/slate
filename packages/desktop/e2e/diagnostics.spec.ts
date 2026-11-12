import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

test('the diagnostic log writes nothing while off', async ({ userData, page }) => {
  expect(await page.evaluate(() => window.slate.settings.get().then((s) => s.debugLog))).toBe(false)
  expect(await page.evaluate(() => window.slate.diagnostics.read())).toBe('')
  expect(existsSync(join(userData, 'logs'))).toBe(false)
})

test('switching it on writes a version line with no home directory in it', async ({ userData, page }) => {
  await page.evaluate(() => window.slate.settings.set({ debugLog: true }))
  const text = await page.evaluate(() => window.slate.diagnostics.read())
  expect(text).toMatch(/ info {2}\[app\] diagnostic log on \{"version":"[^"]+","platform":"\w+","arch":"\w+"/)
  expect(text).not.toContain(homedir())
  // What the screen showed is the start of the real file, not necessarily the whole of it: the log only
  // grows, and the app writes to it on its own schedule, so a line can land between these two reads.
  // Seen in CI on 2026-11-12, where the file watcher logged `[watch] external updates` 1 ms after the
  // line the screen ended on and an equality check failed. A prefix still proves the screen shows the
  // real log, in order, from the beginning.
  expect(readFileSync(join(userData, 'logs', 'slate.log'), 'utf8').startsWith(text), 'the screen shows the start of the log file').toBe(true)
})

test('it logs again at the next start while on, and stops when switched off', async ({ userData, app, page }) => {
  await page.evaluate(() => window.slate.settings.set({ debugLog: true }))
  await app.close()
  const second = await launchApp(userData)
  const text = await second.page.evaluate(() => window.slate.diagnostics.read())
  expect(text.match(/diagnostic log on/g)).toHaveLength(2)
  await second.page.evaluate(() => window.slate.settings.set({ debugLog: false }))
  // Startup may still be logging (the file watcher, the vault) when the page is ready: compare from the moment it was switched off.
  const atOff = await second.page.evaluate(() => window.slate.diagnostics.read())
  expect(atOff.startsWith(text)).toBe(true)
  await second.page.evaluate(() => window.slate.settings.set({ markdownShortcuts: true }))
  expect(await second.page.evaluate(() => window.slate.diagnostics.read())).toBe(atOff)
  await second.app.close()
})

test('T-PQ-D3-02: the exported log carries the vault header version and host-only transports', async ({ userData, page }) => {
  await page.evaluate(() => window.slate.settings.set({ debugLog: true }))
  const text = await page.evaluate(() => window.slate.diagnostics.read())
  const line = text.split('\n').find((l) => l.includes('post-quantum state'))
  expect(line).toBeDefined()
  const fields = JSON.parse((line ?? '').slice((line ?? '').indexOf('{"'))) as { vaultHeaderVersion: number | null; transports: Array<{ remote: string }> }
  expect(fields.vaultHeaderVersion === null || [1, 2, 3].includes(fields.vaultHeaderVersion)).toBe(true)
  for (const t of fields.transports) expect(t.remote).toMatch(/^[a-z][a-z0-9-]*:[A-Za-z0-9.-]+(:\d+)?$/)
  // Whatever redact() would strip is already gone: no home folder, no token, no URL.
  expect(text).not.toContain(homedir())
  expect(text).not.toMatch(/ghp_|https?:\/\/|@/)
  expect(text).not.toContain(userData)
})

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
  expect(readFileSync(join(userData, 'logs', 'slate.log'), 'utf8')).toBe(text)
})

test('it logs again at the next start while on, and stops when switched off', async ({ userData, app, page }) => {
  await page.evaluate(() => window.slate.settings.set({ debugLog: true }))
  await app.close()
  const second = await launchApp(userData)
  const text = await second.page.evaluate(() => window.slate.diagnostics.read())
  expect(text.match(/diagnostic log on/g)).toHaveLength(2)
  await second.page.evaluate(() => window.slate.settings.set({ debugLog: false }))
  await second.page.evaluate(() => window.slate.settings.set({ markdownShortcuts: true }))
  expect(await second.page.evaluate(() => window.slate.diagnostics.read())).toBe(text)
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

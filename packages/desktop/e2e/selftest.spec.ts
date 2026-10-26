// T-POST-10 … T-POST-12 (audit §6.2, C6): a failed power-up self-test is a hard lock. T-POST-13 (a packaged
// build ignores the fault hook) is the unit test in src/main/testHooks.test.ts plus e2e-packaged.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, test, unlockWith } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

const PASSWORD = 'e2e selftest password'
// One vector per family; post.child.test.ts covers every KAT id at the unit layer.
const CORRUPT = ['POST-MODULE-STATUS', 'POST-AES-GCM-ENC', 'POST-KBKDF', 'POST-PBKDF2', 'POST-SLE2-SEAL', 'POST-ZEROIZE'] as const
const SENTENCE = (id: string) => `Slate stopped: a cryptographic self-test failed (${id}). Your notes were not opened. Quit and start Slate again; if this repeats, reinstall Slate.`
const LOCKED_MCP = 'Slate is locked or not running. Unlock Slate to give AI access.'

/**
 * sha256 of every file Slate keeps in the data folder: the vault files, the databases and the image and sync
 * folders. Chromium keeps its own profile (caches, Local State, DevToolsActivePort) in the same folder, which
 * changes on every launch, and the logs may be appended to; neither is Slate's data.
 */
const SLATE_FILE = /^((vault|local-keys|preunlock|profile-floor|migration|quick-unlock)[^/]*\.json|slate[^/]*\.db(-wal|-shm|-journal)?|(blobs|images|git-sync)\/.+)$/

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = relative(dir, p)
      if (statSync(p).isDirectory()) walk(p)
      else if (SLATE_FILE.test(rel)) out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

async function refusals(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const settle = (p: Promise<unknown>) => p.then(() => 'allowed', (e: unknown) => String(e))
    return Promise.all([settle(window.slate.docs.list('')), settle(window.slate.vault.unlock(new TextEncoder().encode('e2e selftest password')))])
  })
}

test.describe('power-up self-test', () => {
  for (const id of CORRUPT) {
    test(`T-POST-10 ${id} corrupted: no note is opened, nothing in the data folder changes, every channel refuses`, async ({ userData }) => {
      const seed = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
      await expect(seed.page.getByTestId('lock-screen')).toBeVisible()
      await seed.app.close()
      const before = snapshot(userData)
      expect([...before.keys()]).toContain('vault.json')

      const { app, page } = await launchApp(userData, { SLATE_TEST_SELFTEST_CORRUPT: id })
      await expect(page.getByTestId('selftest-failed')).toBeVisible()
      await expect(page.getByTestId('selftest-failed-code')).toHaveText(id)
      await expect(page.getByTestId('selftest-failed')).toContainText(SENTENCE(id))
      await expect(page.getByTestId('lock-secret')).toHaveCount(0)
      for (const outcome of await refusals(page)) expect(outcome).toContain('self-test failed')
      expect((await page.evaluate(() => window.slate.vault.status())).state).toBe('selftest-failed')
      // No window but the error screen, and no way out of it but quitting.
      expect(app.windows()).toHaveLength(1)
      await app.close()

      expect(snapshot(userData)).toEqual(before)
    })
  }

  test('T-POST-10 a plaintext folder gets the same error screen (D-2, S-11), and Copy diagnostic report names no path', async ({ userData }) => {
    const seed = await launchApp(userData)
    await seed.page.evaluate(() => window.slate.docs.append('test:1', new Uint8Array([1, 2, 3])))
    await seed.app.close()
    const before = snapshot(userData)
    expect([...before.keys()]).toContain('slate.db')
    const { app, page } = await launchApp(userData, { SLATE_TEST_SELFTEST_CORRUPT: 'POST-AES-GCM-DEC' })
    await expect(page.getByTestId('selftest-failed-code')).toHaveText('POST-AES-GCM-DEC')
    for (const outcome of await refusals(page)) expect(outcome).toContain('self-test failed')
    await page.getByTestId('selftest-copy-report').click()
    await expect(page.getByTestId('selftest-copy-report')).toHaveText('Copied')
    const report = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(report).toContain('failed checks: POST-AES-GCM-DEC')
    expect(report).toContain('error state: true')
    expect(report).not.toContain(userData)
    expect(report).not.toMatch(/\/Users\/|\/home\//)
    await app.close()
    expect(snapshot(userData)).toEqual(before)
  })

  test('T-POST-11 the next start without the fault unlocks as usual (the failure is not persisted)', async ({ userData }) => {
    const seed = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
    await expect(seed.page.getByTestId('lock-screen')).toBeVisible()
    await seed.app.close()
    const failed = await launchApp(userData, { SLATE_TEST_SELFTEST_CORRUPT: 'POST-AES-GCM-DEC' })
    await expect(failed.page.getByTestId('selftest-failed')).toBeVisible()
    await failed.app.close()
    // The variable again only so the test vault's cheap KDF is accepted; the vault already exists and is kept.
    const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
    const notes = await unlockWith(app, page, PASSWORD)
    await expect.poll(async () => (await notes.evaluate(() => window.slate.vault.status())).state).toBe('unlocked')
    expect((await notes.evaluate(() => window.slate.vault.status())).selfTest).toMatchObject({ passed: true, failed: [] })
    await app.close()
  })

  test('T-POST-12 Run self-tests failing while unlocked: the notes window goes unflushed, the error screen shows, no socket, no open database', async ({ userData }) => {
    const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD, SLATE_TEST_SELFTEST_CORRUPT: 'POST-KBKDF', SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND: '1' })
    const mcp = await connectMcp(userData)
    try {
      const notes = await unlockWith(app, page, PASSWORD)
      await expect.poll(async () => (await mcp.client.callTool({ name: 'list_tree', arguments: {} })).isError ?? false, { timeout: 15_000 }).toBe(false)
      const pid = app.process().pid!
      const openDbs = () => execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8' }).split('\n').filter((l) => /slate-[^/\s]*\.db/.test(l))
      expect(openDbs().length).toBeGreaterThan(0)

      // Review C6: a lock in flight while the self-test fails must not replace the error screen with the lock screen.
      await notes.evaluate(() => {
        void window.slate.vault.selfTest()
        window.slate.vault.lock()
      })
      await expect.poll(() => notes.isClosed(), { timeout: 15_000 }).toBe(true)
      let errorScreen: Page | undefined
      await expect.poll(() => (errorScreen = app.windows().find((w) => !w.isClosed())) !== undefined, { timeout: 15_000 }).toBe(true)
      await expect(errorScreen!.getByTestId('selftest-failed-code')).toHaveText('POST-KBKDF')
      expect(app.windows()).toHaveLength(1)
      expect((await errorScreen!.evaluate(() => window.slate.vault.status())).state).toBe('selftest-failed')
      await expect.poll(async () => textOf(await mcp.client.callTool({ name: 'list_tree', arguments: {} })), { timeout: 15_000 }).toBe(LOCKED_MCP)
      expect(openDbs()).toEqual([])
      // Whatever was still in flight (the lock's flush wait) has settled: still only the error screen.
      await new Promise((r) => setTimeout(r, 3500))
      expect(app.windows().filter((w) => !w.isClosed())).toHaveLength(1)
      await expect(app.windows().find((w) => !w.isClosed())!.getByTestId('selftest-failed')).toBeVisible()
    } finally {
      await mcp.close()
      await app.close()
    }
  })
})

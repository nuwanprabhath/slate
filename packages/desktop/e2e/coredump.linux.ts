// T-ZERO-06 (audit §6.3, Z-9, C7 criterion 4): the main process runs non-dumpable with RLIMIT_CORE 0, its
// Chromium children still start (the whole e2e suite runs that way on Linux CI), and a crash leaves no
// core file; main is hardened by Z-9, its renderer by the Chromium sandbox (checked too). Linux only; run by playwright.linux.config.ts in CI's memory-evidence step, after it sets
// `kernel.core_pattern=/tmp/slate-core.%p` and `ulimit -c unlimited`, so a dump would land there.
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

test('T-ZERO-06: the main process is non-dumpable, spawns its renderer, and leaves no core file when it crashes', async () => {
  expect(process.platform, 'Linux only: run by the memory-evidence step (playwright.linux.config.ts)').toBe('linux')
  expect(readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim(), 'CI sets the core pattern first').toBe('/tmp/slate-core.%p')
  const { app, page } = await launchApp(mkdtempSync(join(tmpdir(), 'slate-e2e-')))
  const pid = await app.evaluate(() => process.pid)
  // PR_SET_DUMPABLE 0: the kernel hands /proc/<pid> to root, and RLIMIT_CORE is 0 whatever the shell set.
  expect(statSync(`/proc/${pid}/mem`).uid).toBe(0)
  expect(readFileSync(`/proc/${pid}/limits`, 'utf8')).toMatch(/^Max core file size\s+0\s+0\s+bytes/m)
  // Chromium's children started under it: the window has a live renderer.
  await expect(page.getByTestId('canvas')).toBeVisible()
  const renderer = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
  expect(renderer).toBeGreaterThan(0)
  // Review C7 L4: hardenProcess reaches main only; Linux renderers fork from the zygote before it runs. Their
  // protection (the lock window's renderer holds the typed password until Z-6 ends it) is Chromium's
  // sandbox, which makes them non-dumpable too. Assert it, so losing the sandbox fails here.
  expect(statSync(`/proc/${renderer}/mem`).uid, 'the renderer is sandboxed and non-dumpable').toBe(0)

  const exited = new Promise<string | null>((resolve) => app.process().once('exit', (_code, signal) => resolve(signal)))
  process.kill(pid, 'SIGSEGV')
  expect(await exited).toBe('SIGSEGV')
  // The kernel writes a core before the parent sees the exit; give a slow disk a moment anyway.
  await new Promise((r) => setTimeout(r, 1000))
  expect(existsSync(`/tmp/slate-core.${pid}`)).toBe(false)
})

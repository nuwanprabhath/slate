// T-ZERO-07 (audit §6.3, C7): after a lock, the main process's JavaScript heap holds no MK, LK or password
// KEK as hex or base64 text, and no password string that is still retained. What it does not prove: a heap
// snapshot holds strings, not ArrayBuffer contents, so bytes left unzeroed are invisible to it, and a
// short-lived string is collected before the snapshot. Zeroing on every exit is vaultIpc.test.ts; no text
// from a secret on the unlock path is vault/noSecretText.test.ts; the whole process memory, native heap
// included, is T-ZERO-04 (memory.linux.ts, Linux CI).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { CANARY, CANARY_ENV, CANARY_PASSWORD, writeCanaryVault } from './canaryVault'
import { expect, launchApp, test, unlockWith } from './fixtures'

interface Probes {
  gc?: () => void
  __slateHeapSnapshot?: (file: string) => string
}

/** Two full GCs, then a heap snapshot of the main process, as text. */
async function heapText(app: ElectronApplication, file: string): Promise<string> {
  const written = await app.evaluate((_electron, path) => {
    const g = globalThis as Probes
    g.gc?.()
    g.gc?.()
    return g.__slateHeapSnapshot?.(path) ?? null
  }, file)
  expect(written, 'SLATE_TEST_HEAP_SNAPSHOT=1 exposes the snapshot (memoryProbes.ts)').toBe(file)
  return readFileSync(file, 'utf8')
}

/** The text forms a key could take in a V8 heap: hex and base64 strings. */
function textForms(label: string, secret: Buffer): Array<[string, string]> {
  return [
    [`${label}/hex`, secret.toString('hex')],
    [`${label}/base64`, secret.toString('base64')],
  ]
}

const found = (text: string, needles: Array<[string, string]>) => needles.filter(([, n]) => text.includes(n)).map(([label]) => label)

test('T-ZERO-07: after lock, the main JavaScript heap holds no MK, LK, password KEK or password', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const snapshots = mkdtempSync(join(tmpdir(), 'slate-heap-'))
  const { kek } = await writeCanaryVault(userData)
  const { app, page } = await launchApp(userData, { ...CANARY_ENV, SLATE_TEST_EXPOSE_GC: '1', SLATE_TEST_HEAP_SNAPSHOT: '1' })
  try {
    const needles = [...textForms('mk', CANARY.mk), ...textForms('lk', CANARY.lk), ...textForms('kek', kek), ['password', CANARY_PASSWORD] as [string, string]]
    // The canary vault opens: the app unwrapped the keys this test chose.
    const notes = await unlockWith(app, page, CANARY_PASSWORD)
    await expect.poll(() => notes.evaluate(async () => (await window.slate.vault.status()).state), { timeout: 15_000 }).toBe('unlocked')

    // Control: a string the main process holds shows up in the snapshot, so a clean result means something.
    const control = `slate-heap-control-${Date.now().toString(36)}`
    await app.evaluate((_electron, c) => {
      ;(globalThis as { __slateControl?: string }).__slateControl = c
    }, control)
    const unlocked = await heapText(app, join(snapshots, 'unlocked.heapsnapshot'))
    expect(unlocked.includes(control)).toBe(true)
    // Keys live in the module's secure heap as handles (C4), so even while unlocked V8 holds no key as text,
    // and no password string is retained.
    expect(found(unlocked, needles)).toEqual([])

    await notes.evaluate(() => window.slate.vault.lock())
    await expect
      .poll(async () => {
        for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
        return false
      }, { timeout: 15_000 })
      .toBe(true)
    expect(found(await heapText(app, join(snapshots, 'locked.heapsnapshot')), needles)).toEqual([])
  } finally {
    await app.close()
    rmSync(snapshots, { recursive: true, force: true })
  }
})

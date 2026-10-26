// T-ZERO-04 (audit §6.3, C7): after a lock, no copy of MK, LK, the password KEK or the password is left
// anywhere in the main process's memory: V8 heap, native heap, OpenSSL's secure heap, stacks. Linux only
// (memscan.mjs reads /proc/<pid>/mem with sudo); run by playwright.linux.config.ts in CI's memory-evidence
// step, never by `npm run e2e`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { CANARY, CANARY_ENV, CANARY_PASSWORD, writeCanaryVault } from './canaryVault'
import { expect, launchApp, test, unlockWith } from './fixtures'

interface Needle {
  label: string
  bytes: Buffer
}
interface Hit {
  label: string
  address: string
  mapping: string
}

/** Every form a key could leave behind: raw bytes, hex and base64 text, and V8's two-byte strings. */
function needlesFor(label: string, secret: Buffer): Needle[] {
  const forms: Array<[string, Buffer]> = [
    ['raw', secret],
    ['hex', Buffer.from(secret.toString('hex'), 'latin1')],
    ['hex-utf16', Buffer.from(secret.toString('hex'), 'utf16le')],
    ['base64', Buffer.from(secret.toString('base64'), 'latin1')],
    ['base64-utf16', Buffer.from(secret.toString('base64'), 'utf16le')],
  ]
  return forms.map(([form, bytes]) => ({ label: `${label}/${form}`, bytes }))
}

const work = mkdtempSync(join(tmpdir(), 'slate-memscan-'))

/**
 * The evidence (audit C11 criterion 3): what each scan looked for and found, written whether the test passes or
 * not, under test-results/ so CI uploads it as an artefact. Labels and addresses only; never needle bytes.
 */
const REPORT = join(__dirname, '..', 'test-results', 'memscan', 'report.json')
const report: { test: string; platform: string; startedAt: string; mainPid?: number; scans: { phase: string; needles: string[]; hits: Hit[] }[] } = {
  test: 'T-ZERO-04',
  platform: `${process.platform}-${process.arch}`,
  startedAt: new Date().toISOString(),
  scans: [],
}
function writeReport(): void {
  mkdirSync(join(REPORT, '..'), { recursive: true })
  writeFileSync(REPORT, JSON.stringify(report, null, 2))
}

/** memscan.mjs over `pid`, as root unless this already is root. */
function scan(pid: number, needles: Needle[]): Hit[] {
  const file = join(work, `needles-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(needles.map((n) => ({ label: n.label, hex: n.bytes.toString('hex') }))))
  const cmd = [process.execPath, join(__dirname, 'memscan.mjs'), String(pid), file]
  const r = process.getuid?.() === 0 ? spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', maxBuffer: 1 << 26 }) : spawnSync('sudo', ['-n', ...cmd], { encoding: 'utf8', maxBuffer: 1 << 26 })
  expect(r.status, `memscan needs passwordless sudo: ${r.stderr}`).toBe(0)
  return JSON.parse(r.stdout) as Hit[]
}

function recorded(phase: string, pid: number, needles: Needle[]): Hit[] {
  const hits = scan(pid, needles)
  report.scans.push({ phase, needles: needles.map((n) => n.label), hits })
  writeReport()
  return hits
}

async function gcTwice(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    gc?.()
  })
}

test('T-ZERO-04: after lock, the main process holds no copy of MK, LK, the password KEK or the password', async () => {
  expect(process.platform, 'Linux only: run by the memory-evidence step (playwright.linux.config.ts)').toBe('linux')
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { kek } = await writeCanaryVault(userData)
  const { app, page } = await launchApp(userData, { ...CANARY_ENV, SLATE_TEST_EXPOSE_GC: '1' })
  try {
    const mainPid = await app.evaluate(() => process.pid)
    report.mainPid = mainPid
    const notes = await unlockWith(app, page, CANARY_PASSWORD)
    await expect.poll(() => notes.evaluate(async () => (await window.slate.vault.status()).state), { timeout: 15_000 }).toBe('unlocked')

    // Control: while unlocked the scanner must see what it looks for, or a clean result proves nothing.
    // The module's secure heap holds MK in raw form.
    const unlocked = recorded('control: unlocked', mainPid, needlesFor('mk', CANARY.mk))
    expect(unlocked.some((h) => h.label === 'mk/raw')).toBe(true)

    await notes.evaluate(() => window.slate.vault.lock())
    await expect
      .poll(async () => {
        for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
        return false
      }, { timeout: 15_000 })
      .toBe(true)
    // Two full GCs, so a reference the lock dropped is collected before the scan.
    await gcTwice(app)

    // Keys: strict. MK, LK and KEK_pw never exist outside the module's secure heap, which the lock wipes.
    expect(recorded('after lock: keys', mainPid, [...needlesFor('mk', CANARY.mk), ...needlesFor('lk', CANARY.lk), ...needlesFor('kek', kek)])).toEqual([])
    // The password, scanned apart so a hit is told from a key leak, under the same zero-hit rule. Main zeroes
    // every copy JavaScript can reach (vaultIpc.test.ts) and gives the module only moduleCopy copies: a short
    // `new Uint8Array(password)` lives on V8's heap and left an unwiped copy behind (POAM-10).
    const password = recorded('after lock: password', mainPid, [
      { label: 'password/utf8', bytes: Buffer.from(CANARY_PASSWORD, 'utf8') },
      { label: 'password/utf16', bytes: Buffer.from(CANARY_PASSWORD, 'utf16le') },
    ])
    expect(password, 'password bytes after lock (docs/compliance/poam.md POAM-10)').toEqual([])
  } finally {
    writeReport()
    await app.close()
  }
})

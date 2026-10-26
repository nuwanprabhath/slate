// U1: the maintainer's two computers, a Mac (this machine) and Ubuntu 24.04 (the container), on one git notes
// repository, through the journeys a 0.2.0 release must survive. README.md here says how to run and debug them.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Bed } from './bed'
import { macDevice, ubuntuDevice, type Device } from './devices'
import {
  bareRepo,
  changePassword,
  closeSettings,
  configureGit,
  encrypt,
  expectNote,
  join as joinVault,
  lockWindow,
  openSecurity,
  rekey,
  searchCount,
  synced,
  unlock,
  windowAfterLock,
  writeNote,
} from './flows'

const bed = JSON.parse(process.env.SLATE_XDEV_BED ?? 'null') as Bed | null
const PASSWORD = 'cross-device password one'
const NEW_PASSWORD = 'cross-device password two'

interface Pair {
  mac: Device
  ubuntu: Device
  bare: string
  repo: ReturnType<typeof bareRepo>
}

/** A fresh shared repository and two devices with empty data folders, for one scenario. */
function pair(scenario: string): Pair {
  if (!bed) throw new Error('No bed: run through e2e-ubuntu/playwright.config.ts (npm run e2e:ubuntu)')
  const dir = join(bed.shared, scenario)
  mkdirSync(dir, { recursive: true })
  const bare = join(dir, 'notes.git')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  return { mac: macDevice(dir, bare), ubuntu: ubuntuDevice(bed, scenario), bare, repo: bareRepo(bare) }
}

/** Logs how long a step took: the scenarios' timings for the report. */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    return await test.step(label, fn)
  } finally {
    console.log(`  [timing] ${test.info().title.slice(0, 2)} ${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }
}

let active: Device[] = []
test.afterEach(async ({}, info) => {
  for (const d of active) {
    if (info.status !== info.expectedStatus) console.log(`--- ${d.label} app output (tail) ---\n${(await d.log()).split('\n').slice(-60).join('\n')}`)
    await d.stop().catch(() => {})
  }
  active = []
})

function track(p: Pair): Pair {
  active = [p.mac, p.ubuntu]
  return p
}

/** Mac encrypts (by the e2e hook, at start) and syncs; Ubuntu joins with the password. Returns both notes windows. */
async function encryptedPair(p: Pair, marker: string): Promise<{ m: Page; u: Page }> {
  const lock = await p.mac.start({ version: 'current', env: { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD } })
  const m = await unlock(p.mac, lock, PASSWORD)
  await writeNote(m, marker)
  await configureGit(m, p.mac)
  await expect.poll(() => p.repo.files().includes('e2ee/vault.json'), { timeout: 60_000 }).toBe(true)
  const u = await p.ubuntu.start({ version: 'current' })
  await configureGit(u, p.ubuntu)
  await joinVault(u, PASSWORD)
  await expectNote(u, marker)
  return { m, u }
}

test('1. upgrade, plaintext: v0.1.0 on both, then the current build on the same data folders', async () => {
  const p = track(pair('s1'))
  let m = await timed('v0.1.0 on both, syncing', async () => {
    const m = await p.mac.start({ version: 'v0.1.0' })
    await writeNote(m, 'S1-MAC-OLD')
    await configureGit(m, p.mac)
    const u = await p.ubuntu.start({ version: 'v0.1.0' })
    await writeNote(u, 'S1-UBUNTU-OLD')
    await configureGit(u, p.ubuntu)
    await expectNote(m, 'S1-UBUNTU-OLD')
    await expectNote(u, 'S1-MAC-OLD')
    return m
  })
  await timed('upgrade both to the current build', async () => {
    await p.mac.stop()
    await p.ubuntu.stop()
    m = await p.mac.start({ version: 'current' })
    const u = await p.ubuntu.start({ version: 'current' })
    for (const page of [m, u]) for (const text of ['S1-MAC-OLD', 'S1-UBUNTU-OLD']) await expectNote(page, text)
    await writeNote(m, 'S1-MAC-NEW', 260, 320)
    await writeNote(u, 'S1-UBUNTU-NEW', 260, 320)
    await expectNote(u, 'S1-MAC-NEW')
    await expectNote(m, 'S1-UBUNTU-NEW')
    await synced(m)
    await synced(u)
  })
})

test('2. encryption enabled on the Mac; Ubuntu joins with the password', async () => {
  const p = track(pair('s2'))
  const { m, u } = await timed('both current, plaintext, syncing', async () => {
    const m = await p.mac.start({ version: 'current' })
    await writeNote(m, 'S2-MAC-PLAIN')
    await configureGit(m, p.mac)
    const u = await p.ubuntu.start({ version: 'current' })
    await writeNote(u, 'S2-UBUNTU-PLAIN')
    await configureGit(u, p.ubuntu)
    await expectNote(u, 'S2-MAC-PLAIN')
    await expectNote(m, 'S2-UBUNTU-PLAIN')
    return { m, u }
  })
  await timed('Mac encrypts', () => encrypt(m, PASSWORD))
  await timed('Ubuntu joins', () => joinVault(u, PASSWORD))
  for (const page of [m, u]) for (const text of ['S2-MAC-PLAIN', 'S2-UBUNTU-PLAIN']) await expectNote(page, text)
  await timed('edits both ways', async () => {
    await writeNote(m, 'S2-MAC-SEALED', 260, 320)
    await writeNote(u, 'S2-UBUNTU-SEALED', 300, 420)
    await expectNote(u, 'S2-MAC-SEALED')
    await expectNote(m, 'S2-UBUNTU-SEALED')
  })
  await synced(m)
  await synced(u)
  const contents = p.repo.contents()
  for (const text of ['S2-MAC-SEALED', 'S2-UBUNTU-SEALED']) expect(contents).not.toContain(text)
  expect(p.repo.files().every((f) => f.startsWith('e2ee/'))).toBe(true)
  expect(await p.ubuntu.readFile('slate.db')).toBeNull()
})

test('3. encryption enabled on Ubuntu; the Mac joins with the password', async () => {
  const p = track(pair('s3'))
  const u = await p.ubuntu.start({ version: 'current' })
  await writeNote(u, 'S3-UBUNTU-PLAIN')
  await configureGit(u, p.ubuntu)
  const m = await p.mac.start({ version: 'current' })
  await writeNote(m, 'S3-MAC-PLAIN')
  await configureGit(m, p.mac)
  await expectNote(m, 'S3-UBUNTU-PLAIN')
  await timed('Ubuntu encrypts', () => encrypt(u, PASSWORD))
  await timed('Mac joins', () => joinVault(m, PASSWORD))
  for (const page of [m, u]) for (const text of ['S3-MAC-PLAIN', 'S3-UBUNTU-PLAIN']) await expectNote(page, text)
  await writeNote(u, 'S3-UBUNTU-SEALED', 260, 320)
  await writeNote(m, 'S3-MAC-SEALED', 300, 420)
  await expectNote(m, 'S3-UBUNTU-SEALED')
  await expectNote(u, 'S3-MAC-SEALED')
  await synced(m)
  await synced(u)
  const contents = p.repo.contents()
  for (const text of ['S3-MAC-SEALED', 'S3-UBUNTU-SEALED']) expect(contents).not.toContain(text)
  expect(p.repo.files().every((f) => f.startsWith('e2ee/'))).toBe(true)
})

test('4. mixed versions: the Mac encrypts while Ubuntu still runs v0.1.0; nothing is lost, then Ubuntu upgrades and joins', async () => {
  const p = track(pair('s4'))
  const m = await p.mac.start({ version: 'current' })
  await writeNote(m, 'S4-MAC-PLAIN')
  await configureGit(m, p.mac)
  let u = await p.ubuntu.start({ version: 'v0.1.0' })
  await writeNote(u, 'S4-UBUNTU-OLD')
  await configureGit(u, p.ubuntu)
  await expectNote(m, 'S4-UBUNTU-OLD')
  await timed('Mac encrypts', () => encrypt(m, PASSWORD))
  const header = p.repo.git('show', 'main:e2ee/vault.json')

  await timed('v0.1.0 keeps syncing against the encrypted folder', async () => {
    await writeNote(u, 'S4-UBUNTU-AFTER', 260, 320)
    // v0.1.0 cannot read encrypted notes: what it had stays, and it does not take the Mac's vault apart.
    await expect.poll(() => p.repo.git('log', '-1', '--format=%H', 'main'), { timeout: 60_000 }).not.toBe('')
    await expect(m.getByTestId('vault-plaintext-warning')).toBeVisible({ timeout: 90_000 })
    expect(p.repo.git('show', 'main:e2ee/vault.json')).toBe(header)
    expect(await searchCount(u, 'S4-UBUNTU-OLD')).toBeGreaterThan(0)
  })
  // The Mac's notes are intact under encryption after a restart.
  await p.mac.stop()
  const mac2 = await unlock(p.mac, await p.mac.start({ version: 'current' }), PASSWORD)
  for (const text of ['S4-MAC-PLAIN', 'S4-UBUNTU-OLD']) await expectNote(mac2, text)

  await timed('Ubuntu upgrades and joins', async () => {
    await p.ubuntu.stop()
    u = await p.ubuntu.start({ version: 'current' })
    await joinVault(u, PASSWORD)
  })
  for (const text of ['S4-MAC-PLAIN', 'S4-UBUNTU-OLD', 'S4-UBUNTU-AFTER']) await expectNote(u, text)
  await expectNote(mac2, 'S4-UBUNTU-AFTER')
  await writeNote(u, 'S4-UBUNTU-SEALED', 300, 420)
  await expectNote(mac2, 'S4-UBUNTU-SEALED')
  await synced(u)
  expect(p.repo.files().every((f) => f.startsWith('e2ee/'))).toBe(true)
  expect(bareRepo(p.bare).git('show', 'main:e2ee/vault.json')).not.toContain('S4-')
})

test('5. a password changed on the Mac unlocks Ubuntu after a sync, live and after a restart', async () => {
  const p = track(pair('s5'))
  const { m, u } = await timed('encrypted pair', () => encryptedPair(p, 'S5-NOTE'))
  await timed('Mac changes the password', () => changePassword(m, PASSWORD, NEW_PASSWORD))
  await timed('Ubuntu locks and unlocks with the new password', async () => {
    await expect.poll(async () => (await p.ubuntu.readFile('vault.pending.json')) !== null, { timeout: 60_000 }).toBe(true)
    await u.evaluate(() => window.slate.vault.lock())
    const lock = await lockWindow(p.ubuntu)
    const again = await unlock(p.ubuntu, lock, NEW_PASSWORD)
    await expectNote(again, 'S5-NOTE')
  })
  await timed('both restart; the old password no longer opens either', async () => {
    for (const d of [p.mac, p.ubuntu]) {
      await d.stop()
      const lock = await d.start({ version: 'current' })
      await lock.getByTestId('lock-secret').fill(PASSWORD)
      await lock.getByTestId('lock-unlock').click()
      await expect(lock.getByTestId('lock-error')).toHaveText("That password didn't work", { timeout: 60_000 })
      await expectNote(await unlock(d, lock, NEW_PASSWORD), 'S5-NOTE')
    }
  })
})

test('6. lock and unlock; quick unlock on Ubuntu with gnome-keyring, and unavailable without a keyring', async () => {
  const p = track(pair('s6'))
  const { m, u } = await timed('encrypted pair', () => encryptedPair(p, 'S6-NOTE'))
  await timed('Mac locks and unlocks with the password', async () => {
    await m.evaluate(() => window.slate.vault.lock())
    await expectNote(await unlock(p.mac, await lockWindow(p.mac), PASSWORD), 'S6-NOTE')
  })
  await timed('Ubuntu turns on keyring unlock', async () => {
    await openSecurity(u)
    const row = u.getByTestId('quick-unlock-row')
    await expect(row).toContainText('Unlock with the system keyring')
    await u.getByTestId('quick-unlock-toggle').check()
    await u.getByTestId('quick-unlock-password').fill(PASSWORD)
    await row.getByRole('button', { name: 'Turn on' }).click()
    await expect(u.getByTestId('quick-unlock-forget')).toBeVisible({ timeout: 30_000 })
    await closeSettings(u)
  })
  await timed('Ubuntu locks and unlocks from the keyring, live and after a restart', async () => {
    await u.evaluate(() => window.slate.vault.lock())
    let lock = await lockWindow(p.ubuntu)
    await lock.getByTestId('lock-quick-unlock').click()
    await expectNote(await windowAfterLock(p.ubuntu, lock), 'S6-NOTE')
    await p.ubuntu.stop()
    lock = await p.ubuntu.start({ version: 'current' })
    await expect(lock.getByTestId('lock-quick-unlock')).toBeVisible()
    await lock.getByTestId('lock-quick-unlock').click()
    await expectNote(await windowAfterLock(p.ubuntu, lock), 'S6-NOTE')
  })
  await timed('Ubuntu without a keyring: no quick unlock, the password works', async () => {
    await p.ubuntu.stop()
    const lock = await p.ubuntu.start({ version: 'current', keyring: false })
    await expect(lock.getByTestId('lock-screen')).toBeVisible()
    await expect(lock.getByTestId('lock-quick-unlock')).toHaveCount(0)
    const notes = await unlock(p.ubuntu, lock, PASSWORD)
    await expectNote(notes, 'S6-NOTE')
    await openSecurity(notes)
    await expect(notes.getByTestId('quick-unlock-row')).toContainText('Not available on this computer')
  })
})

/** C4's v1 vault (suite 0x01, header v1), written by the pre-C4 build: the only way a v1 vault exists today. */
const C4 = join(__dirname, '..', 'src', 'main', 'vault', 'fixtures', 'c4')
const C4_PASSWORD = (JSON.parse(readFileSync(join(C4, 'manifest.json'), 'utf8')) as { password: string }).password

test('7. a v1 vault upgraded to v2 on the Mac and rotated on Ubuntu; the other device follows each time', async () => {
  const p = track(pair('s7'))
  const macData = join(bed!.shared, 's7', 'mac-data')
  mkdirSync(macData, { recursive: true })
  for (const f of ['vault.json', 'local-keys.json', 'preunlock.json', 'slate-e6be7b8b.db']) cpSync(join(C4, 'data', f), join(macData, f))
  let m = await unlock(p.mac, await p.mac.start({ version: 'current' }), C4_PASSWORD)
  await writeNote(m, 'S7-MAC-V1')
  await configureGit(m, p.mac)
  await expect.poll(() => p.repo.files().includes('e2ee/vault.json'), { timeout: 60_000 }).toBe(true)
  expect(p.repo.header().version).toBe(1)
  let u = await p.ubuntu.start({ version: 'current' })
  await configureGit(u, p.ubuntu)
  await timed('Ubuntu joins the v1 vault', () => joinVault(u, C4_PASSWORD))
  await expectNote(u, 'S7-MAC-V1')

  await timed('Mac upgrades v1 to v2', async () => {
    await rekey(m, 'upgrade', C4_PASSWORD)
    await expect.poll(() => p.repo.header().version, { timeout: 120_000 }).toBe(2)
    await expectNote(m, 'S7-MAC-V1')
  })
  await timed('Ubuntu follows the upgrade', async () => {
    await expect(u.getByTestId('vault-join-banner')).toContainText('keys were changed', { timeout: 90_000 })
    await u.evaluate(() => window.slate.vault.lock())
    u = await unlock(p.ubuntu, await lockWindow(p.ubuntu), C4_PASSWORD)
    await expect.poll(async () => (JSON.parse((await p.ubuntu.readFile('vault.json')) ?? '{}') as { version?: number }).version, { timeout: 60_000 }).toBe(2)
    await expectNote(u, 'S7-MAC-V1')
  })
  await timed('Ubuntu rotates the keys', async () => {
    const epoch = p.repo.header().keyEpoch
    await closeSettings(m).catch(() => {})
    await rekey(u, 'rotate', C4_PASSWORD)
    await expect.poll(() => p.repo.header().keyEpoch, { timeout: 120_000 }).toBe(epoch + 1)
  })
  await timed('the Mac follows the rotation', async () => {
    await expect(m.getByTestId('vault-join-banner')).toContainText('keys were changed', { timeout: 90_000 })
    await m.evaluate(() => window.slate.vault.lock())
    m = await unlock(p.mac, await lockWindow(p.mac), C4_PASSWORD)
    await writeNote(m, 'S7-MAC-AFTER-ROTATION', 260, 320)
    await expectNote(u, 'S7-MAC-AFTER-ROTATION')
  })
})

test('8. restarts between steps, and a device that was offline catches up', async () => {
  const p = track(pair('s8'))
  let { m, u } = await timed('encrypted pair', () => encryptedPair(p, 'S8-START'))
  await timed('Ubuntu goes offline (quit); the Mac writes and restarts', async () => {
    await p.ubuntu.stop()
    await writeNote(m, 'S8-MAC-WHILE-UBUNTU-OFF', 260, 320)
    await synced(m)
    await p.mac.stop()
    m = await unlock(p.mac, await p.mac.start({ version: 'current' }), PASSWORD)
    await writeNote(m, 'S8-MAC-AFTER-RESTART', 300, 420)
    await synced(m)
  })
  await timed('Ubuntu comes back and catches up', async () => {
    u = await unlock(p.ubuntu, await p.ubuntu.start({ version: 'current' }), PASSWORD)
    for (const text of ['S8-START', 'S8-MAC-WHILE-UBUNTU-OFF', 'S8-MAC-AFTER-RESTART']) await expectNote(u, text)
  })
  await timed('the Mac quits; Ubuntu writes and restarts; the Mac catches up', async () => {
    await p.mac.stop()
    await writeNote(u, 'S8-UBUNTU-WHILE-MAC-OFF', 340, 200)
    await synced(u)
    await p.ubuntu.stop()
    u = await unlock(p.ubuntu, await p.ubuntu.start({ version: 'current' }), PASSWORD)
    m = await unlock(p.mac, await p.mac.start({ version: 'current' }), PASSWORD)
    await expectNote(m, 'S8-UBUNTU-WHILE-MAC-OFF')
  })
  await timed('both offline-edit the same page, then merge', async () => {
    await p.ubuntu.stop()
    await writeNote(m, 'S8-CONCURRENT-MAC', 200, 500)
    await synced(m)
    await p.mac.stop()
    u = await unlock(p.ubuntu, await p.ubuntu.start({ version: 'current' }), PASSWORD)
    await writeNote(u, 'S8-CONCURRENT-UBUNTU', 420, 500)
    m = await unlock(p.mac, await p.mac.start({ version: 'current' }), PASSWORD)
    for (const page of [m, u]) for (const text of ['S8-CONCURRENT-MAC', 'S8-CONCURRENT-UBUNTU']) await expectNote(page, text)
  })
})

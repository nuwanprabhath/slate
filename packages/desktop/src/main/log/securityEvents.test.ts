import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { changePassword, proveSecret } from '../vault/header'
import { createEncryptedDataDir } from '../vault/testVault'
import { UnlockFailed, unlockVault } from '../vault/unlock'
import { log, securityLog } from './logger'
import { originOf, securityEvent } from './securityEvents'

const weak = { allowWeakForTests: true }
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-events-'))
  log.configure({ enabled: true, dir: join(dir, 'logs'), maxSizeMb: 5 })
})
afterAll(() => log.configure({ enabled: false, dir: '', maxSizeMb: 5 }))

const lines = (): string[] => log.read().split('\n').filter(Boolean)
const fieldsOf = (event: string): string[] => {
  const line = lines().filter((l) => l.includes(` ${event}`)).pop() ?? ''
  const json = line.slice(line.indexOf('{'))
  return json.startsWith('{') ? Object.keys(JSON.parse(json) as object).sort() : []
}

describe('security log (review C10): events are kept whether or not the diagnostic log is on', () => {
  it('writes to its own small rotating log with the diagnostic log off, and never a field the emitter did not name', () => {
    const secDir = mkdtempSync(join(tmpdir(), 'slate-seclog-'))
    securityLog.configure({ enabled: true, dir: secDir, maxSizeMb: 1 })
    log.configure({ enabled: false, dir: '', maxSizeMb: 5 })
    securityEvent.unlockFailed({ method: 'quick', failures: 1 })
    securityEvent.locked({ trigger: 'quit', destroyedHandles: 3 })
    const text = securityLog.read()
    expect(text).toContain('vault.unlock.failed')
    expect(text).toContain('"method":"quick"')
    expect(text).toContain('vault.locked')
    expect(log.read()).toBe('')
    securityLog.configure({ enabled: false, dir: '', maxSizeMb: 1 })
    log.configure({ enabled: true, dir: join(dir, 'logs'), maxSizeMb: 5 })
  })
})

describe('security audit events (audit §4.8)', () => {
  it('each event writes the fields §4.8 lists, and no others', () => {
    securityEvent.selftestPassed({ ran: 17, ms: 4, fips: true })
    securityEvent.selftestFailed({ failed: ['POST-AES-GCM'], fips: false, phase: 'startup' })
    securityEvent.moduleDegraded({ secureHeapLocked: false })
    securityEvent.unlockSucceeded({ method: 'password', headerRevision: 3 })
    securityEvent.unlockFailed({ method: 'recovery', failures: 2 })
    securityEvent.unlockThrottled({ retryAt: 1_700_000_000_000, refusals: 1 })
    securityEvent.locked({ trigger: 'idle', destroyedHandles: 9 })
    securityEvent.headerAdopted({ fromRevision: 1, toRevision: 2 })
    securityEvent.headerRefused({ reason: 'downgrade' })
    securityEvent.headerUpgraded({ fromRevision: 2, toRevision: 3 })
    securityEvent.headerUpgradeWaiting({ devices: 1 })
    securityEvent.passwordChanged({ revision: 4 })
    securityEvent.recoveryRotated({ revision: 5 })
    securityEvent.keyRotated({ fromEpoch: 1, toEpoch: 2 })
    securityEvent.keyRotationDue({ dueSince: 1_700_000_000_000 })
    securityEvent.profileChanged({ from: 'standard', to: 'fips-140-3' })
    securityEvent.preunlockTampered()
    securityEvent.syncUnverifiable({ count: 2 })
    securityEvent.updateSignatureFailed({ version: '1.2.3' })
    securityEvent.ipcUntrustedSender({ channel: 'vaultUnlock', origin: originOf('https://evil.invalid/a/b?q=1#x') })
    const want: Record<string, string[]> = {
      'selftest.passed': ['fips', 'ms', 'ran'],
      'selftest.failed': ['failed', 'fips', 'phase'],
      'module.degraded': ['secureHeapLocked'],
      'vault.unlock.succeeded': ['headerRevision', 'method'],
      'vault.unlock.failed': ['failures', 'method'],
      'vault.unlock.throttled': ['refusals', 'retryAt'],
      'vault.locked': ['destroyedHandles', 'trigger'],
      'vault.header.adopted': ['fromRevision', 'toRevision'],
      'vault.header.refused': ['reason'],
      'vault.header.upgraded': ['fromRevision', 'toRevision'],
      'vault.header.upgrade-waiting': ['devices'],
      'vault.password.changed': ['revision'],
      'vault.recovery.rotated': ['revision'],
      'vault.key.rotated': ['fromEpoch', 'toEpoch'],
      'vault.key.rotation-due': ['dueSince'],
      'vault.profile.changed': ['from', 'to'],
      'vault.preunlock.tampered': [],
      'sync.unverifiable': ['count'],
      'update.signature.failed': ['version'],
      'ipc.untrusted-sender': ['channel', 'origin'],
    }
    for (const [event, fields] of Object.entries(want)) expect(fieldsOf(event), event).toEqual(fields)
    expect(lines().join('\n')).toContain('"origin":"https://evil.invalid"')
    expect(lines().join('\n')).not.toContain('/a/b')
  })

  it('a canary password and recovery key never reach the log through unlock, header adoption and lock', async () => {
    const PASSWORD = 'CANARY-pw-9f2c4e71 horse staple'
    const NEXT = 'CANARY-next-5d8a1b03 horse staple'
    const data = mkdtempSync(join(tmpdir(), 'slate-events-data-'))
    const { header, mk, recoveryKey } = await createEncryptedDataDir(data, secretBytes(PASSWORD), weak)
    // Wrong password and wrong recovery key: failures are logged without their secrets.
    await expect(unlockVault(data, { password: secretBytes('CANARY-wrong-3c3c3c3c') }, weak)).rejects.toThrow(UnlockFailed)
    await expect(unlockVault(data, { recoveryKey: secretBytes('CANARY-RK0-WRONG') }, weak)).rejects.toThrow(UnlockFailed)
    // A password changed elsewhere: the pending header is adopted at the next unlock (vault.header.adopted).
    const pending = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(PASSWORD) }, weak), secretBytes(NEXT), weak)
    writeFileSync(join(data, 'vault.pending.json'), JSON.stringify(pending))
    const adopted = await unlockVault(data, { password: secretBytes(NEXT) }, weak)
    expect(adopted.passwordChanged).toBe(true)
    securityEvent.unlockSucceeded({ method: 'password', headerRevision: adopted.headerRevision })
    const recovered = await unlockVault(data, { recoveryKey: secretBytes(recoveryKey) }, weak)
    securityEvent.locked({ trigger: 'manual', destroyedHandles: 0 })
    adopted.keyRing.close()
    recovered.keyRing.close()
    const text = log.read()
    expect(text).toContain('vault.unlock.succeeded')
    expect(text).toContain('vault.header.adopted')
    const canaries = [PASSWORD, NEXT, 'CANARY', 'wrong-3c3c', recoveryKey, recoveryKey.toLowerCase(), recoveryKey.replace(/-/g, ''), Buffer.from(PASSWORD).toString('base64'), Buffer.from(PASSWORD).toString('hex')]
    for (const c of canaries) expect(text, c).not.toContain(c)
  })
})

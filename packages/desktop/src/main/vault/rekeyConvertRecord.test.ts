// Review C9 H1, the conversion: cut short after its remote write, the device is unlocked with the OLD password (the new
// one opens only the fips header, whose empty history holds none of this device's keys). The record must survive that,
// and carry on once the device follows with the new password. Its own file: following latches the module (C5).
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { nodeGitRunner } from '@slate/sync'
import { secretBytes } from '../../shared/secret'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import type { KeyRing } from './keyring'
import { Migration, readRekeyRecord, type MigrationDeps } from './migration'
import { GitVaultRemote } from './remoteVault'
import { expectNotesSurviveCrash, notesUnder, storeWithLk } from './testVault'
import { UnlockFailed, unlockVault } from './unlock'

vi.setConfig({ testTimeout: 60_000 })
const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery staple'
const FIPS_PASSWORD = 'a fifteen-plus character passphrase'
const PAGE = `page:${randomUUID()}`

describe('review C9 H1: a conversion cut short after its remote write', () => {
  it('keeps its record through an unlock with the old password, and resumes once the device follows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-convert-record-'))
    const dataDir = join(dir, 'data')
    const bare = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
    const remote = new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, 'vr'), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
    const opened: Array<{ ring: KeyRing; store: DocStore }> = []
    let supersedeOk = false
    let cleared = 0
    const deps = (crashAt?: 'close'): MigrationDeps => ({
      dataDir,
      kdfOpts: weak,
      kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
      remote: () => remote,
      closeServices: async () => {},
      reopenPlaintext: () => {},
      openServices: (keyRing, dbFile) => {
        const store = storeWithLk(keyRing, dbFile)
        opened.push({ ring: keyRing, store })
        return { store }
      },
      supersede: async () => supersedeOk,
      clearSuperseded: async () => {
        cleared++
      },
      ...(crashAt ? { crashAt } : {}),
    })
    const settle = () => opened.splice(0).forEach((o) => o.store.close())
    mkdirSync(dataDir, { recursive: true })
    const plain = new DocStore(join(dataDir, 'slate.db'))
    const doc = new LoroDoc()
    doc.getText('t').insert(0, 'SECRET-NOTE')
    plain.append(PAGE, doc.export({ mode: 'update' }))
    writeSettings(plain, { deviceId: randomUUID() })
    plain.close()
    const wizard = new Migration(deps())
    const p = await wizard.prepare(secretBytes(PASSWORD))
    if (p.kind !== 'recovery') throw new Error('expected a new vault')
    await wizard.confirmRecovery(secretBytes(p.recoveryKey))
    await wizard.run()
    settle()
    const first = opened.length === 0 ? (await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)).keyRing : opened[0]!.ring
    const notes = (await notesUnder(dataDir, () => ({ password: secretBytes(PASSWORD) }), weak))!
    const m = new Migration(deps('close'))
    const { recoveryKey } = await m.prepareRekey(first, 'convert', secretBytes(PASSWORD), secretBytes(FIPS_PASSWORD))
    await m.confirmRecovery(secretBytes(recoveryKey))
    // Review C9 M2: no conversion without one complete pull under the old keys first; nothing changed then.
    await expect(m.runRekey(first)).rejects.toThrow(/Sync must finish/)
    expect(await readRekeyRecord(dataDir)).toBeNull()
    // Review C9 L4: the aborted conversion's superseded list goes with it.
    expect(cleared).toBe(1)
    supersedeOk = true
    await expect(m.runRekey(first)).rejects.toThrow('Injected crash before close')
    first.close()
    await expectNotesSurviveCrash(dataDir, {
      old: { label: 'old password', secret: () => ({ password: secretBytes(PASSWORD) }) },
      next: [
        { label: 'new password', secret: () => ({ password: secretBytes(FIPS_PASSWORD) }) },
        { label: 'new recovery key', secret: () => ({ recoveryKey: secretBytes(recoveryKey) }) },
      ],
      notes,
      opts: weak,
    })

    const runner = new Migration(deps())
    const u = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    expect(u.adopt).toMatchObject({ profile: 'fips-140-3' })
    // The old password does not open the converted header: the follow fails, and the record must stay.
    await expect(runner.rejoin(u.keyRing, { password: secretBytes(PASSWORD) }, u.adopt)).rejects.toThrow(UnlockFailed)
    expect((await runner.resumeRekeyAtUnlock(u.keyRing))?.step).toBe('committed')
    expect((await readRekeyRecord(dataDir))?.step).toBe('committed')
    // From the banner, with the new password: the device follows and the record moves on to the re-push.
    const next = await runner.rejoin(u.keyRing, { password: secretBytes(FIPS_PASSWORD) })
    settle()
    expect((await runner.resumeRekeyAtUnlock(next))?.step).toBe('repush')
    next.close()
  })
})

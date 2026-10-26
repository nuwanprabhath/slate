// Criterion 4 (audit §7.3 C6, S-2): no openDatabase or openServices while the vault is in `selftest` (or after
// the self-test failed). index.ts registers its state machine with gateNotesOnSelfTest before anything else.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gateNotesOnSelfTest, NotesBeforeSelfTest } from '../../db/dbModule'
import { openDatabase } from '../../db/openDatabase'
import { openServices, servicesOpen, closeServices } from '../../services'
import { VaultStateMachine } from '../vaultState'

afterEach(() => {
  gateNotesOnSelfTest(null)
  if (servicesOpen()) closeServices()
})

const ctx = (dataDir: string) => ({
  dataDir,
  emit: () => {},
  checkVault: async () => {},
  sync: { appVersion: '0', auth: { status: async () => ({}), signIn: async () => {}, signOut: async () => {}, token: async () => '' }, graphUrl: 'http://127.0.0.1:1', gitDir: join(dataDir, 'git'), secrets: {}, log: { info: () => {}, warn: () => {}, error: () => {} } },
  importer: {},
  watchLog: { info: () => {}, warn: () => {}, error: () => {} },
})

describe('criterion 4: notes never open before the power-up self-test passed', () => {
  it('openDatabase and openServices throw while the state is selftest, and again after it failed', () => {
    const vault = new VaultStateMachine()
    gateNotesOnSelfTest(() => vault.state)
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    expect(() => openDatabase(join(dir, 'slate.db'), null)).toThrow(NotesBeforeSelfTest)
    expect(() => openServices(null, join(dir, 'slate.db'), ctx(dir) as never)).toThrow(NotesBeforeSelfTest)
    vault.fail()
    expect(() => openDatabase(join(dir, 'slate.db'), null)).toThrow(/selftest-failed/)
    expect(servicesOpen()).toBe(false)
  })

  it('once the self-test handed over (plaintext here), the database opens', () => {
    const vault = new VaultStateMachine()
    gateNotesOnSelfTest(() => vault.state)
    vault.to('plaintext')
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    const db = openDatabase(join(dir, 'slate.db'), null)
    expect(db.open).toBe(true)
    db.close()
  })
})

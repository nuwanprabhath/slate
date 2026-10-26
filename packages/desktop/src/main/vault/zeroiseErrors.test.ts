import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { isLive as isLiveKey, liveHandles } from '../../../test/vaultKeys'
import { WrongKey } from '../db/openDatabase'
import { openServices, type ServiceContext } from '../services'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import { proveSecret, changePassword, createVault } from './header'
import { Migration, type MigrationDeps } from './migration'
import { createEncryptedDataDir } from './testVault'
import { LOCAL_KEYS_FILE, PENDING_FILE, REJOIN_KEYS_FILE, REJOIN_VAULT_FILE, unlockVault, VAULT_FILE } from './unlock'
import { secretBytes } from '../../shared/secret'

/**
 * T-ZERO-01 on the error paths (review phase11-c1, MEDIUM; native variant, C4): a key a function owns is
 * destroyed in the module when a later step throws, not only on the way out of a success. Keys are
 * recorded where they are made (MK from an unwrap, LK from local keys), then the step after is made to fail.
 */
const rec = vi.hoisted(() => ({ keys: [] as number[], failWrite: null as null | ((path: string) => boolean) }))

vi.mock('./atomic', async (importOriginal) => {
  const real = await importOriginal<typeof import('./atomic')>()
  return {
    ...real,
    writeJsonAtomic: async (path: string, value: unknown) => {
      if (rec.failWrite?.(path)) throw new Error(`injected write failure: ${path}`)
      return real.writeJsonAtomic(path, value)
    },
  }
})

vi.mock('./header', async (importOriginal) => {
  const real = await importOriginal<typeof import('./header')>()
  return {
    ...real,
    unlockWithPassword: async (...a: Parameters<typeof real.unlockWithPassword>) => {
      const mk = await real.unlockWithPassword(...a)
      rec.keys.push(mk)
      return mk
    },
  }
})

vi.mock('./localKeys', async (importOriginal) => {
  const real = await importOriginal<typeof import('./localKeys')>()
  return {
    ...real,
    readLocalKeys: (...a: Parameters<typeof real.readLocalKeys>) => {
      const out = real.readLocalKeys(...a)
      rec.keys.push(out.lk)
      return out
    },
    createLocalKeys: (...a: Parameters<typeof real.createLocalKeys>) => {
      const out = real.createLocalKeys(...a)
      rec.keys.push(out.lk)
      return out
    },
  }
})

const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery'
const tmp = () => mkdtempSync(join(tmpdir(), 'slate-zero-err-'))

const isLive = (h: number): boolean => isLiveKey(h as KeyHandle)

/** Runs `op` (which must throw) with an empty record, then returns how many recorded keys are still live. */
async function leftAfterThrow(op: () => Promise<unknown>): Promise<number> {
  rec.keys.length = 0
  await expect(op()).rejects.toThrow()
  expect(rec.keys.length).toBeGreaterThan(0)
  return rec.keys.filter(isLive).length
}

afterEach(() => {
  rec.failWrite = null
  rec.keys.length = 0
  vi.restoreAllMocks()
})

describe('T-ZERO-01: keys are zeroed when a later step throws', () => {
  it('T-ZERO-01: unlockVault destroys MK when adopting the pending header fails to write (unlock.ts)', async () => {
    const dir = tmp()
    const { header, mk } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const pending = await changePassword(header, mk, await proveSecret(header, { password: secretBytes(PASSWORD) }, weak), secretBytes('a newer password'), weak)
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify(pending))
    rec.failWrite = (p) => p.endsWith(`/${VAULT_FILE}`)
    expect(await leftAfterThrow(() => unlockVault(dir, { password: secretBytes('a newer password') }, weak))).toBe(0)
  })

  it('T-ZERO-01: unlockVault destroys MK and LK when discarding a stale rejoin fails (unlock.ts)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    // rm without `recursive` cannot remove a folder, so the clean-up throws after LK is unwrapped.
    mkdirSync(join(dir, REJOIN_VAULT_FILE))
    writeFileSync(join(dir, REJOIN_KEYS_FILE), '{}')
    expect(await leftAfterThrow(() => unlockVault(dir, { password: secretBytes(PASSWORD) }, weak))).toBe(0)
  })

  it('T-ZERO-01: openServices takes no LK of its own when the database refuses the key (services.ts, WrongKey)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const { keyRing } = await unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)
    const plain = new DocStore(join(dir, 'slate.db'))
    plain.close()
    const before = liveHandles()
    const ctx = { dataDir: dir, emit: () => {} } as unknown as ServiceContext
    expect(() => openServices(keyRing, join(dir, 'slate.db'), ctx)).toThrow(WrongKey)
    expect(liveHandles()).toBe(before)
    // The ring's LK is untouched: it still holds all eight keys, and destroys them at close.
    // A header-v2 vault (C5): MK, LK and seven suite-0x02 subkeys, K_name_mac included.
    expect(keyRing.close()).toBe(9)
  })

  it('T-ZERO-01: Migration destroys MK and the new LK when writing local-keys.json fails at the switch (migration.ts)', async () => {
    const dir = tmp()
    const store = new DocStore(join(dir, 'slate.db'))
    const doc = new LoroDoc()
    doc.getText('t').insert(0, 'note')
    store.append('page:00000000-0000-4000-8000-000000000001', doc.export({ mode: 'update' }))
    writeSettings(store, { deviceId: randomUUID() })
    store.close()
    mkdirSync(join(dir, 'blobs'))
    const deps = {
      dataDir: dir,
      kdfOpts: weak,
      kdf: { memoryKiB: 64, passes: 1 },
      remote: () => null,
      closeServices: async () => {},
      reopenPlaintext: () => {},
      openServices: () => ({ store: new DocStore(join(dir, 'unused.db')) }),
      tempDir: join(dir, 'tmp'),
    } as unknown as MigrationDeps
    const m = new Migration(deps)
    const prepared = await m.prepare(secretBytes(PASSWORD))
    if (prepared.kind !== 'recovery') throw new Error(`expected a recovery key, got ${prepared.kind}`)
    expect(await m.confirmRecovery(secretBytes(prepared.recoveryKey))).toBe(true)
    rec.failWrite = (p) => p.endsWith(`/${LOCAL_KEYS_FILE}`)
    expect(await leftAfterThrow(() => m.run())).toBe(0)
  })

  it('Migration.join with a { mk } secret never takes or destroys the caller\'s MK (migration.ts openMk)', async () => {
    const { header, mk } = await createVault({ password: secretBytes(PASSWORD), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    const remote = { read: async () => ({ header, version: null, otherFiles: [] }) }
    const deps = { dataDir: tmp(), kdfOpts: weak, remote: () => remote } as unknown as MigrationDeps
    // C4: a migration takes a password or a recovery key only (MigrationSecret); a handle is not a secret.
    await new Migration(deps).join({ mk } as never).catch(() => {})
    expect(isLive(mk)).toBe(true)
  })

  it('review C4 L4: createEncryptedDataDir destroys MK, LK and K_prefs when a later step throws (testVault.ts)', async () => {
    const dir = tmp()
    new DocStore(join(dir, 'slate.db')).close()
    // A file where the blobs folder goes makes the copy step throw after the vault and LK exist.
    writeFileSync(join(dir, 'blobs'), 'not a folder')
    const before = liveHandles()
    await expect(createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)).rejects.toThrow()
    expect(liveHandles()).toBe(before)
  })

  it('T-ZERO-01 (C1 re-review): a staged rejoin whose swap fails destroys the staged LK (unlock.ts openLocalKeys)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    // The staged pair opens with this password; the live local-keys.json is a folder, so it does not, and
    // renaming the staged file over it throws after the staged LK is unwrapped.
    renameSync(join(dir, LOCAL_KEYS_FILE), join(dir, REJOIN_KEYS_FILE))
    mkdirSync(join(dir, LOCAL_KEYS_FILE))
    writeFileSync(join(dir, LOCAL_KEYS_FILE, 'x'), '')
    expect(await leftAfterThrow(() => unlockVault(dir, { password: secretBytes(PASSWORD) }, weak))).toBe(0)
  })
})

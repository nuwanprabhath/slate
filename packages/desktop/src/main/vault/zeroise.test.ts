import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isApprovedKey, type KeyHandle } from '@slate/native'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { dbKeyMatches, importKey, liveHandles, masterKeyMatches, sameDbKey, sameMaster } from '../../../test/vaultKeys'
import { openEnvelope, sealEnvelope, type EnvelopeKeys } from './envelope'
import { PROFILES } from './profile'
import { SCHEDULE_V1, SUITE } from './suite'
import { deriveKek } from './kdf'
import { proveSecret, changePassword, createVault, newRecoveryKey, unlockWithPassword, unlockWithRecovery, verifyCheck } from './header'
import { deriveSubkey, KeyRing } from './keyring'
import { createLocalKeys, readLocalKeys } from './localKeys'
import { Migration, type MigrationDeps } from './migration'
import { destroyKey, vaultNative } from './native'
import { checkPreunlock, savePreunlock } from './preunlockSync'
import { createEncryptedDataDir } from './testVault'
import { secretBytes } from '../../shared/secret'

/**
 * T-ZERO-01, native variant (audit §6.3, C4): every key a vault function derives or unwraps for its own
 * use lives in the module and is destroyed before the function returns (sites Z-a…Z-k of F-FIPS-06).
 * The module counts live handles, so after each call exactly the handles handed to the caller remain;
 * no key byte ever reaches JavaScript to need zeroing.
 */
const weak = { allowWeakForTests: true }
const kdf = { memoryKiB: 64, passes: 1 }
const env = (syncKey: KeyHandle): EnvelopeKeys => ({ syncKey, suite: SUITE.KBKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites })

/** Runs `op` and returns how many handles it left live beyond the `owned` ones it handed to the caller. */
async function leftovers(op: () => unknown, owned = 0): Promise<number> {
  const before = liveHandles()
  await op()
  return liveHandles() - before - owned
}

describe('T-ZERO-01 (native variant): derived and unwrapped keys are destroyed', () => {
  it('T-ZERO-01 Z-a/Z-b/Z-c: createVault destroys K_check, KEK_pw and KEK_rc, and wipes the recovery secret', async () => {
    let mk: KeyHandle | undefined
    expect(await leftovers(async () => ({ mk } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)), 1)).toBe(0)
    destroyKey(mk)
  })

  it('T-ZERO-01 Z-a/Z-d: unlockWithPassword destroys KEK_pw and K_check, and returns MK to the caller', async () => {
    const { header, mk: made } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)
    let mk: KeyHandle | undefined
    expect(await leftovers(async () => (mk = await unlockWithPassword(header, secretBytes('correct horse'), weak)), 1)).toBe(0)
    // MK is a handle into the module's secure heap, never bytes (criterion 4).
    expect(typeof mk).toBe('number')
    expect(sameMaster(mk!, made)).toBe(true)
    // A wrong password destroys the same keys (and the random stand-in MK).
    expect(await leftovers(() => unlockWithPassword(header, secretBytes('wrong horse'), weak).catch(() => null))).toBe(0)
  })

  it('T-ZERO-01 Z-e: unlockWithRecovery destroys KEK_rc', async () => {
    const { header, recoveryKey } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)
    expect(await leftovers(() => destroyKey(unlockWithRecovery(header, secretBytes(recoveryKey!))))).toBe(0)
    expect(await leftovers(() => (() => { try { unlockWithRecovery(header, secretBytes('AAAA-BBBB')) } catch { /* expected */ } })())).toBe(0)
  })

  it('T-ZERO-01 Z-f: changePassword destroys the new KEK_pw', async () => {
    const { header, mk } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)
    const proof = await proveSecret(header, { password: secretBytes('correct horse') }, weak)
    expect(await leftovers(() => changePassword(header, mk, proof, secretBytes('new horse staple'), weak))).toBe(0)
  })

  it('T-ZERO-01 Z-g: newRecoveryKey destroys KEK_rc', async () => {
    const { header, mk } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)
    const proof = await proveSecret(header, { password: secretBytes('correct horse') }, weak)
    expect(await leftovers(() => newRecoveryKey(header, mk, proof))).toBe(0)
  })

  it('T-ZERO-01 Z-a: verifyCheck destroys K_check', async () => {
    const { header, mk } = await createVault({ password: secretBytes('correct horse'), kdf }, weak)
    expect(await leftovers(() => verifyCheck(header, mk))).toBe(0)
  })

  it('T-ZERO-01 Z-h: createLocalKeys and readLocalKeys destroy K_localwrap; LK goes to the caller', async () => {
    const mk = importKey(randomBytes(32), 'master')
    let lk: KeyHandle | undefined
    let json: unknown
    expect(await leftovers(() => ({ json, lk } = createLocalKeys(mk, SCHEDULE_V1, randomUUID(), randomUUID(), 'slate.db')), 1)).toBe(0)
    const first = lk!
    expect(await leftovers(() => (lk = readLocalKeys(json, mk, SCHEDULE_V1).lk), 1)).toBe(0)
    expect(sameDbKey(lk!, first)).toBe(true)
  })

  it('T-ZERO-01 Z-i: sealEnvelope and openEnvelope destroy the per-file key', async () => {
    const kSync = vaultNative().keyRandom()
    let sealed: Uint8Array = new Uint8Array()
    expect(await leftovers(() => (sealed = sealEnvelope(env(kSync), 'p/a.loro', Buffer.from('hello'))))).toBe(0)
    expect(await leftovers(() => openEnvelope(env(kSync), 'p/a.loro', sealed))).toBe(0)
    // A forged file destroys the key too.
    const forged = Uint8Array.from(sealed)
    forged[forged.length - 1]! ^= 1
    expect(await leftovers(() => (() => { try { openEnvelope(env(kSync), 'p/a.loro', forged) } catch { /* expected */ } })())).toBe(0)
  })

  it('T-ZERO-01 Z-j: KeyRing holds and hands out handles into the secure heap, never key bytes', () => {
    const mk = randomBytes(32)
    const lk = randomBytes(32)
    const ring = new KeyRing(importKey(mk, 'master'), importKey(lk, 'db'), SCHEDULE_V1)
    for (const name of ['mk', 'lk', 'sync', 'check'] as const) expect(typeof ring.get(name)).toBe('number')
    expect(masterKeyMatches(ring.get('mk'), mk)).toBe(true)
    expect(dbKeyMatches(ring.get('lk'), lk)).toBe(true)
    expect(ring.close()).toBe(8)
  })
})

describe('T-ZERO-01: what a caller takes from the KeyRing stays the ring\'s', () => {
  it('T-ZERO-01: savePreunlock and checkPreunlock take no key of their own (also for a tampered file)', async () => {
    const ring = new KeyRing(importKey(randomBytes(32), 'master'), importKey(randomBytes(32), 'db'), SCHEDULE_V1)
    const path = join(mkdtempSync(join(tmpdir(), 'slate-zero-pre-')), 'preunlock.json')
    expect(await leftovers(async () => {
      await savePreunlock(path, DEFAULT_SETTINGS, ring)
      await checkPreunlock(path, DEFAULT_SETTINGS, ring)
      writeFileSync(path, '{"tampered":true}')
      await checkPreunlock(path, DEFAULT_SETTINGS, ring)
    })).toBe(0)
    expect(ring.close()).toBe(8)
  })

  it('T-ZERO-01: a change of password with a ring that does not open this vault destroys the MK it unwrapped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-zero-mig-'))
    destroyKey((await createEncryptedDataDir(dir, secretBytes('correct horse'), weak)).mk)
    const ring = new KeyRing(importKey(randomBytes(32), 'master'), importKey(randomBytes(32), 'db'), SCHEDULE_V1)
    const migration = new Migration({ dataDir: dir, kdfOpts: weak } as unknown as MigrationDeps)
    expect(await leftovers(() => expect(migration.changePassword(ring, { password: secretBytes('correct horse') }, secretBytes('new horse staple'))).rejects.toThrow())).toBe(0)
    // The ring's own handles are untouched by the failure.
    expect(ring.close()).toBe(8)
  })
})

describe('T-ZERO-01: hkdf', () => {
  it('derives in the module: a subkey is a handle, owned by the caller, and no other key is left behind', () => {
    const k = vaultNative().keyRandom()
    const mk = importKey(randomBytes(32), 'master')
    const before = liveHandles()
    const derived = vaultNative().hkdfLegacy(k, new Uint8Array(0), 'slate/v1/test')
    const sub = deriveSubkey(mk, 'check', SCHEDULE_V1)
    for (const key of [derived, sub]) {
      expect(typeof key).toBe('number')
      expect(isApprovedKey(key)).toBe(false)
    }
    expect(liveHandles()).toBe(before + 2)
    for (const key of [derived, sub, k, mk]) destroyKey(key)
    expect(liveHandles()).toBe(before - 2)
  })
})

describe('Argon2id output (C1 criterion 4, Z-7: no worker thread holds a CSP)', () => {
  it('the password bytes are wiped as soon as the derivation is queued, before it finishes', async () => {
    const pw = new TextEncoder().encode('correct horse')
    const pending = vaultNative().argon2idAsync(pw, randomBytes(16), 64, 1)
    expect(pw.every((b) => b === 0)).toBe(true)
    destroyKey(await pending)
  })

  it('comes back as a handle into the secure heap: no worker, no transferred buffer, no bytes to zero', async () => {
    const before = liveHandles()
    const kek = await deriveKek(secretBytes('pw'), { alg: 'argon2id', memoryKiB: 64, passes: 1, parallelism: 1, salt: randomBytes(16).toString('base64') }, weak)
    expect(typeof kek).toBe('number')
    expect(isApprovedKey(kek)).toBe(false)
    expect(liveHandles()).toBe(before + 1)
    destroyKey(kek)
    expect(liveHandles()).toBe(before)
  })
})

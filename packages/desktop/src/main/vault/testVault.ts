import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@slate/core'
import type { KeyHandle } from '@slate/native'
import type { SecretBytes } from '../../shared/secret'
import { cleanupPlaintext, copyAndEncrypt } from '../db/migrateToEncrypted'
import { readSettings } from '../settings'
import { DocStore } from '../store'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { createVault, parseHeader, unlockWithPassword, type VaultHeader } from './header'
import { kdfForProfile, type WeakKdfOption } from './kdf'
import { deriveSubkey, type KeyRing } from './keyring'
import { latchProfile, type ProfileId } from './profile'
import { scheduleOf } from './header'
import { createLocalKeys } from './localKeys'
import { destroyKey } from './native'
import { writePreunlock } from './preunlock'
import { preunlockFromSettings } from './preunlockSync'
import { LOCAL_KEYS_FILE, PREUNLOCK_FILE, unlockVault, VAULT_FILE, type UnlockSecret } from './unlock'

/** Every JSON file in `dir` that is a vault header `password` opens. */
export async function headersOpenedBy(dir: string, password: SecretBytes, opts: WeakKdfOption): Promise<string[]> {
  const opened: string[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      destroyKey(await unlockWithPassword(parseHeader(await readJsonCapped(join(dir, f)), opts), password, opts))
      opened.push(f)
    } catch {
      // Not a header, or the password does not open it.
    }
  }
  return opened
}

/**
 * Tests and the e2e start-up hook only (E5 builds the real wizard): turns a plaintext data folder
 * into an encrypted one with cheap KDF parameters, which unlock accepts only with
 * `allowWeakForTests`, which the caller passes. No production path calls it. The caller owns the
 * returned MK handle and destroys it.
 */
export async function createEncryptedDataDir(
  dataDir: string,
  password: SecretBytes,
  opts: WeakKdfOption,
  profile: ProfileId = 'standard',
): Promise<{ header: VaultHeader; mk: KeyHandle; recoveryKey: string }> {
  const plainFile = join(dataDir, 'slate.db')
  const plain = new DocStore(plainFile)
  const settings = readSettings(plain)
  plain.close()
  const kdf = await kdfForProfile(profile, { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 })
  const { header, mk, recoveryKey } = await createVault({ password, profile, kdf }, opts)
  const schedule = scheduleOf(header)
  latchProfile(profile)
  // MK is the caller's on success; any step that throws destroys it with the keys made from it (review C4 L4).
  let lk: KeyHandle | null = null
  let kPrefs: KeyHandle | null = null
  try {
    const db = `slate-${header.vaultId.slice(0, 8)}.db`
    const local = createLocalKeys(mk, schedule, header.vaultId, newId(), db)
    lk = local.lk
    kPrefs = deriveSubkey(mk, 'prefs', schedule)
    const blobsDir = join(dataDir, 'blobs')
    mkdirSync(blobsDir, { recursive: true })
    copyAndEncrypt({ plainFile, outFile: join(dataDir, db), key: lk, blobsDir })
    await writeJsonAtomic(join(dataDir, VAULT_FILE), header)
    await writeJsonAtomic(join(dataDir, LOCAL_KEYS_FILE), local.json)
    await writePreunlock(join(dataDir, PREUNLOCK_FILE), preunlockFromSettings(settings), kPrefs, profile)
  } catch (e) {
    destroyKey(mk)
    throw e
  } finally {
    destroyKey(kPrefs)
    destroyKey(lk)
  }
  cleanupPlaintext(dataDir)
  return { header, mk, recoveryKey: recoveryKey! }
}

/** Opens the encrypted store with an unlocked key ring's LK handle, as services.ts does. */
export function storeWithLk(keyRing: KeyRing, dbFile: string): DocStore {
  return new DocStore(dbFile, { key: keyRing.get('lk') })
}

/** A secret the user may type after a crash: `secret` builds a fresh one each time (unlock consumes it). */
export interface CrashSecret {
  label: string
  secret: () => UnlockSecret
}

/** How many notes `dir` holds under `s`, or null when `s` does not open it. */
export async function notesUnder(dir: string, s: () => UnlockSecret, opts: WeakKdfOption): Promise<number | null> {
  let ring: KeyRing | undefined
  try {
    const u = await unlockVault(dir, s(), opts)
    ring = u.keyRing
    const store = storeWithLk(ring, u.dbFile)
    try {
      return store.list('').length
    } finally {
      store.close()
    }
  } catch {
    return null
  } finally {
    ring?.close()
  }
}

/**
 * The check every crash-injection test of a key change ends with (guard tools/guards/crashSurvival.test.ts; review
 * C9 C1): after the crash, on copies of `dir` (so the caller's own recovery still sees the crashed state), the old
 * secret and every new one are each tried alone, and then all of them in the order a user types them (the new ones
 * first). At least one must open each time, and every one that opens must show all `notes` notes.
 */
export async function expectNotesSurviveCrash(
  dir: string,
  c: { old: CrashSecret; next: readonly [CrashSecret, ...CrashSecret[]]; notes: number; opts: WeakKdfOption },
): Promise<void> {
  const problems: string[] = []
  const tryAll = async (order: readonly CrashSecret[], tag: string): Promise<void> => {
    const copy = `${dir}-crash-${tag}`
    rmSync(copy, { recursive: true, force: true })
    cpSync(dir, copy, { recursive: true })
    try {
      let opened = 0
      for (const s of order) {
        const n = await notesUnder(copy, s.secret, c.opts)
        if (n === null) continue
        opened++
        if (n !== c.notes) problems.push(`${tag}: ${s.label} opens ${n} notes, not ${c.notes}`)
      }
      if (opened === 0) problems.push(`${tag}: none of ${order.map((s) => s.label).join(', ')} opens the vault`)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  }
  const all = [c.old, ...c.next]
  for (const [i, s] of all.entries()) {
    const copy = `${dir}-crash-alone-${i}`
    rmSync(copy, { recursive: true, force: true })
    cpSync(dir, copy, { recursive: true })
    try {
      const n = await notesUnder(copy, s.secret, c.opts)
      if (n !== null && n !== c.notes) problems.push(`alone: ${s.label} opens ${n} notes, not ${c.notes}`)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  }
  await tryAll([...c.next, c.old], 'new-first')
  await tryAll(all, 'old-first')
  if (problems.length > 0) throw new Error(`notes lost after the crash:\n${problems.join('\n')}`)
}

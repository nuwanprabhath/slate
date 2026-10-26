import { existsSync, renameSync } from 'node:fs'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeStrayDatabases } from '../db/migrateToEncrypted'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { floorOf, isDowngrade, isNewerKeys, openHistory, parseHeader, profileOf, scheduleOf, unlockWithPassword, unlockWithRecovery, verifyCheck, WrongSecret, type VaultHeader } from './header'
import type { WeakKdfOption } from './kdf'
import { KeyRing } from './keyring'
import { parseLocalKeys, readLocalKeys } from './localKeys'
import { destroyKey } from './native'
import { checkProfileUsable, latchProfile, PROFILES } from './profile'
import { log } from '../log/logger'
import { checkProfileFloor, HeaderRefused, readLocalKeysFloor, readProfileFloor, updateProfileFloor } from './profileFloor'
import type { KeySchedule } from './suite'
import type { VaultSecret } from '../../shared/api'
import { securityEvent } from '../log/securityEvents'

export const VAULT_FILE = 'vault.json'
export const PENDING_FILE = 'vault.pending.json'
/**
 * Review C9 L1: a newer-keys header the sync check saw on the remote and could not verify (another device's key
 * change). Never the pending header: it only offers this device the change at unlock, where the secret must verify
 * it, and it is replaced by whatever the remote holds next.
 */
export const CANDIDATE_FILE = 'vault.candidate.json'
/** Review C9 M4: written once the sync check has seen this vault on a remote; a synced vault is rekeyed only with sync on. */
export const SYNCED_FILE = 'vault-synced.json'
export const PREV_FILE = 'vault.prev.json'
export const LOCAL_KEYS_FILE = 'local-keys.json'
export const PREUNLOCK_FILE = 'preunlock.json'
/** A rejoin's staged pair (§7.5), present only until both are renamed over the live pair. */
export const REJOIN_VAULT_FILE = 'vault.rejoin.json'
export const REJOIN_KEYS_FILE = 'local-keys.rejoin.json'
/** quickUnlock.ts's file (it imports this module, so the name is repeated, not imported). */
const QUICK_UNLOCK_FILE_NAME = 'quick-unlock.bin'

export const UNLOCK_FAILED_MESSAGE = "That password didn't work"

/** Says nothing about why, so the renderer cannot tell a wrong secret from a forged header. */
export class UnlockFailed extends Error {
  override name = 'UnlockFailed'
  constructor() {
    super(UNLOCK_FAILED_MESSAGE)
  }
}

/**
 * C9: the secret opens only a newer header of this vault (another device rotated or converted it and changed the
 * password), and this device's own keys are not in its history (a conversion empties it): the previous secret opens
 * this device's notes, after which Slate asks for the new one to follow the change.
 */
export class AdoptWithOldSecret extends Error {
  override name = 'AdoptWithOldSecret'
  constructor() {
    super('Your vault’s keys were changed on another device. Unlock with your previous password; Slate then asks for the new one.')
  }
}

/**
 * `mk`: quick unlock already unwrapped it; it still has to pass the header's `check`. `unlockVault` takes
 * ownership of that handle: it ends up in the KeyRing, or destroyed.
 */
/** A typed secret as bytes (Z-5), or a quick-unlock MK handle that unlockVault then owns. */
export type UnlockSecret = VaultSecret | { mk: KeyHandle }

async function readPending(dataDir: string, local: VaultHeader, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    const pending = parseHeader(await readJsonCapped(join(dataDir, PENDING_FILE)), opts)
    // §4: only a newer header of the same vault is ever a candidate, and never an older format or a weaker
    // profile (audit §4.5.2: a header-v1 copy of a vault that has moved to v2 is ignored).
    // Review C9 M5: at the same revision, a different header is another device's simultaneous change that won.
    if (pending.vaultId !== local.vaultId || pending.revision < local.revision || pending.check === local.check) return null
    return isDowngrade(pending, floorOf(local)) ? null : pending
  } catch {
    return null
  }
}

/**
 * The MK `secret` opens under `header`, or null. For `{ mk }` that is the given handle itself, never a copy.
 * The profile is checked before deriving (refusals only), and a fips-140-3 header latches the module only once
 * its `check` verified (review C5 M1), before LK is unwrapped or the database keyed.
 */
/** The candidate, when it is this vault's, brings newer keys and passes the downgrade rule; null otherwise. */
async function readCandidate(dataDir: string, local: VaultHeader, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    const c = parseHeader(await readJsonCapped(join(dataDir, CANDIDATE_FILE)), opts)
    return c.vaultId === local.vaultId && isNewerKeys(c, local) && !isDowngrade(c, floorOf(local)) ? c : null
  } catch {
    return null
  }
}

async function openMk(header: VaultHeader, secret: UnlockSecret, opts: WeakKdfOption, latch = true): Promise<KeyHandle | null> {
  checkProfileUsable(profileOf(header))
  let mk: KeyHandle | null
  if ('mk' in secret) mk = verifyCheck(header, secret.mk) ? secret.mk : null
  else {
    try {
      mk = 'password' in secret ? await unlockWithPassword(header, secret.password, opts) : unlockWithRecovery(header, secret.recoveryKey)
    } catch (e) {
      if (e instanceof WrongSecret) return null
      throw e
    }
  }
  if (mk !== null && latch) latchProfile(profileOf(header))
  return mk
}

async function readStaged(dataDir: string, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    return parseHeader(await readJsonCapped(join(dataDir, REJOIN_VAULT_FILE)), opts)
  } catch {
    return null
  }
}

async function tryLocalKeys(file: string, mk: KeyHandle, schedule: KeySchedule): Promise<ReturnType<typeof readLocalKeys> | null> {
  try {
    return readLocalKeys(await readJsonCapped(file), mk, schedule)
  } catch (e) {
    if (nativeErrorCode(e) === 'SCC_12') throw e
    return null
  }
}

/**
 * C9: this device's local keys opened through the pending header's history: the MK of the epoch they were made under
 * (local-keys v2 records it; a v1 file is epoch 0). The caller owns what it returns; the other epochs' keys go here.
 */
async function openFromHistory(
  dataDir: string,
  pending: VaultHeader,
  mk: KeyHandle,
): Promise<{ mk: KeyHandle; schedule: KeySchedule; opened: NonNullable<Awaited<ReturnType<typeof tryLocalKeys>>> } | null> {
  let epoch = 0
  try {
    const { bound } = parseLocalKeys(await readJsonCapped(join(dataDir, LOCAL_KEYS_FILE)))
    if (bound.version === 2) epoch = bound.keyEpoch
  } catch {
    return null
  }
  const history = openHistory(pending, mk)
  const hit = history.get(epoch)
  for (const [e, k] of history) if (e !== epoch) destroyKey(k.mk)
  if (!hit) return null
  const opened = await tryLocalKeys(join(dataDir, LOCAL_KEYS_FILE), hit.mk, hit.schedule).catch((e: unknown) => {
    destroyKey(hit.mk)
    throw e
  })
  if (!opened) {
    destroyKey(hit.mk)
    return null
  }
  return { mk: hit.mk, schedule: hit.schedule, opened }
}

/**
 * The live local keys, or a rejoin's staged ones when only they open with `mk`. Whichever pair
 * opened wins and the other is discarded: a rejoin is finished (header, then keys, by rename)
 * or forgotten, never left half done. The caller owns the returned LK; it is destroyed here on failure.
 */
async function openLocalKeys(dataDir: string, mk: KeyHandle, schedule: KeySchedule): Promise<ReturnType<typeof readLocalKeys> | null> {
  const path = (f: string) => join(dataDir, f)
  const live = await tryLocalKeys(path(LOCAL_KEYS_FILE), mk, schedule)
  if (live) {
    try {
      if (existsSync(path(REJOIN_KEYS_FILE))) {
        // The live pair opened: the rejoin never swapped its header in, so it did not happen.
        for (const f of [REJOIN_VAULT_FILE, REJOIN_KEYS_FILE]) await rm(path(f), { force: true })
      }
    } catch (e) {
      destroyKey(live.lk)
      throw e
    }
    return live
  }
  const staged = existsSync(path(REJOIN_KEYS_FILE)) ? await tryLocalKeys(path(REJOIN_KEYS_FILE), mk, schedule) : null
  if (!staged) return null
  // Review C9 C1: a staged pair counts only with its complete database beside it (the keys file is written after the
  // copy is verified, but a pair from an older build, or a database removed by hand, must never replace the live one).
  if (!existsSync(path(staged.db))) {
    destroyKey(staged.lk)
    return null
  }
  try {
    if (existsSync(path(REJOIN_VAULT_FILE))) renameSync(path(REJOIN_VAULT_FILE), path(VAULT_FILE))
    renameSync(path(REJOIN_KEYS_FILE), path(LOCAL_KEYS_FILE))
  } catch (e) {
    destroyKey(staged.lk)
    throw e
  }
  return staged
}

/**
 * §6.7 + §4: the secret opens the local header, or else the pending one (the password was changed
 * on another device), which then becomes the local header. Then this device's LK is unwrapped.
 * MK and LK go from the module into the KeyRing as handles; on any failure they are destroyed,
 * a quick-unlock `{ mk }` included. A header below this device's profile floor is refused before
 * anything is derived from it (HeaderRefused, T-POL-05); after unlock the floor is raised to the header.
 */
export async function unlockVault(
  dataDir: string,
  secret: UnlockSecret,
  opts: WeakKdfOption = {},
): Promise<{ keyRing: KeyRing; dbFile: string; passwordChanged: boolean; headerRevision: number; adopt?: VaultHeader }> {
  const given = 'mk' in secret ? secret.mk : null
  let mk: KeyHandle | null = null
  let lk: KeyHandle | null = null
  let handed = false
  try {
    const local = parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), opts)
    const floors = [await readProfileFloor(dataDir, local.vaultId), await readLocalKeysFloor(dataDir)]
    for (const floor of floors) checkProfileFloor(local, floor)
    const pending = await readPending(dataDir, local, opts)
    const candidate = await readCandidate(dataDir, local, opts)
    let used: VaultHeader = local
    mk = await openMk(local, secret, opts)
    let passwordChanged = false
    if (!mk && pending) {
      // C9: newer keys are adopted by re-encrypting, which latches a raised profile itself, after its copy.
      mk = await openMk(pending, secret, opts, !isNewerKeys(pending, local))
      used = pending
      if (mk && !isNewerKeys(pending, local)) {
        await writeJsonAtomic(join(dataDir, VAULT_FILE), pending)
        await rm(join(dataDir, PENDING_FILE), { force: true })
        // Left by older versions; kept, it would let the old secret open this device's vault.
        await rm(join(dataDir, PREV_FILE), { force: true })
        passwordChanged = true
        securityEvent.headerAdopted({ fromRevision: local.revision, toRevision: pending.revision })
      }
    }
    // Review C9 L1: another device's key change the sync check saw, if this secret verifies it.
    if (!mk && candidate) {
      for (const floor of floors) checkProfileFloor(candidate, floor)
      mk = await openMk(candidate, secret, opts, false)
      if (mk) used = candidate
    }
    // A rejoin cut short before its header swap: the staged header may be the one this secret opens.
    const staged = mk ? null : await readStaged(dataDir, opts)
    if (!mk && staged) {
      // Review C5 L4: a rejoin stays within the profile (M1), so a staged header weaker than the local one is planted.
      if (isDowngrade(staged, { version: local.version, profile: profileOf(local) })) {
        securityEvent.headerRefused({ reason: 'downgrade', headerVersion: staged.version, profile: profileOf(staged) })
        throw new HeaderRefused('downgrade')
      }
      for (const floor of floors) checkProfileFloor(staged, floor)
      mk = await openMk(staged, secret, opts)
      used = staged
    }
    if (!mk) throw new UnlockFailed()
    let schedule = scheduleOf(used)
    let opened = await openLocalKeys(dataDir, mk, schedule)
    // C9 criterion 3: a newer header of this vault, under keys this device has not adopted yet. When the local header
    // opened, the caller re-encrypts into the pending one if the same secret opens it (`Migration.rejoin`). When only
    // the pending header opened (the password changed with the rotation), this device's keys come from its history.
    let adopt: VaultHeader | undefined
    if (opened && used === local) adopt = pending && isNewerKeys(pending, local) ? pending : (candidate ?? undefined)
    const newer = used !== local && used !== staged && isNewerKeys(used, local) ? used : null
    if (!opened && newer) {
      const old = await openFromHistory(dataDir, newer, mk)
      if (old) {
        destroyKey(mk)
        mk = old.mk
        schedule = old.schedule
        opened = old.opened
        adopt = newer
        used = local
        // The local header did not open, so nothing latched yet: this device's own profile does now (review C5 M1).
        latchProfile(profileOf(local))
      }
    }
    if (!opened && newer) throw new AdoptWithOldSecret()
    if (!opened) throw new UnlockFailed()
    lk = opened.lk
    // The profile local-keys v2 authenticates is a floor for the header that opened it (review C5 L4).
    if (isDowngrade(used, { version: opened.profile === 'standard' && used.version === 1 ? 1 : 2, profile: opened.profile })) throw new HeaderRefused('downgrade')
    handed = true
    // The ring owns both from here, and destroys them itself if a subkey cannot be derived.
    const keyRing = new KeyRing(mk, lk, schedule)
    try {
      keyRing.attachHistory(openHistory(used, keyRing.get('mk')))
      await updateProfileFloor(dataDir, used, keyRing.get('prefs'))
      // Review C5 L3: `db` was just authenticated (local-keys v2 binds it), so a database no pair names any more,
      // left by a rejoin cut short, can go now; a v1 file's name is trusted as it is. Best effort (review C5 N1): a
      // stray the folder will not let go of (a directory, a permission) is logged and never fails the unlock, and
      // does not stop the strays after it (C6, review C5 merge check).
      try {
        // Review C9 C1: only with the database this unlock keeps actually there; the strays are then superseded copies.
        const left = existsSync(join(dataDir, opened.db)) ? removeStrayDatabases(dataDir, opened.db) : 0
        if (left > 0) log.warn('app', 'stray database clean-up failed', { count: left })
      } catch (e) {
        log.warn('app', 'stray database clean-up failed', { error: (e as { code?: string }).code ?? (e instanceof Error ? e.name : 'unknown') })
      }
      // T-POL-06: no quick unlock in fips-140-3; a file left from before is not kept.
      if (!PROFILES[schedule.profile].quickUnlock) await rm(join(dataDir, QUICK_UNLOCK_FILE_NAME), { force: true })
    } catch (e) {
      keyRing.close()
      throw e
    }
    return { keyRing, dbFile: join(dataDir, opened.db), passwordChanged, headerRevision: used.revision, ...(adopt ? { adopt } : {}) }
  } finally {
    if (!handed) {
      destroyKey(mk)
      destroyKey(lk)
      if (given !== null && given !== mk) destroyKey(given)
    }
  }
}

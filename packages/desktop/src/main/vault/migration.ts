import { env } from '../testHooks'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@slate/core'
import type { KeyHandle } from '@slate/native'
import { cleanupPlaintext, copyAndEncrypt, copyAndRekey, holdExclusive, removeStrayDatabases, verifyDocIds } from '../db/migrateToEncrypted'
import { openDatabase } from '../db/openDatabase'
import { readSettings } from '../settings'
import type { DocStore } from '../store'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import {
  changePassword,
  chooseBase,
  createVault,
  destroyProof,
  deviceSlotsAllow,
  isNewerKeys,
  MAX_HISTORY,
  newRecoveryKey,
  openHistory,
  parseHeader,
  profileOf,
  proveSecret,
  pruneHistory,
  rekeyHeader,
  RotationRefused,
  rotationDueSince,
  sameMasterKey,
  scheduleOf,
  unlockWithPassword,
  unlockWithRecovery,
  verifyCheck,
  WrongSecret,
  type RekeyKind,
  type VaultHeaderV2,
  type VaultHeaderV3,
  type VaultHeader,
  type WrapProof,
} from './header'
import { kdfForProfile, type Argon2idParams, type WeakKdfOption } from './kdf'
import { KeyRing } from './keyring'
import { createLocalKeys, parseLocalKeys } from './localKeys'
import { destroyKey, toHex, vaultNative } from './native'
import { checkPassword } from './password'
import { checkProfileUsable, fipsProfileAvailable, latchProfile, ProfileMismatch, profileRank, type ProfileId } from './profile'
import { updateProfileFloor } from './profileFloor'
import type { SecretBytes } from '../../shared/secret'
import type { VaultKeysInfo } from '../../shared/api'
import { savePreunlock } from './preunlockSync'
import { claimRemote, commitRekeyedHeader, sameHeader, updateRemoteHeader, type VaultRemote } from './remoteVault'
import { epochOf } from './suite'
import { readSeen, writeSeen } from './seen'
import { devicesBlocking, hasSyncedBefore, pqGateBlocking, type CapabilityRecord } from './deviceGate'
import { securityEvent } from '../log/securityEvents'
import { CANDIDATE_FILE, LOCAL_KEYS_FILE, PENDING_FILE, PREUNLOCK_FILE, PREV_FILE, REJOIN_KEYS_FILE, REJOIN_VAULT_FILE, UnlockFailed, VAULT_FILE, type UnlockSecret } from './unlock'

/** §7.4: `{ step, vaultId, dbFile }`, present from the vault write until the clean-up is done. */
export const MIGRATION_FILE = 'migration.json'
/** E6's quick-unlock secret; a vault change discards it (§8). */
export const QUICK_UNLOCK_FILE = 'quick-unlock.bin'

/** The steps the progress view lists, in order. */
export const MIGRATION_PHASES = ['remote', 'claim', 'close', 'copy', 'bookkeeping', 'switch', 'cleanup', 'open'] as const
export type MigrationPhase = (typeof MIGRATION_PHASES)[number]

/** Where a rejoin can be cut short (crash-injection tests). */
export const REJOIN_STEPS = ['close', 'reset', 'stage', 'swap-vault', 'swap-keys', 'open'] as const
export type RejoinStep = (typeof REJOIN_STEPS)[number]
/**
 * C9: where a key rotation, format upgrade or FIPS conversion can be cut short (crash-injection tests): the remote
 * header's compare-and-swap first (while the services, whose settings reach the remote, are still open), then the
 * rejoin's steps, then the post-sync steps.
 */
export const REKEY_STEPS = ['remote', 'close', 'reset', 'stage', 'swap-vault', 'swap-keys', 'open', 'repush', 'sweep', 'prune'] as const
export type RekeyStep = (typeof REKEY_STEPS)[number]

/**
 * C9: `migration.json` while a rekey (audit §4.7) is under way. `staged` until the remote header is written,
 * `committed` from just before that write until this device is on the new keys (review C9 H1: it survives every
 * unlock route until then); then, with sync on, `repush` until a complete sync under the new epoch, `sweep` until the old trees are gone
 * and `prune` (rotate and upgrade) until `history` has dropped the epochs no file uses. Gone once finished.
 */
export interface RekeyRecord {
  kind: 'rekey'
  /** Review C9 L4: this rekey's id; a superseded list counts only for the rekey it was made for. */
  id: string
  rekey: RekeyKind
  step: 'staged' | 'committed' | 'repush' | 'sweep' | 'prune'
  vaultId: string
  fromEpoch: number
  toEpoch: number
  fromProfile: ProfileId
  toProfile: ProfileId
}

/** This device's own key change, staged for the remote (the candidate file), or null. */
async function readCandidateHeader(dataDir: string, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    return parseHeader(await readJsonCapped(join(dataDir, CANDIDATE_FILE)), opts)
  } catch {
    return null
  }
}

/**
 * PQ-B3: `migration.json` while the v2 → v3 header upgrade (`vault/pqUpgrade.ts`, roadmap §3.5) is under way:
 * `staged` once its candidate is written, `committed` from just before the remote write until the floor is raised.
 */
export interface PqHeaderRecord {
  kind: 'pq-header'
  id: string
  step: 'staged' | 'committed'
  vaultId: string
  fromRevision: number
  toRevision: number
}

/** What `migration.json` can hold: a C9 rekey, the PQ-B3 header upgrade, or (no `kind`) the §7.4 encryption's record. */
export type MigrationRecordKind = RekeyRecord['kind'] | PqHeaderRecord['kind']

async function readRecord(dataDir: string): Promise<{ kind?: unknown } | null> {
  try {
    const r = (await readJsonCapped(join(dataDir, MIGRATION_FILE))) as { kind?: unknown } | null
    return r !== null && typeof r === 'object' ? r : null
  } catch {
    return null
  }
}

/** The rekey under way, or null (no migration.json, the §7.4 encryption's own record, or a pq-header upgrade). */
export async function readRekeyRecord(dataDir: string): Promise<RekeyRecord | null> {
  const r = await readRecord(dataDir)
  return r?.kind === 'rekey' ? (r as RekeyRecord) : null
}

/** The header upgrade under way, or null. */
export async function readPqHeaderRecord(dataDir: string): Promise<PqHeaderRecord | null> {
  const r = await readRecord(dataDir)
  return r?.kind === 'pq-header' ? (r as PqHeaderRecord) : null
}

/** What a finished sync tells the rekey runner (`afterSync`). */
export interface SyncOutcome {
  /** The sync ran to the end (pushed everything, then pulled). */
  complete: boolean
  /** The encrypting drive of that sync, or null when sync is off or plaintext. */
  drive: { staleFiles(): number | null; takeOldReads(): number; sweep(localBlobs: Iterable<string>, superseded: ReadonlySet<string>): Promise<{ removed: number; kept: number }> } | null
  /**
   * Review C9 M2: what a conversion listed and pulled under the old keys before it converted (`supersede`), with the
   * id of the rekey it was made for (review C9 L4: no other rekey ever uses it).
   */
  superseded: () => Promise<{ id: string; names: readonly string[] }>
  clearSuperseded: () => Promise<void>
  /** The image names this device holds, which keep their current-epoch blobs at the sweep. */
  localBlobs: () => Promise<string[]>
  /** The engine forgets what it pushed, so its next sync pushes every doc whole (`SyncEngine.forgetPushed`). */
  forgetPushed: () => Promise<void>
  /** The remote's history can be replaced (git): offered once the old trees are gone. */
  replaceable: boolean
}

class InjectedCrash extends Error {
  constructor(step: string) {
    super(`Injected crash before ${step}`)
  }
}

export interface MigrationDeps {
  dataDir: string
  kdfOpts: WeakKdfOption
  /** Fixed KDF cost for each profile (tests, e2e); otherwise calibrated on this machine. */
  kdf?: { argon2: Pick<Argon2idParams, 'memoryKiB' | 'passes'>; pbkdf2Iterations: number }
  /** The sync remote's vault, or null when sync is off. */
  remote: () => VaultRemote | null
  /** §7.2 step 1: one plaintext sync, so nothing local is left unpushed before the wipe. */
  syncNow?: () => Promise<void>
  /** No sync may start between the claim and closing the services; resumed if the claim is not ours. */
  pauseSync?: () => Promise<void>
  resumeSync?: () => void
  /** §6.4 steps 2–6 for the open services: flush, mute, stop sync, close watch and databases. */
  closeServices: () => Promise<void>
  /** After a failure before the switch: the plaintext notes are still the ones in use. */
  reopenPlaintext: () => void
  openServices: (keyRing: KeyRing, dbFile: string) => { store: DocStore }
  progress?: (phase: MigrationPhase) => void
  /** Test seam: throws before this phase, as a crash there would stop it. */
  crashAt?: MigrationPhase | RejoinStep | RekeyStep
  tempDir?: string
  /** C9: every device record on the remote (name, version), for the D-7 gate; absent when sync is off. */
  devices?: () => Promise<DeviceRecord[]>
  /**
   * Review C9 M2, before a conversion: a complete sync under the current keys, recording the files it listed and then
   * pulled as superseded (the converted vault cannot read them, so only these may be removed). False when it failed.
   */
  supersede?: (id: string) => Promise<boolean>
  /** Review C9 L4: drops that list (a conversion refused, failed or discarded before its remote write). */
  clearSuperseded?: () => Promise<void>
  /** Review C9 M5: whether this device has synced with a remote before (sync settings or bookkeeping in its database). */
  syncedBefore?: () => Promise<boolean>
  /** Tells the windows (the sync notice) about files kept because they could not be identified. */
  notice?: (message: string) => void
}

/** A device's record on the remote (packages/sync engine `writeDevice`), with its `epochs` and `pq` capabilities. */
export interface DeviceRecord extends CapabilityRecord {
  appVersion?: string
  lastSeen?: number
}

export type PrepareResult = { kind: 'recovery'; recoveryKey: string } | { kind: 'join' }

/** Engine bookkeeping (packages/sync engine META, unscoped for OneDrive and `git:<remote>#<branch>:` for git). */
const ENGINE_KEYS = "key LIKE 'git:%' OR key IN ('deviceRecord', 'deltaCursor') OR " + ['pushed', 'seq', 'chunks', 'snapshot', 'stale', 'base'].map((p) => `key LIKE '${p}:%'`).join(' OR ')

/**
 * §7.2 step 4: forgets what was pushed, seen and uploaded, so the next sync sends every doc and
 * image through `EncryptingDrive`. Other `sync_meta` rows (the search index version) stay.
 */
export function resetSyncBookkeeping(dbFile: string, key: KeyHandle | null): void {
  const db = openDatabase(dbFile, key)
  try {
    db.transaction(() => {
      db.exec(`DELETE FROM sync_meta WHERE ${ENGINE_KEYS}`)
      db.exec('DELETE FROM sync_seen')
      db.exec('DELETE FROM blob_synced')
    })()
  } finally {
    db.close()
  }
}

/** At unlock: finishes a §7.4 encryption cut short after its switch; a rekey's or header upgrade's record is left to its runner. */
export async function finishMigrationAtUnlock(dataDir: string, log: { warn(msg: string, data?: Record<string, unknown>): void }): Promise<boolean> {
  const kind = (await readRecord(dataDir))?.kind
  if (kind === 'rekey' || kind === 'pq-header') return true
  return finishSwitchAtUnlock(dataDir, log)
}

/** §7.2 step 3: every clone (one folder per past remote) goes; SyncService re-clones. Stored tokens stay. */
export function deleteClones(gitDir: string): void {
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = readdirSync(gitDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) if (e.isDirectory()) rmSync(join(gitDir, e.name), { recursive: true, force: true })
}

/** §7.4 step 6, also run at the next unlock when a crash came after the switch. */
export function finishAfterSwitch(dataDir: string, tempDir: string = tmpdir()): void {
  // First: a clone left behind would let sync replay its plaintext commits onto the encrypted branch.
  deleteClones(join(dataDir, 'git-sync'))
  cleanupPlaintext(dataDir, tempDir)
  rmSync(join(dataDir, MIGRATION_FILE), { force: true })
}

/**
 * At unlock, after a crash past the switch: the notes are already encrypted, so a clean-up that
 * fails is logged and retried next unlock rather than failing the unlock. False while it is
 * unfinished: a stale plaintext clone may still be there, so sync must not start.
 */
export function finishSwitchAtUnlock(dataDir: string, log: { warn(msg: string, data?: Record<string, unknown>): void }, finish: (dataDir: string) => void = finishAfterSwitch): boolean {
  if (!existsSync(join(dataDir, MIGRATION_FILE))) return true
  try {
    finish(dataDir)
  } catch (e) {
    log.warn('migration clean-up failed; sync waits for the next unlock', { error: e instanceof Error ? e.message : String(e) })
  }
  return !existsSync(join(dataDir, MIGRATION_FILE))
}

function crashFromEnv(phase: MigrationPhase | RejoinStep | RekeyStep): boolean {
  const testing = env('SLATE_E2E') === '1' || env('VITEST') !== undefined
  return testing && env('SLATE_TEST_CRASH_AT') === `migration:${phase}`
}

/**
 * The database a rejoin copies into: named after the new vault, or, should that be the name in use (a vault
 * id with the same first eight hex digits), a random one; never the live database's name.
 */
function rejoinDbName(vaultId: string, current: string): string {
  const named = `slate-${vaultId.slice(0, 8)}.db`
  return named !== current ? named : `slate-${toHex(vaultNative().randomBytes(4))}.db`
}

/** A password or recovery key: a migration step never runs on a quick-unlock MK. */
export type MigrationSecret = Exclude<UnlockSecret, { mk: unknown }>

/**
 * A fresh MK handle the caller owns and destroys, or null when the secret does not open `header`. The profile
 * is checked first (refusals only); nothing is latched here: the caller latches when it commits the vault
 * (`local`), never on the strength of a header that has not verified (review C5 M1).
 */
async function openMk(header: VaultHeader, secret: MigrationSecret, opts: WeakKdfOption): Promise<KeyHandle | null> {
  checkProfileUsable(profileOf(header))
  try {
    return 'password' in secret ? await unlockWithPassword(header, secret.password, opts) : unlockWithRecovery(header, secret.recoveryKey)
  } catch (e) {
    if (e instanceof WrongSecret) return null
    throw e
  }
}

/**
 * §7.1–7.4: "Encrypt my notes", joining an encrypted remote, and later header changes. Remote
 * first, local second: a device that loses the race to claim the remote joins instead, before its
 * own data has changed.
 */
export class Migration {
  /** The vault made by `prepare`, kept until `run` hands its MK on or `discard` destroys it. */
  private prepared: { header: VaultHeader; mk: KeyHandle; confirmed: boolean } | undefined

  constructor(private readonly deps: MigrationDeps) {}

  private get opts(): WeakKdfOption {
    return this.deps.kdfOpts
  }

  private step(phase: MigrationPhase): void {
    if (this.deps.crashAt === phase || crashFromEnv(phase)) throw new Error(`Injected crash before ${phase}`)
    this.deps.progress?.(phase)
  }

  /**
   * Wizard step 3–4: a remote vault makes this a join; otherwise the vault is made (kept in memory). The
   * FIPS 140-3 profile is offered only in builds that run the approved module (docs/compliance/decisions.md).
   */
  async prepare(password: SecretBytes, profile: ProfileId = 'standard'): Promise<PrepareResult> {
    this.discard()
    if (profile === 'fips-140-3' && !fipsProfileAvailable()) throw new Error('This copy of Slate cannot create a FIPS 140-3 vault')
    const remote = this.deps.remote()
    if (remote && (await remote.read()).header !== null) return { kind: 'join' }
    const check = checkPassword(password, [], profile)
    if (!check.ok) throw new Error(check.reason ?? 'Choose a longer password')
    const kdf = await kdfForProfile(profile, this.deps.kdf)
    // §3.5 `Created`: header v3 when the gate allows it (INV-PQ-5), else v2 for the upgrade to raise later.
    const headerVersion = (await pqGateBlocking(this.deps)).length === 0 ? 3 : 2
    const { header, mk, recoveryKey } = await createVault({ password, profile, kdf, headerVersion }, this.opts)
    this.prepared = { header, mk, confirmed: false }
    return { kind: 'recovery', recoveryKey: recoveryKey! }
  }

  /** Wizard step 5: a real unlock round trip with the key the user typed back. */
  async confirmRecovery(recoveryKey: SecretBytes): Promise<boolean> {
    // The wizard's new vault, or a rekey's new header (C9 R-1: the new recovery key is typed back before it counts).
    const prepared = this.prepared ?? this.rekeyPrepared
    if (!prepared) return false
    const mk = await openMk(prepared.header, { recoveryKey }, this.opts)
    let ok = false
    try {
      ok = mk !== null && sameMasterKey(mk, prepared.mk, scheduleOf(prepared.header))
    } finally {
      destroyKey(mk)
    }
    prepared.confirmed = ok
    return ok
  }

  discard(): void {
    destroyKey(this.rekeyPrepared?.mk)
    this.rekeyPrepared = undefined
    destroyKey(this.prepared?.mk)
    this.prepared = undefined
  }

  /** Wizard steps 6–7. `join`: another device claimed the remote first; nothing local changed. */
  async run(): Promise<{ kind: 'done' } | { kind: 'join' }> {
    const prepared = this.prepared
    if (!prepared?.confirmed) throw new Error('Enter your recovery key first, to show it was saved')
    const remote = this.deps.remote()
    if (remote) {
      this.step('remote')
      await this.deps.syncNow?.()
      // A sync pushing after the claim would rebase its plaintext commits onto the new branch.
      await this.deps.pauseSync?.()
      let claimed: Awaited<ReturnType<typeof claimRemote>>
      try {
        this.step('claim')
        claimed = await claimRemote(remote, prepared.header)
      } catch (err) {
        this.deps.resumeSync?.()
        throw err
      }
      if (claimed.kind === 'join') {
        this.deps.resumeSync?.()
        this.discard()
        return { kind: 'join' }
      }
    }
    // `local` owns MK from here: it goes into the new key ring, or is destroyed.
    this.prepared = undefined
    await this.local(prepared.header, prepared.mk)
    if (remote) await writeSeen(this.deps.dataDir, prepared.header)
    return { kind: 'done' }
  }

  /** §15 N10: "Finish encrypting your notes" after a migration stopped before the switch. */
  async resume(password: SecretBytes): Promise<void> {
    const header = parseHeader(await readJsonCapped(join(this.deps.dataDir, VAULT_FILE)), this.opts)
    const mk = await openMk(header, { password }, this.opts)
    if (!mk) throw new UnlockFailed()
    await this.local(header, mk)
  }

  /** §7.3: a plaintext device adopts the remote's vault, with its password or recovery key. */
  async join(secret: MigrationSecret): Promise<void> {
    const remote = this.deps.remote()
    if (!remote) throw new Error('Sync is not set up')
    const snap = await remote.read()
    if (snap.header === null) throw new Error('The sync folder is not encrypted')
    const header = parseHeader(snap.header, this.opts)
    const mk = await openMk(header, secret, this.opts)
    if (!mk) throw new UnlockFailed()
    await this.local(header, mk)
    await writeSeen(this.deps.dataDir, header)
  }

  /**
   * §7.5: an encrypted device adopts another vault found on its remote; the old recovery key and any quick
   * unlock stop applying. Since C5 a database key never moves to another vault's KEK (review C4 M1-R): the
   * device makes a fresh LK under the new vault and copies its notes into a new database rekeyed to it.
   *
   * C9: the same path adopts this vault's own header after another device rotated its keys, upgraded its format or
   * converted it to fips-140-3 (`isNewerKeys`; criterion 3): the remote's header, or `pending` when the unlock found
   * one the same secret opens. A rejoin never moves across profiles, except up into the same vault's conversion.
   */
  async rejoin(keyRing: KeyRing, secret: MigrationSecret, pending?: VaultHeader): Promise<KeyRing> {
    let header: VaultHeader
    if (pending) header = pending
    else {
      const remote = this.deps.remote()
      if (!remote) throw new Error('Sync is not set up')
      const snap = await remote.read()
      if (snap.header === null) throw new Error('The sync folder is not encrypted')
      header = parseHeader(snap.header, this.opts)
    }
    const local = parseHeader(await readJsonCapped(join(this.deps.dataDir, VAULT_FILE)), this.opts)
    const adopting = isNewerKeys(header, local)
    if (pending && !adopting) throw new Error('That vault header brings no new keys')
    // Review C5 M1: a rejoin stays within the device's profile, decided before anything is derived or latched. R-3: a
    // device follows its own vault's conversion up to fips-140-3, never down.
    if (profileOf(header) !== keyRing.schedule.profile && !(adopting && profileRank(profileOf(header)) > profileRank(keyRing.schedule.profile))) {
      throw new ProfileMismatch(keyRing.schedule.profile, profileOf(header))
    }
    const mk = await openMk(header, secret, this.opts)
    if (!mk) throw new UnlockFailed()
    const next = await this.reencrypt(keyRing, header, mk)
    // Review C9 M5: the header followed is the remote's (directly, or verified as the pending or candidate one).
    if (this.deps.remote()) await writeSeen(this.deps.dataDir, header)
    if (adopting) securityEvent.headerAdopted({ fromRevision: local.revision, toRevision: header.revision })
    return next
  }

  /**
   * The notes are copied into a new database rekeyed to a fresh LK; only once that copy is complete and verified is
   * the new pair (pointing at it) staged next to the old one, and then swapped in by two renames, header first. A
   * crash at any point leaves a pair one of the two secrets opens, with its own complete database (`unlockVault`
   * tries both and finishes the swap; it never takes a staged pair whose database is missing). A failure before the swap
   * reopens the notes with the old ring; after it, the services stay closed and the caller locks. The old ring is
   * closed only on success, and the old database is removed then. Owns `mk` from the call on.
   *
   * `commit` (a rekey's remote compare-and-swap) runs first, before the services close (the remote's credentials
   * come from their settings) and before anything local is replaced. A profile the new header raises (R-3) latches after the swap, since the old database is then no
   * longer read, and before the new one opens.
   */
  private async reencrypt(keyRing: KeyRing, header: VaultHeader, given: KeyHandle, commit?: () => Promise<void>): Promise<KeyRing> {
    const { dataDir } = this.deps
    let mk: KeyHandle | null = given
    const schedule = scheduleOf(header)
    // The old ring's handle: valid until it closes, never destroyed here.
    const oldLk = keyRing.get('lk')
    const path = (f: string) => join(dataDir, f)
    let newLk: KeyHandle | null = null
    let next: KeyRing | null = null
    let servicesTookNext = false
    let closed = false
    let swapped = false
    let dbFile = ''
    let newDbFile = ''
    try {
      const { bound } = parseLocalKeys(await readJsonCapped(path(LOCAL_KEYS_FILE)))
      dbFile = path(bound.db)
      if (commit) {
        this.crash('remote')
        await commit()
      }
      this.crash('close')
      closed = true
      await this.deps.closeServices()
      this.crash('reset')
      // Harmless for the old vault too: a full re-push, a re-clone, quick unlock set up again.
      for (const f of [PREV_FILE, QUICK_UNLOCK_FILE]) rmSync(path(f), { force: true })
      deleteClones(path('git-sync'))
      // Review C9 C1: the new pair is staged only once its database is complete. copyAndRekey writes a temporary copy,
      // checks it opens under the new key with every row, fsyncs it and renames it into place; the staged keys file,
      // written last, is the commit marker that names it. Until then no unlock can choose the new pair, so none ever
      // removes the old database as a stray while it is the only complete one.
      const staged = createLocalKeys(mk, schedule, header.vaultId, bound.deviceId, rejoinDbName(header.vaultId, bound.db))
      newLk = staged.lk
      newDbFile = path(staged.json.db)
      copyAndRekey({ fromFile: dbFile, fromKey: oldLk, outFile: newDbFile, toKey: newLk })
      resetSyncBookkeeping(newDbFile, newLk)
      this.crash('stage')
      await writeJsonAtomic(path(REJOIN_VAULT_FILE), header)
      await writeJsonAtomic(path(REJOIN_KEYS_FILE), staged.json)
      this.crash('swap-vault')
      renameSync(path(REJOIN_VAULT_FILE), path(VAULT_FILE))
      swapped = true
      for (const f of [PENDING_FILE, CANDIDATE_FILE]) rmSync(path(f), { force: true })
      this.crash('swap-keys')
      renameSync(path(REJOIN_KEYS_FILE), path(LOCAL_KEYS_FILE))
      this.crash('open')
      latchProfile(profileOf(header))
      next = new KeyRing(mk, newLk, schedule)
      mk = null
      newLk = null
      next.attachHistory(openHistory(header, next.get('mk')))
      const { store } = this.deps.openServices(next, newDbFile)
      servicesTookNext = true
      await savePreunlock(path(PREUNLOCK_FILE), readSettings(store), next)
      await updateProfileFloor(dataDir, header, next.get('prefs'))
      // The old database is the old keys', under a key that closes with the old ring: nothing opens it now.
      for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true })
      return next
    } catch (err) {
      if (err instanceof InjectedCrash) throw err
      if (!swapped) {
        for (const f of [REJOIN_VAULT_FILE, REJOIN_KEYS_FILE]) rmSync(path(f), { force: true })
        if (newDbFile) for (const f of [newDbFile, `${newDbFile}-wal`, `${newDbFile}-shm`]) rmSync(f, { force: true })
        if (closed && dbFile) this.deps.openServices(keyRing, dbFile)
      }
      throw err
    } finally {
      // Review C4 M2, as in local(): every key has an owner on every path. A new ring the services did not
      // take is closed here; once the swap happened the old ring opens nothing any more and closes too.
      destroyKey(mk)
      destroyKey(newLk)
      if (next && !servicesTookNext) next.close()
      if (swapped) keyRing.close()
    }
  }

  /** Test seam: a crash here stops the process, so nothing after it (no rollback) runs. */
  private crash(step: RejoinStep | RekeyStep): void {
    if (this.deps.crashAt === step || crashFromEnv(step)) throw new InjectedCrash(step)
  }

  // ---- C9: key rotation, format upgrade, FIPS conversion (audit §4.7) ----

  /** The rekey made by `prepareRekey`, kept until `runRekey` hands its MK on or `discard` destroys it. */
  private rekeyPrepared: { kind: RekeyKind; base: VaultHeader; header: VaultHeaderV2 | VaultHeaderV3; mk: KeyHandle; confirmed: boolean } | undefined

  /**
   * D-7: the devices on the remote that would not understand the new header (none when sync is off). The rekey is
   * refused while any is listed; the user updates them first.
   */
  async blockingDevices(): Promise<DeviceRecord[]> {
    if (!this.deps.remote() || !this.deps.devices) return []
    return devicesBlocking(await this.deps.devices())
  }

  /**
   * R-1/R-3/R-5, the first half (Settings → Security, after the pre-change self-test): the new header is made in
   * memory and its new recovery key returned, to be shown once and typed back (`confirmRecovery`). `password` is
   * the current one; `newPassword` (convert only) the one the fips-140-3 vault will have, which must pass its rule.
   */
  async prepareRekey(keyRing: KeyRing, kind: RekeyKind, password: SecretBytes, newPassword?: SecretBytes): Promise<{ recoveryKey: string }> {
    this.discard()
    const record = await readRekeyRecord(this.deps.dataDir)
    if (record) throw new RotationRefused('The last key change is still being synced. Let sync finish, then try again.')
    // PQ-B3's upgrade owns migration.json (and its candidate, which may already be on the remote) until it is done.
    if (await readPqHeaderRecord(this.deps.dataDir)) throw new RotationRefused('The vault format update is still finishing; try again after the next sync.')
    const blocking = await this.blockingDevices()
    if (blocking.length > 0) {
      throw new RotationRefused(`Update Slate on every device first: ${blocking.map((d) => `${d.name} (${d.appVersion ?? 'unknown version'})`).join(', ')}.`)
    }
    // Review C9 M4: every other device must see the change through the remote's compare-and-swap. A vault that has
    // synced is rekeyed only with sync on and the remote in reach; one that never synced (local only) needs neither.
    const remote = this.deps.remote()
    if (!remote) {
      // Review C9 M5: synced is any trace of a remote, not only this build's marker: a header seen there, a git clone,
      // or sync bookkeeping in the notes database (deps.syncedBefore).
      if (await hasSyncedBefore(this.deps.dataDir, this.deps.syncedBefore)) {
        throw new RotationRefused('This vault syncs with other devices: turn sync on first, so they can follow the change.')
      }
    } else {
      try {
        await remote.read()
      } catch (e) {
        throw new RotationRefused(`Slate could not reach the sync folder (${e instanceof Error ? e.message : String(e)}). Key changes need it; try again when it is in reach.`)
      }
    }
    const profile: ProfileId = kind === 'convert' ? 'fips-140-3' : keyRing.schedule.profile
    // Rotate and upgrade keep the password; convert sets the one the fips-140-3 vault will have.
    const nextPassword = kind === 'convert' ? newPassword : password
    if (!nextPassword) throw new RotationRefused('Choose the password for the FIPS 140-3 vault')
    if (kind === 'convert') {
      if (!fipsProfileAvailable()) throw new RotationRefused('This copy of Slate cannot create a FIPS 140-3 vault')
      const check = checkPassword(nextPassword, [], 'fips-140-3')
      if (!check.ok) throw new Error(check.reason ?? 'Choose a longer password')
    }
    const { base, mk, proof } = await this.verified(keyRing, { password })
    try {
      // The password slot: what `rekeyHeader` moves into history must be the base's own password wrap.
      const kdf = await kdfForProfile(profile, this.deps.kdf)
      // PQ-B4 (roadmap §3.6): a v1 vault goes straight to v3 when the gate allows it, so in one remote CAS.
      const headerVersion = kind === 'upgrade' && (await pqGateBlocking(this.deps)).length === 0 ? 3 : 2
      const made = await rekeyHeader({ kind, base, mk, proof, password: nextPassword, kdf, profile, headerVersion }, this.opts)
      this.rekeyPrepared = { kind, base, header: made.header, mk: made.mk, confirmed: false }
      return { recoveryKey: made.recoveryKey }
    } finally {
      destroyProof(proof)
    }
  }

  /**
   * The second half: the new pair is staged; the remote header is written by compare-and-swap (a header changed
   * elsewhere since stops everything before anything local changed); the notes are copied under a fresh LK; then the
   * pair is swapped in and the services reopen under the new keys. With sync on, `migration.json` then drives the
   * re-push, the removal of the old trees and the pruning of `history` (`afterSync`).
   */
  async runRekey(keyRing: KeyRing): Promise<KeyRing> {
    const prepared = this.rekeyPrepared
    if (!prepared?.confirmed) throw new Error('Enter your new recovery key first, to show it was saved')
    this.rekeyPrepared = undefined
    const { dataDir } = this.deps
    const { kind, base, header } = prepared
    const fromEpoch = base.version === 1 ? 0 : base.keyEpoch
    const record: RekeyRecord = { kind: 'rekey', id: toHex(vaultNative().randomBytes(8)), rekey: kind, step: 'staged', vaultId: header.vaultId, fromEpoch, toEpoch: header.keyEpoch, fromProfile: profileOf(base), toProfile: header.profile }
    const remote = this.deps.remote()
    // Review C9 M2: a conversion empties history, so afterwards nothing under the old keys can be read: everything on
    // the remote is pulled first, and only what that pull listed may be removed later.
    if (kind === 'convert' && remote && !(await this.deps.supersede?.(record.id))) {
      await this.deps.clearSuperseded?.()
      this.rekeyPrepared = prepared
      throw new RotationRefused('Sync must finish once under the current keys before the conversion. Check that sync works, then try again.')
    }
    await this.deps.pauseSync?.()
    let next: KeyRing
    let committed = false
    try {
      await writeJsonAtomic(join(dataDir, MIGRATION_FILE), record)
      next = await this.reencrypt(keyRing, header, prepared.mk, async () => {
        if (!remote) return
        // Should this device stop after the remote write and before its own swap, it adopts the header at its next
        // unlock like any device that missed the rotation.
        await writeJsonAtomic(join(dataDir, CANDIDATE_FILE), header)
        await writeJsonAtomic(join(dataDir, MIGRATION_FILE), { ...record, step: 'committed' } satisfies RekeyRecord)
        await commitRekeyedHeader(remote, base, header, await readSeen(dataDir, this.opts), this.opts)
        committed = true
        await writeSeen(dataDir, header)
      })
    } catch (err) {
      // The new header never reached the remote: nothing is left to adopt. Once it did, this device follows it at its
      // next unlock (the pending header) and the record then carries on with the re-push.
      if (!(err instanceof InjectedCrash) && !committed) {
        rmSync(join(dataDir, MIGRATION_FILE), { force: true })
        rmSync(join(dataDir, CANDIDATE_FILE), { force: true })
        await this.deps.clearSuperseded?.()
      }
      this.deps.resumeSync?.()
      throw err
    }
    if (remote) await writeJsonAtomic(join(dataDir, MIGRATION_FILE), { ...record, step: 'repush' } satisfies RekeyRecord)
    else rmSync(join(dataDir, MIGRATION_FILE), { force: true })
    securityEvent.keyRotated({ fromEpoch, toEpoch: header.keyEpoch })
    if (profileOf(base) !== header.profile) securityEvent.profileChanged({ from: profileOf(base), to: header.profile })
    this.deps.resumeSync?.()
    return next
  }

  /**
   * R-2, after every sync while a rekey record is there (rotating device only): a complete sync under the new epoch
   * ends the re-push; then the old document, device and blob files are removed (once a sync read nothing more through
   * `history`, so every note pulled from an old epoch was pushed again); then `history` drops the epochs no file uses.
   * Returns true when another sync should follow at once.
   */
  async afterSync(keyRing: KeyRing, outcome: SyncOutcome): Promise<boolean> {
    const { dataDir } = this.deps
    const record = await readRekeyRecord(dataDir)
    if (!record || !outcome.complete || !outcome.drive) return false
    const write = (step: RekeyRecord['step']) => writeJsonAtomic(join(dataDir, MIGRATION_FILE), { ...record, step } satisfies RekeyRecord)
    if (record.step === 'staged' || record.step === 'committed' || epochOf(keyRing.schedule) !== record.toEpoch) return false
    if (record.step === 'repush') {
      this.crash('repush')
      await write('sweep')
      return true
    }
    if (record.step === 'sweep') {
      if (outcome.drive.staleFiles() === null) return false
      if (outcome.drive.takeOldReads() > 0) {
        // Another device's notes came in through history: this device's engine would never push them again.
        await outcome.forgetPushed()
        return true
      }
      this.crash('sweep')
      const listed = await outcome.superseded()
      const { kept } = await outcome.drive.sweep(await outcome.localBlobs(), new Set(listed.id === record.id ? listed.names : []))
      await outcome.clearSuperseded()
      if (kept > 0) this.deps.notice?.(`${kept} file${kept === 1 ? '' : 's'} in the sync folder could not be identified as replaced by the key change and ${kept === 1 ? 'was' : 'were'} left there.`)
      if (record.rekey === 'convert' || keyRing.historyEpochs.length === 0) rmSync(join(dataDir, MIGRATION_FILE), { force: true })
      else await write('prune')
      return true
    }
    // prune: nothing of an old epoch is left on the remote, so `history` drops them all.
    const stale = outcome.drive.staleFiles()
    if (stale === null) return false
    if (stale > 0) {
      await write('sweep')
      return true
    }
    this.crash('prune')
    const { base, mk } = await this.ownBase(keyRing)
    if (base.version !== 1 && (base.history ?? []).length > 0) {
      const epochs = (base.history ?? []).map((h) => h.epoch)
      await this.publish(base, mk, (b) => (b.version === 1 ? b : pruneHistory(b, mk, epochs)))
    }
    rmSync(join(dataDir, MIGRATION_FILE), { force: true })
    return false
  }

  /**
   * Review C9 M4: whether `header` (offered at unlock) may be followed now. A candidate that is this device's own key
   * change, cut short in its remote write (`committed`), is followed only once the remote holds exactly it. When the
   * remote holds an earlier epoch the change never landed: the record and the candidate go, and the remote wins. When
   * it holds that epoch under another header (a later change on top of ours), this device follows the remote instead.
   */
  async mayAdopt(header: VaultHeader, keyRing: KeyRing): Promise<boolean> {
    const record = await readRekeyRecord(this.deps.dataDir)
    if (!record || record.step !== 'committed') return true
    if (!(header.version !== 1 && header.keyEpoch === record.toEpoch && header.profile === record.toProfile)) return true
    const remote = this.deps.remote()
    if (!remote) return false
    let snap: unknown
    try {
      snap = (await remote.read()).header
    } catch {
      return false
    }
    if (sameHeader(snap, header)) return true
    if (this.supersededBy(snap, header, keyRing)) {
      for (const f of [MIGRATION_FILE, CANDIDATE_FILE]) rmSync(join(this.deps.dataDir, f), { force: true })
      await this.deps.clearSuperseded?.()
    }
    return false
  }

  /**
   * Review C9 L5: whether the remote positively holds a header that supersedes this device's own unpublished change
   * `header`: one the old keys still verify (so it is this vault's, not a forgery), at a revision at least the change's
   * (so not a replay of the header the change was built on). A stale or replayed read never qualifies.
   */
  private supersededBy(remoteJson: unknown, header: VaultHeader, keyRing: KeyRing): boolean {
    try {
      const theirs = parseHeader(remoteJson, this.opts)
      return theirs.vaultId === header.vaultId && theirs.revision >= header.revision && verifyCheck(theirs, keyRing.get('mk'))
    } catch {
      return false
    }
  }

  /** Settings → Security: the vault's key epoch and format, and which key change it can take now (D-7, R-1 … R-5). */
  async keysInfo(keyRing: KeyRing): Promise<VaultKeysInfo> {
    const { base } = await this.ownBase(keyRing)
    const record = await readRekeyRecord(this.deps.dataDir)
    const formatUpdate = (await readPqHeaderRecord(this.deps.dataDir)) !== null
    let blocking: DeviceRecord[] = []
    let devicesUnknown: string | undefined
    try {
      blocking = await this.blockingDevices()
    } catch (e) {
      devicesUnknown = e instanceof Error ? e.message : String(e)
    }
    const free = !record && !formatUpdate && devicesUnknown === undefined && blocking.length === 0
    const profile = profileOf(base)
    const epoch = base.version === 1 ? 0 : base.keyEpoch
    return {
      headerVersion: base.version,
      profile,
      keyEpoch: epoch,
      createdAt: base.createdAt,
      rotationDueSince: rotationDueSince(base),
      inProgress: record ? (record.step === 'staged' || record.step === 'committed' ? 'repush' : record.step) : null,
      blockingDevices: blocking.map((d) => ({ name: d.name, ...(d.appVersion !== undefined ? { appVersion: d.appVersion } : {}) })),
      ...(devicesUnknown !== undefined ? { devicesUnknown } : {}),
      // A v3 vault rotates and converts as v3 (PQ-B4); a conversion only when its device slots may stay (rule 8).
      canRotate: free && base.version !== 1 && (base.history ?? []).length < MAX_HISTORY,
      canUpgrade: free && base.version === 1,
      canConvert: free && profile === 'standard' && fipsProfileAvailable() && deviceSlotsAllow(base, 'fips-140-3'),
      canReplaceHistory: !record && epoch > 0 && this.deps.remote()?.replaceHistory !== undefined,
    }
  }

  /**
   * R-2 (git): once the old trees are gone, the sync branch becomes one parentless commit of its current files, so the
   * files sealed under earlier keys leave its history too; every clone is dropped and sync starts again from nothing.
   * Copies others already made (other clones, a host's reflog) are out of reach.
   */
  async replaceHistory(keyRing: KeyRing, dbFile: string): Promise<void> {
    const remote = this.deps.remote()
    if (!remote?.replaceHistory) throw new Error('Only a git sync folder keeps a history to replace')
    if (await readRekeyRecord(this.deps.dataDir)) throw new Error('Let the key change finish syncing first')
    await this.deps.pauseSync?.()
    try {
      if (!(await remote.replaceHistory())) throw new Error('The sync folder changed meanwhile; try again')
      await this.deps.closeServices()
      deleteClones(join(this.deps.dataDir, 'git-sync'))
      resetSyncBookkeeping(dbFile, keyRing.get('lk'))
      this.deps.openServices(keyRing, dbFile)
    } finally {
      this.deps.resumeSync?.()
    }
  }

  /** The highest header this ring verifies (no secret needed: pruning changes no wrap). */
  private async ownBase(keyRing: KeyRing): Promise<{ base: VaultHeader; mk: KeyHandle }> {
    const { local, pending } = await this.headers()
    const mk = keyRing.get('mk')
    return { base: chooseBase(local, pending, mk), mk }
  }

  /**
   * At unlock: a record whose rekey never reached its swap (the live pair opened) is stale, and a record a crash left
   * at `staged` after the swap moves on to the re-push. Returns the record still under way.
   */
  async resumeRekeyAtUnlock(keyRing: KeyRing): Promise<RekeyRecord | null> {
    const { dataDir } = this.deps
    const record = await readRekeyRecord(dataDir)
    if (!record) return null
    const drop = () => {
      rmSync(join(dataDir, MIGRATION_FILE), { force: true })
      return null
    }
    const on = (epoch: number, profile: ProfileId) => epochOf(keyRing.schedule) === epoch && keyRing.schedule.profile === profile
    if (on(record.toEpoch, record.toProfile)) {
      if (record.step !== 'staged' && record.step !== 'committed') return record
      if (!this.deps.remote()) return drop()
      const moved: RekeyRecord = { ...record, step: 'repush' }
      await writeJsonAtomic(join(dataDir, MIGRATION_FILE), moved)
      return moved
    }
    if (!on(record.fromEpoch, record.fromProfile) || record.step === 'staged') return drop()
    if (record.step !== 'committed') return drop()
    // Review C9 H1: the new header may be on the remote while this device still holds the old keys (a crash before its
    // swap, then quick unlock, or the old password after a conversion). The record stays until this device follows;
    // it goes only when the remote is seen not to hold the new keys (a crash between the record and the write).
    const remote = this.deps.remote()
    const candidate = await readCandidateHeader(dataDir, this.opts)
    if (remote && candidate) {
      try {
        // Review C9 L5: only a verified header that supersedes the change, never a single stale or replayed read.
        if (this.supersededBy((await remote.read()).header, candidate, keyRing)) {
          rmSync(join(dataDir, CANDIDATE_FILE), { force: true })
          await this.deps.clearSuperseded?.()
          return drop()
        }
      } catch {
        // Offline or unreadable: keep the record and look again at the next unlock.
      }
    }
    return record
  }

  /** §7.3 last bullet: "Encrypt this sync folder (replaces its history)" for an encrypted device. */
  async encryptRemote(keyRing: KeyRing, dbFile: string): Promise<void> {
    const remote = this.deps.remote()
    if (!remote) throw new Error('Sync is not set up')
    const { local } = await this.headers()
    // A sync pushing after the claim would put the old clone's history back on the branch.
    await this.deps.pauseSync?.()
    try {
      if ((await claimRemote(remote, local)).kind === 'join') throw new Error('This sync folder is already encrypted')
      await writeSeen(this.deps.dataDir, local)
    } catch (err) {
      this.deps.resumeSync?.()
      throw err
    }
    await this.deps.closeServices()
    deleteClones(join(this.deps.dataDir, 'git-sync'))
    resetSyncBookkeeping(dbFile, keyRing.get('lk'))
    this.deps.openServices(keyRing, dbFile)
  }

  /** Owns `mk`: it goes into the new key ring at the switch, or is destroyed. */
  private async local(header: VaultHeader, mk: KeyHandle): Promise<void> {
    const { dataDir } = this.deps
    const dbFile = `slate-${header.vaultId.slice(0, 8)}.db`
    const plainFile = join(dataDir, 'slate.db')
    let keys: ReturnType<typeof createLocalKeys> | undefined
    try {
      // The vault is committed from here (its header verified, or made here): a fips-140-3 one latches now.
      latchProfile(profileOf(header))
      await writeJsonAtomic(join(dataDir, VAULT_FILE), header)
      await writeJsonAtomic(join(dataDir, MIGRATION_FILE), { step: 'vault', vaultId: header.vaultId, dbFile })
      this.step('close')
      await this.deps.closeServices()
      try {
        this.step('copy')
        // An earlier attempt that stopped before the switch left a copy whose key was never kept.
        removeStrayDatabases(dataDir)
        const held = holdExclusive(plainFile)
        try {
          const bad = verifyDocIds(held).length
          if (bad > 0) {
            throw new Error(`${bad} note${bad === 1 ? ' has' : 's have'} an id Slate cannot encrypt, so nothing was changed. Export ${bad === 1 ? 'it' : 'them'} and report this.`)
          }
          keys = createLocalKeys(mk, scheduleOf(header), header.vaultId, newId(), dbFile)
          copyAndEncrypt({ plainFile, outFile: join(dataDir, dbFile), key: keys.lk, blobsDir: join(dataDir, 'blobs'), held })
        } finally {
          held.close()
        }
        this.step('bookkeeping')
        resetSyncBookkeeping(join(dataDir, dbFile), keys.lk)
        this.step('switch')
      } catch (err) {
        this.deps.reopenPlaintext()
        throw err
      }
      // The switch (§7.4 step 5): from here the encrypted database is the authoritative one.
      await writeJsonAtomic(join(dataDir, LOCAL_KEYS_FILE), keys.json)
    } catch (err) {
      destroyKey(keys?.lk)
      destroyKey(mk)
      throw err
    }
    const keyRing = new KeyRing(mk, keys.lk, scheduleOf(header))
    let opened = false
    try {
      await updateProfileFloor(dataDir, header, keyRing.get('prefs'))
      this.step('cleanup')
      // Not swallowed: sync must never start while an old clone is still there.
      deleteClones(join(dataDir, 'git-sync'))
      try {
        finishAfterSwitch(dataDir, this.deps.tempDir)
      } catch {
        // `migration.json` stays, so the next unlock finishes it; the notes are already encrypted.
      }
      this.step('open')
      const { store } = this.deps.openServices(keyRing, join(dataDir, dbFile))
      opened = true
      await savePreunlock(join(dataDir, PREUNLOCK_FILE), readSettings(store), keyRing)
    } finally {
      // A ring the services never took has no other owner: its keys go now, not at the next lock.
      if (!opened) keyRing.close()
    }
  }

  private async headers(): Promise<{ local: VaultHeader; pending: VaultHeader | null }> {
    const read = (f: string) => readJsonCapped(join(this.deps.dataDir, f))
    const local = parseHeader(await read(VAULT_FILE), this.opts)
    let pending: VaultHeader | null = null
    try {
      pending = parseHeader(await read(PENDING_FILE), this.opts)
    } catch {
      pending = null
    }
    return { local, pending }
  }

  /**
   * The secret must open the base (or local) header, and that header must verify under the MK this
   * device holds: the same header's `check` under both keys means one master key. Returns the proof
   * (`proveSecret`) a header change moves MK from; the caller destroys it. `mk` is the ring's handle.
   */
  private async verified(keyRing: KeyRing, secret: MigrationSecret): Promise<{ base: VaultHeader; local: VaultHeader; mk: KeyHandle; proof: WrapProof }> {
    const { local, pending } = await this.headers()
    const mk = keyRing.get('mk')
    const base = chooseBase(local, pending, mk)
    for (const header of [base, local]) {
      if (!verifyCheck(header, mk)) continue
      try {
        return { base, local, mk, proof: await proveSecret(header, secret, this.opts) }
      } catch (e) {
        if (!(e instanceof WrongSecret)) throw e
      }
    }
    throw new UnlockFailed()
  }

  /** Remote first (compare-and-swap), then the local copy: a lost local write is healed by the pending path. */
  private async publish(base: VaultHeader, mk: KeyHandle, build: (b: VaultHeader) => Promise<VaultHeader> | VaultHeader): Promise<void> {
    const { dataDir } = this.deps
    const remote = this.deps.remote()
    const written = remote ? await updateRemoteHeader(remote, base, mk, build, await readSeen(dataDir, this.opts), this.opts) : await build(base)
    if (remote) await writeSeen(dataDir, written)
    await writeJsonAtomic(join(dataDir, VAULT_FILE), written)
    // No older header stays on this device: the old secret must not open it (older versions kept one here).
    for (const f of [PENDING_FILE, PREV_FILE]) rmSync(join(dataDir, f), { force: true })
  }

  /** §10: needs the current password or the recovery key. */
  async changePassword(keyRing: KeyRing, current: MigrationSecret, newPassword: SecretBytes): Promise<void> {
    const { base, mk, proof } = await this.verified(keyRing, current)
    try {
      const check = checkPassword(newPassword, [], profileOf(base))
      if (!check.ok) throw new Error(check.reason ?? 'Choose a longer password')
      await this.publish(base, mk, (b) => changePassword(b, mk, proof, newPassword, this.opts))
    } finally {
      destroyProof(proof)
    }
  }

  /** §10: a new recovery key; the old one stops working for new copies of the vault (§4). */
  async newRecoveryKey(keyRing: KeyRing, password: SecretBytes): Promise<string> {
    const { base, mk, proof } = await this.verified(keyRing, { password })
    let recoveryKey = ''
    try {
      await this.publish(base, mk, (b) => {
        const made = newRecoveryKey(b, mk, proof)
        recoveryKey = made.recoveryKey
        return made.header
      })
    } finally {
      destroyProof(proof)
    }
    return recoveryKey
  }
}

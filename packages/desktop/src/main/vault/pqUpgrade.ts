// PQ-B3, roadmap §3.4–§3.5: the v2 → v3 header upgrade, run after unlock once every device can read v3 (D-9).
// Nothing secret or encrypted changes: the wraps are copied, so no secret is asked for, and no note, name, local key
// or database byte is touched. Every step is resumable from `migration.json` (kind `pq-header`), and the remote copy
// is written first, by compare-and-swap, so a crash anywhere leaves either v2 (still valid everywhere) or a v3 the
// next run finishes or adopts.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PqReadiness } from '../../shared/api'
import { log } from '../log/logger'
import { securityEvent } from '../log/securityEvents'
import { env } from '../testHooks'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { pqGateBlocking, type CapabilityRecord } from './deviceGate'
import { buildHeaderV3From, chooseBase, floorOf, isDowngrade, parseHeader, verifyCheck, type VaultHeader, type VaultHeaderV2, type VaultHeaderV3 } from './header'
import type { WeakKdfOption } from './kdf'
import type { KeyRing } from './keyring'
import { MIGRATION_FILE, readPqHeaderRecord, readRekeyRecord, type PqHeaderRecord } from './migration'
import { toHex, vaultNative } from './native'
import { updateProfileFloor } from './profileFloor'
import { casWriteHeader, RemoteChangedElsewhere, sameHeader, type VaultRemote } from './remoteVault'
import { readSeen, writeSeen } from './seen'
import { PENDING_FILE, PREV_FILE, VAULT_FILE } from './unlock'

/** Where the upgrade can be cut short (crash-injection tests), in order. */
export const PQ_UPGRADE_STEPS = ['staged', 'committed', 'remote', 'local', 'floor'] as const
export type PqUpgradeStep = (typeof PQ_UPGRADE_STEPS)[number]

/**
 * The upgrade's own candidate. Not C9's `vault.candidate.json`: the sync check writes another device's key change
 * there, and a rekey its own, so sharing it would let either replace or delete this one.
 */
export const PQ_CANDIDATE_FILE = 'vault.pq-candidate.json'
const MAX_REBUILDS = 3

export interface PqUpgradeDeps {
  dataDir: string
  kdfOpts: WeakKdfOption
  /** The unlocked session's ring; the upgrade borrows its handles and never closes it. */
  keyRing: KeyRing
  /** The sync remote's header access, or null while sync is off. */
  remote: () => VaultRemote | null
  /** Every device record on the remote (`SyncService.deviceRecords`); a throw means they cannot be read. */
  devices?: () => Promise<CapabilityRecord[]>
  /** Whether this vault has synced with a remote before (sync settings or engine bookkeeping). */
  syncedBefore?: () => Promise<boolean>
  /** The pre-change power-up self-test (audit §4.2); false when it failed (the app has then failed closed). */
  selfTest: () => Promise<boolean>
  /** Runs the writing steps under the vault-change lock (`VaultBusy`); throws when another change holds it. */
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>
  /** False once the session ended (lock, quit, a followed key change): the run stops at the next step boundary. */
  active?: () => boolean
  /** Test seam: throws before this step, as a crash there would stop it. */
  crashAt?: PqUpgradeStep
}

export type PqUpgradeOutcome =
  | { state: 'done' }
  | { state: 'waiting-devices'; blocking: string[] }
  | { state: 'offer-v1' }
  | { state: 'selftest-failed' }
  /** Committed but the remote was out of reach: the same candidate is tried again after the next sync. */
  | { state: 'retry' }
  /** Nothing more to do this session: the remote holds what this build will not write over, or the session ended. */
  | { state: 'stopped'; reason: string }

class InjectedCrash extends Error {
  constructor(step: PqUpgradeStep) {
    super(`Injected crash before ${step}`)
  }
}

/** The upgrade stops for this session; what it staged stays for the next run to resume. */
class Stop extends Error {}
/** The remote holds a header the upgrade will not build on or write over; nothing reached it, so the stage goes. */
class Refused extends Stop {}

// ---- The readiness the renderer reads (PqReadiness.vault); device names here, never in the log ----

let readiness: PqReadiness['vault'] = { kind: 'none' }

export function pqVaultReadiness(): PqReadiness['vault'] {
  return readiness.kind === 'none' ? readiness : { ...readiness, blockingDevices: [...readiness.blockingDevices] }
}

function show(version: 1 | 2 | 3, upgrade: Extract<PqReadiness['vault'], { kind: 'header' }>['upgrade'], blockingDevices: string[] = []): void {
  readiness = { kind: 'header', version, upgrade, blockingDevices }
}

let loggedWaiting: number | null = null

// ---- Files ----

const path = (d: PqUpgradeDeps, f: string) => join(d.dataDir, f)

async function readHeaderFile(file: string, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    return parseHeader(await readJsonCapped(file), opts)
  } catch {
    return null
  }
}

function discard(d: PqUpgradeDeps): void {
  rmSync(path(d, PQ_CANDIDATE_FILE), { force: true })
  rmSync(path(d, MIGRATION_FILE), { force: true })
}

function crashFromEnv(step: PqUpgradeStep): boolean {
  const testing = env('SLATE_E2E') === '1' || env('VITEST') !== undefined
  return testing && env('SLATE_TEST_CRASH_AT') === `pq-header:${step}`
}

function boundary(d: PqUpgradeDeps, step: PqUpgradeStep): void {
  if (d.active && !d.active()) throw new Stop('the session ended')
  if (d.crashAt === step || crashFromEnv(step)) throw new InjectedCrash(step)
}

/** §3.5 `staged`: the candidate, then the record naming it; `vault.json` is untouched. */
async function stage(d: PqUpgradeDeps, base: VaultHeaderV2): Promise<{ candidate: VaultHeaderV3; record: PqHeaderRecord }> {
  boundary(d, 'staged')
  const candidate = buildHeaderV3From(base, d.keyRing.get('mk'))
  const record: PqHeaderRecord = { kind: 'pq-header', id: toHex(vaultNative().randomBytes(8)), step: 'staged', vaultId: base.vaultId, fromRevision: base.revision, toRevision: candidate.revision }
  await writeJsonAtomic(path(d, PQ_CANDIDATE_FILE), candidate)
  await writeJsonAtomic(path(d, MIGRATION_FILE), record)
  boundary(d, 'committed')
  const committed: PqHeaderRecord = { ...record, step: 'committed' }
  await writeJsonAtomic(path(d, MIGRATION_FILE), committed)
  return { candidate, record: committed }
}

type CasResult = { kind: 'written'; header: VaultHeaderV3 } | { kind: 'adopt'; header: VaultHeaderV3 } | { kind: 'absent' } | { kind: 'offline' }

/**
 * §3.5 `remote`: the candidate goes to `e2ee/vault.json` only over the exact header it was built on (`casWriteHeader`).
 * A remote that already holds it (an earlier attempt landed) or another device's v3 of these keys is followed; a v2
 * that moved on (a password changed elsewhere) is built on again, at most three times. Anything this build cannot
 * read or verify stops the upgrade with nothing written.
 */
async function remoteCas(d: PqUpgradeDeps, remote: VaultRemote, local: VaultHeader, base: VaultHeaderV2, staged: VaultHeaderV3): Promise<CasResult> {
  const mk = d.keyRing.get('mk')
  let candidate = staged
  let from = base
  for (let attempt = 0; attempt <= MAX_REBUILDS; attempt++) {
    let snap
    try {
      snap = await remote.read()
    } catch {
      return { kind: 'offline' }
    }
    if (snap.header === null) return { kind: 'absent' }
    if (sameHeader(snap.header, candidate)) return { kind: 'written', header: candidate }
    let theirs: VaultHeader
    try {
      theirs = parseHeader(snap.header, d.kdfOpts)
    } catch {
      const version = (snap.header as { version?: unknown } | null)?.version
      securityEvent.headerRefused({ reason: 'schema', ...(typeof version === 'number' ? { headerVersion: version } : {}) }, 'sync')
      throw new Refused('the remote header cannot be read by this version')
    }
    if (theirs.vaultId !== local.vaultId) throw new Refused('the sync folder holds another vault')
    if (!verifyCheck(theirs, mk)) throw new Refused('the remote header is under other keys')
    if (isDowngrade(theirs, floorOf(local))) throw new Refused('the remote header is older or weaker than this device’s')
    if (theirs.version === 3) return { kind: 'adopt', header: theirs }
    if (theirs.version !== 2) throw new Refused('the remote header is v1')
    let expected: VaultHeader
    if (sameHeader(snap.header, from)) expected = from
    else if (theirs.revision > from.revision) {
      // §3.5 RemoteCas → Staged: rebuild on the highest verified header.
      if (attempt === MAX_REBUILDS) break
      from = theirs
      ;({ candidate } = await stage(d, from))
      boundary(d, 'remote')
      continue
    } else if (theirs.revision < from.revision) {
      // This device's own later header never reached the remote: only over the one it last saw there (review C9 M5).
      expected = (await readSeen(d.dataDir, d.kdfOpts)) ?? theirs
    } else throw new Refused('another device changed the vault at the same revision')
    let swapped: boolean
    try {
      swapped = await casWriteHeader(remote, snap, expected, candidate)
    } catch (e) {
      if (e instanceof RemoteChangedElsewhere) throw new Refused('another device changed the vault')
      return { kind: 'offline' }
    }
    if (swapped) return { kind: 'written', header: candidate }
  }
  throw new Refused('the sync folder kept changing')
}

/** §3.5 `local` and `floor`: the v3 header becomes this device's, then its floor; the record goes last. */
async function finish(d: PqUpgradeDeps, local: VaultHeader, header: VaultHeaderV3, adopted: boolean): Promise<void> {
  boundary(d, 'local')
  if (!sameHeader(await readJsonCapped(path(d, VAULT_FILE)).catch(() => null), header)) await writeJsonAtomic(path(d, VAULT_FILE), header)
  const pending = await readHeaderFile(path(d, PENDING_FILE), d.kdfOpts)
  if (pending && pending.revision <= header.revision) rmSync(path(d, PENDING_FILE), { force: true })
  rmSync(path(d, PREV_FILE), { force: true })
  boundary(d, 'floor')
  await updateProfileFloor(d.dataDir, header, d.keyRing.get('prefs'))
  discard(d)
  if (local.version !== 3) {
    const f = { fromRevision: local.revision, toRevision: header.revision }
    if (adopted) securityEvent.headerAdopted(f)
    else securityEvent.headerUpgraded(f)
  }
  show(3, 'done')
}

/** The remote write, then the local one; `retry` while the remote is out of reach. */
async function publish(d: PqUpgradeDeps, local: VaultHeader, base: VaultHeaderV2, candidate: VaultHeaderV3): Promise<PqUpgradeOutcome> {
  const remote = d.remote()
  let header = candidate
  let adopted = false
  if (remote) {
    boundary(d, 'remote')
    const r = await remoteCas(d, remote, local, base, candidate)
    if (r.kind === 'offline') return { state: 'retry' }
    if (r.kind === 'written' || r.kind === 'adopt') {
      header = r.header
      adopted = r.kind === 'adopt'
      await writeSeen(d.dataDir, header)
    }
  }
  await finish(d, local, header, adopted)
  return { state: 'done' }
}

/** A `committed` record whose candidate is intact goes on from the remote write (§3.5 Resume → Committed). */
async function resume(d: PqUpgradeDeps, local: VaultHeader, pending: VaultHeader | null): Promise<PqUpgradeOutcome | null> {
  const record = await readPqHeaderRecord(d.dataDir)
  const candidate = await readHeaderFile(path(d, PQ_CANDIDATE_FILE), d.kdfOpts)
  if (!record) {
    // A candidate without its record was never committed.
    if (candidate) rmSync(path(d, PQ_CANDIDATE_FILE), { force: true })
    return null
  }
  const mk = d.keyRing.get('mk')
  const usable =
    record.step === 'committed' && candidate?.version === 3 && candidate.vaultId === local.vaultId && record.vaultId === local.vaultId && candidate.revision === record.toRevision && verifyCheck(candidate, mk)
  if (!usable) {
    discard(d)
    return null
  }
  if (sameHeader(await readJsonCapped(path(d, VAULT_FILE)).catch(() => null), candidate)) {
    await finish(d, local, candidate, false)
    return { state: 'done' }
  }
  const base = [local, pending].find((h): h is VaultHeaderV2 => h?.version === 2 && h.revision === record.fromRevision && h.vaultId === local.vaultId && verifyCheck(h, mk))
  if (!base) {
    // The header it was built on is gone from this device: start over; a remote copy is then followed (Adopt).
    discard(d)
    return null
  }
  return publish(d, local, base, candidate)
}

/**
 * One pass of §3.5's machine from `Unlocked`. Classify and gate read only; from the pre-change self-test on, every
 * step runs under `exclusive`. Throws only an injected crash.
 */
export async function runPqUpgrade(d: PqUpgradeDeps): Promise<PqUpgradeOutcome> {
  try {
    return await runOnce(d)
  } catch (e) {
    if (e instanceof InjectedCrash) throw e
    const reason = e instanceof Stop ? e.message : 'failed'
    if (e instanceof Refused) discard(d)
    if (!(e instanceof Stop)) log.warn('app', 'header upgrade failed; it runs again at the next unlock', { error: e instanceof Error ? e.name : 'unknown' })
    else log.warn('app', 'header upgrade stopped', { reason })
    if (readiness.kind === 'header' && readiness.upgrade === 'running') show(readiness.version, 'none')
    return { state: 'stopped', reason }
  }
}

async function runOnce(d: PqUpgradeDeps): Promise<PqUpgradeOutcome> {
  const exclusive = d.exclusive ?? (<T>(work: () => Promise<T>) => work())
  const local = parseHeader(await readJsonCapped(path(d, VAULT_FILE)), d.kdfOpts)
  const pending = await readHeaderFile(path(d, PENDING_FILE), d.kdfOpts)
  const mk = d.keyRing.get('mk')
  if (await readPqHeaderRecord(d.dataDir)) {
    const resumed = await exclusive(() => resume(d, local, pending))
    if (resumed) return resumed
  }
  // A C9 key change (PQ-B4: a v1 upgrade or a v3 rotation) owns migration.json until its re-push, sweep and prune
  // are done; the upgrade never writes over its record, and waits for the syncs that finish it.
  if (await readRekeyRecord(d.dataDir)) {
    show(local.version, local.version === 3 ? 'done' : 'none')
    return local.version === 3 ? { state: 'done' } : { state: 'retry' }
  }
  // §3.5 classify: the highest header this session's keys verify, never a downgrade of the local one.
  const base = chooseBase(local, pending?.vaultId === local.vaultId ? pending : null, mk)
  if (base.version === 1) {
    show(1, 'offer-v1')
    return { state: 'offer-v1' }
  }
  if (base.version === 3) {
    // Already v3, or another device's v3 of these keys waits as the pending header (§3.5 Adopt, no remote write).
    await exclusive(() => finish(d, local, base, local.version !== 3))
    return { state: 'done' }
  }
  show(2, 'none')
  const blocking = await pqGateBlocking(d)
  if (blocking.length > 0) {
    show(2, 'waiting-devices', blocking)
    if (loggedWaiting !== blocking.length) securityEvent.headerUpgradeWaiting({ devices: blocking.length })
    loggedWaiting = blocking.length
    return { state: 'waiting-devices', blocking }
  }
  loggedWaiting = null
  return exclusive(async () => {
    show(2, 'running')
    if (!(await d.selfTest())) {
      show(2, 'none')
      return { state: 'selftest-failed' }
    }
    const { candidate } = await stage(d, base)
    const out = await publish(d, local, base, candidate)
    if (out.state === 'retry') show(2, 'running')
    return out
  })
}

/**
 * Resolves true after the next completed sync (its `lastSyncedAt` moved), false once the session ended. Polls: a sync
 * may be off, and turning it on is the user's call.
 */
export async function nextCompletedSync(lastSyncedAt: () => Promise<number | undefined>, active: () => boolean, pollMs = 5000): Promise<boolean> {
  const since = await lastSyncedAt().catch(() => undefined)
  while (active()) {
    await new Promise((r) => setTimeout(r, pollMs).unref?.())
    if (!active()) return false
    const at = await lastSyncedAt().catch(() => undefined)
    if (at !== undefined && at !== since) return true
  }
  return false
}

/**
 * After unlock (D-9: no prompt): the machine, run again after each completed sync while it waits for devices or for
 * the remote. Never throws; never blocks the unlock that started it.
 */
export async function startPqUpgrade(d: PqUpgradeDeps & { nextSync: () => Promise<boolean> }): Promise<void> {
  readiness = { kind: 'none' }
  loggedWaiting = null
  for (;;) {
    let out: PqUpgradeOutcome
    try {
      out = await runPqUpgrade(d)
    } catch (e) {
      log.warn('app', 'header upgrade stopped by an injected crash', { error: e instanceof Error ? e.message : 'unknown' })
      return
    }
    if (out.state !== 'waiting-devices' && out.state !== 'retry') return
    if (!(await d.nextSync())) return
  }
}

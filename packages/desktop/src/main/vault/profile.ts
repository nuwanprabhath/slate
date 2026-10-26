// The two crypto profiles (audit §4.1, listing B.14). Data, not branches: a profile is chosen when a vault
// is created, stored in its authenticated header v2, and only ever raised (`profileRank`).
import { vaultNative } from './native'
import { SUITE, type KeySchedule, type SuiteId } from './suite'

export type ProfileId = 'standard' | 'fips-140-3'
export const PROFILE_IDS: readonly ProfileId[] = ['standard', 'fips-140-3']

export interface ProfilePolicy {
  id: ProfileId
  /** The native FIPS provider must be active (status().fipsActive) before any key is derived. */
  requireFipsModule: boolean
  /** For vaults created under this profile; a header-v1 vault keeps writing suite 0x01 until it is upgraded (R-5). */
  writeSuite: SuiteId
  readSuites: ReadonlySet<SuiteId>
  kdf: { alg: 'argon2id' } | { alg: 'pbkdf2-hmac-sha512'; minIterations: number; maxIterations: number; targetMs: number }
  password: { minLength: number; normalization: 'NFC' }
  /** Minutes; null = "Never" is allowed. */
  maxIdleMinutes: number | null
  forceLockOnSleep: boolean
  forceLockOnScreenLock: boolean
  quickUnlock: boolean
  /** NIST SP 800-53 AC-7 as FedRAMP parameterises it; null = no throttle beyond the KDF cost (C10). */
  unlockThrottle: { maxFailures: number; windowMinutes: number; lockoutMinutes: number } | null
  /** False in both: the built app's CSP never allows remote images (docs/compliance/decisions.md, C8). */
  remoteImages: boolean
  /** Update packages must carry a valid detached signature from the pinned release key (C12). */
  signedUpdatesOnly: boolean
}

export const PROFILES: Readonly<Record<ProfileId, ProfilePolicy>> = {
  standard: {
    id: 'standard',
    requireFipsModule: false,
    writeSuite: SUITE.KBKDF_AES256GCM,
    readSuites: new Set<SuiteId>([SUITE.HKDF_AES256GCM, SUITE.KBKDF_AES256GCM]),
    kdf: { alg: 'argon2id' },
    password: { minLength: 10, normalization: 'NFC' },
    maxIdleMinutes: null,
    forceLockOnSleep: false,
    forceLockOnScreenLock: false,
    quickUnlock: true,
    unlockThrottle: null,
    remoteImages: false,
    signedUpdatesOnly: true,
  },
  'fips-140-3': {
    id: 'fips-140-3',
    requireFipsModule: true,
    writeSuite: SUITE.KBKDF_AES256GCM,
    // Suite 0x01 keys come from HKDF over an Argon2id KEK: never approved, so never read here.
    readSuites: new Set<SuiteId>([SUITE.KBKDF_AES256GCM]),
    kdf: { alg: 'pbkdf2-hmac-sha512', minIterations: 600_000, maxIterations: 10_000_000, targetMs: 1000 },
    // NFC in both profiles: changing normalisation would make existing passwords stop working.
    password: { minLength: 15, normalization: 'NFC' },
    maxIdleMinutes: 15,
    forceLockOnSleep: true,
    forceLockOnScreenLock: true,
    quickUnlock: false,
    unlockThrottle: { maxFailures: 3, windowMinutes: 15, lockoutMinutes: 180 },
    remoteImages: false,
    signedUpdatesOnly: true,
  },
}

/** Which envelope suites a vault reads: its profile's `readSuites` (fips-140-3 never reads 0x01). */
export function readSuitesOf(schedule: KeySchedule): ReadonlySet<SuiteId> {
  return PROFILES[schedule.profile].readSuites
}

export function isProfileId(v: unknown): v is ProfileId {
  return v === 'standard' || v === 'fips-140-3'
}

/** A device never moves a vault to a weaker profile (downgrade protection, like `revision`). */
export function profileRank(id: ProfileId): number {
  return id === 'fips-140-3' ? 1 : 0
}

/** Clamps a stored idle setting to the profile; 0 means "Never" in the settings schema. */
export function effectiveIdleMinutes(stored: number, policy: ProfilePolicy): number {
  if (policy.maxIdleMinutes === null) return stored
  return stored === 0 ? policy.maxIdleMinutes : Math.min(stored, policy.maxIdleMinutes)
}

/** AC-12 / SC-7 lock triggers: a profile may force them on; `stored` is the user's setting (absent = on, the default). */
export function locksOnSleep(policy: ProfilePolicy, stored: boolean | undefined): boolean {
  return policy.forceLockOnSleep || stored !== false
}

export function locksOnScreenLock(policy: ProfilePolicy, stored: boolean | undefined): boolean {
  return policy.forceLockOnScreenLock || stored !== false
}

/** A fips-140-3 vault on a build or machine where the FIPS provider is not active (audit §4.1, POST-MODULE-STATUS). */
export class FipsModuleRequired extends Error {
  override name = 'FipsModuleRequired'
  constructor() {
    super('This vault uses the FIPS 140-3 profile, and this copy of Slate is not running its validated cryptographic module')
  }
}

/** A standard vault after a fips-140-3 vault latched this process approved-only (criterion 2). */
export class ProfileLatched extends Error {
  override name = 'ProfileLatched'
  constructor() {
    super('Slate opened a FIPS 140-3 vault in this session. Quit and reopen Slate to open a standard vault')
  }
}

/** Whether this build runs the approved module, so the wizard may offer the FIPS 140-3 profile (decisions.md). */
export function fipsProfileAvailable(): boolean {
  try {
    return vaultNative().status().fipsActive
  } catch {
    return false
  }
}

const LABEL: Record<ProfileId, string> = { standard: 'standard', 'fips-140-3': 'FIPS 140-3' }

/**
 * A rejoin across profiles (review C5 M1): refused before anything is derived from the other vault's header.
 * Moving notes between profiles is the C9 conversion, never a rejoin.
 */
export class ProfileMismatch extends Error {
  override name = 'ProfileMismatch'
  constructor(device: ProfileId, remote: ProfileId) {
    super(
      `This sync folder holds a ${LABEL[remote]} vault, and this device's notes are in a ${LABEL[device]} vault. A device cannot move between ` +
        'the two by joining: export your notes, then join that sync folder from a device whose notes are not encrypted.',
    )
  }
}

/**
 * Before the first key of a vault under `id` is derived, from a header nobody has verified yet: refuses only,
 * and changes nothing. A fips-140-3 vault needs the module in approved mode; a standard vault cannot be opened
 * once a fips-140-3 vault latched this process (its password KDF is Argon2id).
 */
export function checkProfileUsable(id: ProfileId): void {
  const s = vaultNative().status()
  if (PROFILES[id].requireFipsModule && !s.fipsActive) throw new FipsModuleRequired()
  if (!PROFILES[id].requireFipsModule && s.approvedKeysOnly) throw new ProfileLatched()
}

/**
 * Once a fips-140-3 header has verified under its MK (or a new vault is committed), the module latches
 * approved-only for the rest of the process: SQLCipher refuses non-approved keys, and Argon2id, RFC 5869 HKDF and
 * AES-ECB refuse to run (C4's `requireApprovedKeys`, C5 criterion 2). Never from an unverified header (review C5
 * M1): a forged one would otherwise lock the device out of its own standard vault until a restart.
 */
export function latchProfile(id: ProfileId): void {
  if (PROFILES[id].requireFipsModule) vaultNative().requireApprovedKeys()
}

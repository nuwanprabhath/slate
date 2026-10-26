// The cipher-suite registry (audit §4.5.1) and the key schedule a vault header selects. A suite fixes
// the key schedule, the envelope and the remote names; a reader refuses an unknown or disallowed suite
// before it touches any key.
import type { ProfileId } from './profile'

export const SUITE = {
  /** `SLATE-1-HKDF-GCM`: header-v1 vaults only, read by the standard profile until C9 upgrades them. */
  HKDF_AES256GCM: 0x01,
  /** `SLATE-2-KBKDF-GCM`: every vault created since C5, in both profiles. */
  KBKDF_AES256GCM: 0x02,
} as const
export type SuiteId = (typeof SUITE)[keyof typeof SUITE]

/**
 * How a vault's master key becomes its subkeys, and under which profile. Suite 0x01: RFC 5869 HKDF with an
 * empty salt (the v1 read path, vault/suite1.ts), always the standard profile. Suite 0x02: SP 800-108r1 KBKDF
 * with the purpose as Label and the vault id's 16 bytes as Context (audit §4.5.2, listing B.13).
 */
export type KeySchedule =
  | { readonly suite: typeof SUITE.HKDF_AES256GCM; readonly profile: 'standard' }
  | { readonly suite: typeof SUITE.KBKDF_AES256GCM; readonly vaultId: string; readonly profile: ProfileId; readonly keyEpoch: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const SCHEDULE_V1: KeySchedule = { suite: SUITE.HKDF_AES256GCM, profile: 'standard' }

export function scheduleV2(vaultId: string, profile: ProfileId, keyEpoch = 0): KeySchedule {
  if (!UUID.test(vaultId)) throw new Error('A suite 0x02 key schedule needs the vault id')
  return { suite: SUITE.KBKDF_AES256GCM, vaultId, profile, keyEpoch }
}

/** The key epoch whose MK a schedule derives from: suite 0x01 has only epoch 0. */
export function epochOf(schedule: KeySchedule): number {
  return schedule.suite === SUITE.KBKDF_AES256GCM ? schedule.keyEpoch : 0
}

/** `vid`: the 16 bytes of a vault id (uuid hex without dashes), the KBKDF Context of every suite-0x02 subkey. */
export function vidOf(vaultId: string): Uint8Array {
  if (!UUID.test(vaultId)) throw new Error('Not a vault id')
  return new Uint8Array(Buffer.from(vaultId.replace(/-/g, ''), 'hex'))
}

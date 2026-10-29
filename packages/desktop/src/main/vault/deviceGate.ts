import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PqWaiting } from '../../shared/api'
import { SEEN_FILE } from './seen'
import { SYNCED_FILE } from './unlock'

/** The post-quantum header capability (v3) this build writes into its device record. */
export const PQ_CAPABILITY = 1

export interface CapabilityRecord {
  name: string
  epochs?: number
  pq?: number
  /** This device's own record (`devices/<deviceId>.json`, as the sync engine names it). */
  own?: boolean
}

/**
 * Every record that lacks `cap` at `level` or above. A record that could not be read arrives with no capability
 * fields (see `SyncService.deviceRecords`), so it is listed too: an unknown device blocks the upgrade.
 */
export function devicesLacking<T extends CapabilityRecord>(records: readonly T[], cap: 'epochs' | 'pq', level: number): T[] {
  return records.filter((d) => {
    const v = d[cap]
    return !(typeof v === 'number' && v >= level)
  })
}

/**
 * D-7, review C9 L3: a device record that does not carry the key-epoch capability (written by every build that can
 * follow a key change), or that cannot be read at all, blocks the upgrade, the rotation and the conversion: such a
 * device would call the new vault file damaged, and one of 0.1.x would write its own header over it on a password
 * change (review C5 L5). Version numbers are not compared: development builds all report 0.1.0, and a build with C5
 * but not C9 would pass any release number while forking a rotated header.
 */
export function devicesBlocking<T extends CapabilityRecord>(records: readonly T[]): T[] {
  return devicesLacking(records, 'epochs', 1)
}

/**
 * Review C9 M5: whether this data folder has synced with a remote: a header seen there, the synced marker, a git
 * clone, or (`more`) sync settings or bookkeeping in the notes database.
 */
export async function hasSyncedBefore(dataDir: string, more?: () => Promise<boolean>): Promise<boolean> {
  if (existsSync(join(dataDir, SYNCED_FILE)) || existsSync(join(dataDir, SEEN_FILE))) return true
  try {
    if (readdirSync(join(dataDir, 'git-sync'), { withFileTypes: true }).some((e) => e.isDirectory())) return true
  } catch {
    // No clones.
  }
  return (await more?.()) ?? false
}

export interface PqGateDeps {
  dataDir: string
  /** The sync remote, or null while sync is off. */
  remote: () => unknown
  /** Every device record on the remote; a throw means they cannot be read. */
  devices?: () => Promise<CapabilityRecord[]>
  syncedBefore?: () => Promise<boolean>
}

/**
 * Roadmap §3.5 `gate` (INV-PQ-5): why header v3 must stay off this vault, or null when it may be written (by the
 * v2 → v3 upgrade, a v1 upgrade, or a new vault). The devices that lack pq are named; an unreadable record list, or
 * sync off on a vault that has synced (its other devices cannot be asked), blocks too. This device's own record is
 * left out: this build reads v3, and the record may still be the older build's until this build's first sync.
 */
export async function pqGateBlocking(d: PqGateDeps): Promise<PqWaiting | null> {
  if (!d.remote()) return (await hasSyncedBefore(d.dataDir, d.syncedBefore)) ? { reason: 'sync-off' } : null
  if (!d.devices) return { reason: 'devices-unreadable' }
  let records: CapabilityRecord[]
  try {
    records = await d.devices()
  } catch {
    return { reason: 'devices-unreadable' }
  }
  const lacking = devicesLacking(records.filter((r) => r.own !== true), 'pq', 1)
  return lacking.length > 0 ? { reason: 'devices', devices: lacking.map((r) => r.name) } : null
}

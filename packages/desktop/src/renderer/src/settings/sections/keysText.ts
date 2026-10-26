import type { RekeyKind, VaultKeysInfo } from '../../../../shared/api'

export const REKEY_TITLE: Readonly<Record<RekeyKind, string>> = {
  rotate: 'Rotate keys',
  upgrade: 'Upgrade encryption format',
  convert: 'Convert to FIPS 140-3',
}

/** What each key change does, before the password is asked for (audit §4.7 R-1, R-3, R-5). */
export function rekeyIntro(kind: RekeyKind): string {
  if (kind === 'rotate') {
    return 'Makes a new master key and a new recovery key, and re-encrypts your notes here and in the sync folder. Your password stays the same; your other devices follow when they next unlock with it.'
  }
  if (kind === 'upgrade') {
    return 'Moves this vault to the version 2 encryption format (SP 800-108 key derivation, authenticated file names) under a new master key and a new recovery key. Your password stays the same. Older files stay readable until every device has synced.'
  }
  return 'Converts this vault to the FIPS 140-3 profile for good: PBKDF2 for the password, which must be at least 15 characters, no Touch ID or keyring unlock, and only approved algorithms. Your notes are re-encrypted under new keys and every other device asks for the new password. Older encryption keys are discarded, not kept. This cannot be undone.'
}

const day = (ms: number): string => new Date(ms).toLocaleDateString()

const PROGRESS: Readonly<Record<NonNullable<VaultKeysInfo['inProgress']>, string>> = {
  repush: 'Syncing your notes under the new keys.',
  sweep: 'Removing the files sealed under the old keys from the sync folder.',
  prune: 'Dropping the old keys once no synced file needs them.',
}

/** The lines Settings → Security shows about the keys, each with its test id. */
export function keysInfoText(info: VaultKeysInfo): { lines: string[]; testIds: string[] } {
  const lines: string[] = []
  const testIds: string[] = []
  const add = (id: string, line: string) => {
    lines.push(line)
    testIds.push(id)
  }
  add('security-keys-epoch', `Encryption format version ${info.headerVersion}, key epoch ${info.keyEpoch}, keys made ${day(info.createdAt)}.`)
  if (info.rotationDueSince !== null) add('security-rotation-due', `Keys are due for rotation (since ${day(info.rotationDueSince)}). The FIPS 140-3 profile uses a master key for at most two years.`)
  if (info.inProgress) add('security-rekey-progress', `A key change is still under way: ${PROGRESS[info.inProgress]} Keep sync on until it finishes.`)
  if (info.blockingDevices.length > 0) {
    const names = info.blockingDevices.map((d) => `${d.name} (${d.appVersion ?? 'version unknown'})`).join(', ')
    add('security-devices-blocking', `Update Slate on every device before changing keys: ${names}. Older versions cannot read the new vault file.`)
  }
  if (info.devicesUnknown) add('security-devices-unknown', `Slate could not check your other devices (${info.devicesUnknown}), so key changes wait until sync works.`)
  if (info.headerVersion === 1 && info.canUpgrade) add('security-upgrade-offer', 'This vault uses the version 1 format. Every device runs a version that reads version 2, so it can be upgraded.')
  return { lines, testIds }
}

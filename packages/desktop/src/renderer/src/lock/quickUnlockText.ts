import type { QuickUnlockKind } from '../../../shared/api'

/** The banner after quick unlock failed and the password worked, naming what this computer unlocks with. */
export function quickUnlockOfferText(kind: QuickUnlockKind): string {
  return `${kind === 'keyring' ? 'Unlock with the system keyring' : 'Touch ID unlock'} stopped working. Set it up again?`
}

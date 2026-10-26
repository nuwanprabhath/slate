import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const IMPORT_ENCRYPTED_MESSAGE = "Slate's notes are encrypted. Run the import from the app while it is unlocked."

/** Encrypted data folders are opened only by the running app; the CLIs check this before touching anything. */
export function vaultExists(dataDir: string): boolean {
  return existsSync(join(dataDir, 'vault.json'))
}

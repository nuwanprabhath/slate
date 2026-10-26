import { join } from 'node:path'

/**
 * Audit C8 criterion 3: a secret sealed by the synchronous `safeStorage.encryptString` of the audited (pre-C8)
 * build, on the maintainer's Mac (Keychain item "Slate Safe Storage"). `safeStorageMigration.keychain.ts` opens it
 * with the async API this build uses (`npm run e2e:keychain`).
 */
export const SYNC_SEALED_FIXTURE = join(__dirname, 'fixtures', 'safe-storage-sync-sealed.json')

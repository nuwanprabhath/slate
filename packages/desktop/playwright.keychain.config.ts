import { defineConfig } from '@playwright/test'

// Audit C8 criterion 3: a secret sealed by the pre-C8 synchronous safeStorage API opens with the async one. The
// fixture opens only with the key in the maintainer's macOS Keychain ("Slate Safe Storage"), so this runs on the
// maintainer's Mac (`npm run e2e:keychain`, may show a Keychain prompt); `npm run e2e` and CI never match it.
export default defineConfig({ testDir: 'e2e', testMatch: '**/*.keychain.ts', timeout: 60_000, workers: 1, reporter: 'list', globalSetup: './e2e/tmpRoot.ts' })

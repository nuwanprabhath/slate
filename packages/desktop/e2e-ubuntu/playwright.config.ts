import { defineConfig } from '@playwright/test'

// The Mac + Ubuntu 24.04 cross-device scenarios (README.md here). One container and one Mac app pair at a
// time, so one worker; a scenario restarts apps and waits on git syncs, hence the long timeouts.
export default defineConfig({
  testDir: '.',
  testMatch: 'crossDevice.spec.ts',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
  globalSetup: './globalSetup.ts',
})

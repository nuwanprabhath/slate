import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (ELECTRON_RUN_AS_NODE=1): the main process's runtime, with slate_native.node (SQLCipher inside).
// testTimeout is this suite's own floor, not vitest's 5 s default, which was never chosen for it: every case here opens a
// real encrypted database, and many spawn git or a shell script. Measured over four full `npm run test:main` runs on a
// 10-core Mac at load average 10-25, the slowest case still on the default cost 3.7 s, and the same case varied by 2.8x
// between a quiet and a busy run. 15 s is 4x that measured worst case; a case that genuinely needs longer declares its own,
// and a hung test still fails inside a quarter of a minute.
export default defineConfig({ test: { environment: 'node', expect: { requireAssertions: true }, include: ['src/main/**/*.test.ts'], setupFiles: ['src/main/testSetup.ts'], testTimeout: 15_000 } })

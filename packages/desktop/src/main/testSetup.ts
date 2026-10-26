import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provideDbModule } from './db/dbModule'
import { startTestDbModule } from './db/testModule'

// Each test file gets its own temp dir: cleanupPlaintext (via createEncryptedDataDir) clears every
// `slate-one2html-*` dir in tmpdir(), which would delete a parallel import test's converter output.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'slate-test-'))

// SQLCipher lives in slate_native.node (audit C3): the first database a test opens starts the module.
provideDbModule(startTestDbModule)

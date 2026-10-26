import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { SYNC_SEALED_FIXTURE } from './syncSealedFixture'

const electron = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'electron')

test('C8 criterion 3: a blob sealed by the pre-C8 synchronous API opens with the async one', () => {
  const { plain } = JSON.parse(readFileSync(SYNC_SEALED_FIXTURE, 'utf8')) as { plain: string }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(electron, [join(__dirname, 'keychain', 'openSealed.cjs'), SYNC_SEALED_FIXTURE], { env, encoding: 'utf8', timeout: 50_000 })
  const line = run.stdout.split('\n').find((l) => l.startsWith('OPENED ') || l.startsWith('FAILED ')) ?? `no result: ${run.stderr}`
  expect(line).toBe(`OPENED ${JSON.stringify(plain)}`)
})

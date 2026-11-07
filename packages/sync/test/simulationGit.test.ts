// The simulation over real git: three clones of one bare repository. Apart from simulation.test.ts so the two
// run side by side.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { inheritedEnv } from '../src/childEnv'
import { GitDrive } from '../src/gitDrive'
import { nodeGitRunner } from '../src/gitRunner'
import { expectConverged, simulate, type Drives } from './simulation'

describe('three-device simulation', () => {
  it('converges over git clones of one bare repo', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'slate-sim-'))
    try {
      const bare = join(root, 'remote.git')
      // Without an inherited GIT_DIR (a git hook's), which would make that repository bare instead.
      execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { env: inheritedEnv() })
      const run = nodeGitRunner()
      const drives: Drives = (id) =>
        new GitDrive({ run, dir: join(root, id), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}), author: { name: id, email: `${id}@test.local` } })
      expectConverged(await simulate(1, 200, drives))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

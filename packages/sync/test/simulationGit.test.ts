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
  // The whole three-device simulation, but over real git clones of a bare repo rather than memory drives, so every
  // step is git child processes. Measured over four runs at load average 23-27: 44.3, 70.3, 70.3 and 72.4 s, against
  // 120 s, i.e. 1.7x, and it timed out. 240 s is 3.3x the measured worst case. The 70 s itself is the cost of the
  // scenario, not of waiting: nothing in this file sleeps or polls.
  it('converges over git clones of one bare repo', { timeout: 240_000 }, async () => {
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

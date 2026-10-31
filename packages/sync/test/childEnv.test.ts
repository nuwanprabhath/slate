import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inheritedEnv } from '../src/childEnv'
import { nodeGitRunner } from '../src/gitRunner'

const temps: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-env-'))
  temps.push(dir)
  return dir
}

/** git run outside the code under test, with no inherited GIT_* variables. */
function plainGit(args: string[], cwd: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
}

describe('the environment git children inherit', () => {
  it('leaves out the variables that tell git which repository to act on', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_NAMESPACE', 'GIT_PREFIX'])
      vi.stubEnv(name, 'x')
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
    const env = inheritedEnv()
    expect(Object.keys(env).filter((k) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|CONFIG_|NAMESPACE|PREFIX)/.test(k))).toEqual([])
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.GIT_SSH_COMMAND).toBe('ssh')
  })

  it('a sync started under a git hook (GIT_DIR set) never touches that repository', async () => {
    // A pre-push hook runs with GIT_DIR pointing at the repository being pushed: a test or a Slate
    // started there once made that repository bare.
    const decoy = temp()
    plainGit(['init', '-q'], decoy)
    vi.stubEnv('GIT_DIR', join(decoy, '.git'))
    vi.stubEnv('GIT_WORK_TREE', decoy)
    const work = temp()
    const run = nodeGitRunner()
    await run(['init', '-q'], { cwd: work })
    await run(['config', 'core.bare', 'true'], { cwd: work })
    expect(plainGit(['config', '--get', 'core.bare'], decoy)).toBe('false')
    expect(existsSync(join(work, '.git'))).toBe(true)
  })
})

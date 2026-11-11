// A git command's deadline is sized from the work it does, and a command that outruns it is a
// timeout, never `offline` (B8). D4B measured a 2,000-page vault whose first sync against a fresh
// remote could not finish inside the old fixed 10 s / 60 s, reported `Offline`, and retried forever.
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { GitDrive } from '../src/gitDrive'
import { SyncEngine } from '../src/engine'
import {
  LOCAL_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  PER_FILE_LOCAL_MS,
  PER_FILE_NETWORK_MS,
  gitTimeout,
  nodeGitRunner,
  type GitResult,
  type GitRunOptions,
  type GitRunner,
} from '../src/gitRunner'
import { OfflineError, SyncTimeoutError } from '../src/types'
import { memoryLocal } from './memoryLocal'
import { bareRepo, removeTemps, run, temp } from './gitWorld'

afterEach(removeTemps)

/** A child that prints `chunks` lines `everyMs` apart and then exits; `node` stands in for git. */
const printer = (chunks: number, everyMs: number) =>
  nodeGitRunner(process.execPath)(
    [
      '-e',
      `let n = 0
       const timer = setInterval(() => {
         process.stderr.write('working ' + ++n + '\\n')
         if (n === ${chunks}) { clearInterval(timer); process.exit(0) }
       }, ${everyMs})`,
    ],
    { timeoutMs: 20_000, quietMs: everyMs * 8 },
  )

/** A child that says nothing and never exits. */
const silent = (opts: GitRunOptions) => nodeGitRunner(process.execPath)(['-e', 'setInterval(() => {}, 1000)'], opts)

describe('gitTimeout', () => {
  it('is the floor for a command that touches nothing', () => {
    expect(gitTimeout('local')).toBe(LOCAL_TIMEOUT_MS)
    expect(gitTimeout('network')).toBe(NETWORK_TIMEOUT_MS)
  })

  it('grows with the files the command touches', () => {
    expect(gitTimeout('local', 2_000)).toBe(LOCAL_TIMEOUT_MS + 2_000 * PER_FILE_LOCAL_MS)
    expect(gitTimeout('network', 2_000)).toBe(NETWORK_TIMEOUT_MS + 2_000 * PER_FILE_NETWORK_MS)
    // The measurement this is sized from: `git add -A` costs 2.9 s and `git push` 3.3 s at 2,000
    // files on an idle machine, and five to ten times that under the load D4B measured.
    expect(gitTimeout('local', 2_000)).toBeGreaterThan(5 * 2_900)
    expect(gitTimeout('network', 2_000)).toBeGreaterThan(5 * 3_300)
    expect(gitTimeout('local', 8_000)).toBeGreaterThan(gitTimeout('local', 2_000))
  })

  it('stops growing: past the cap a command is hung, not slow', () => {
    expect(gitTimeout('local', 10_000_000)).toBe(MAX_TIMEOUT_MS)
    expect(gitTimeout('network', 10_000_000)).toBe(MAX_TIMEOUT_MS)
  })
})

// Real child processes with real timers, measured: the four cases below cost 0.3-2.6 s together on a
// loaded 10-core Mac, so 30 s is more than 10x the worst seen.
describe('a git child that outruns its deadline', { timeout: 30_000 }, () => {
  it('is killed at the ceiling and says it timed out', async () => {
    const r = await silent({ timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
    expect(r.quiet).toBe(false)
    expect(r.deadlineMs).toBe(400)
    expect(r.code).toBe(-1)
  })

  it('is not killed while it is still producing output', async () => {
    const r = await printer(10, 40)
    expect(r.timedOut).toBe(false)
    expect(r.code).toBe(0)
    // It ran for ~400 ms, four times the quiet window it would have been killed by.
    expect(r.stderr).toContain('working 10')
  })

  it('is killed once it goes quiet, although its ceiling is far off', async () => {
    const started = Date.now()
    const r = await nodeGitRunner(process.execPath)(
      ['-e', "process.stderr.write('working\\n'); setInterval(() => {}, 1000)"],
      { timeoutMs: 60_000, quietMs: 300 },
    )
    expect(r.timedOut).toBe(true)
    expect(r.quiet).toBe(true)
    expect(r.deadlineMs).toBe(300)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('is never killed for being quiet when it was never asked to talk', async () => {
    const r = await silent({ timeoutMs: 400 })
    expect(r.quiet).toBe(false)
  })
})

/** A runner that answers every command from `git`, except the one whose name is `timeOut`. */
function timingOutRunner(timeOut: string): { run: GitRunner; timeouts: Array<{ args: string[]; timeoutMs: number | undefined }> } {
  const timeouts: Array<{ args: string[]; timeoutMs: number | undefined }> = []
  const runner: GitRunner = async (args, opts = {}): Promise<GitResult> => {
    timeouts.push({ args, timeoutMs: opts.timeoutMs })
    if (args[0] === timeOut) return { code: -1, stdout: new Uint8Array(), stderr: '', timedOut: true, quiet: false, deadlineMs: opts.timeoutMs ?? 0 }
    return run(args, opts)
  }
  return { run: runner, timeouts }
}

const chunk = (n: number) => `docs/page_66666666-6666-4666-8666-666666666666/A/0000000${n}.chunk`

// Real git in a temp clone, like `gitDrive.test.ts`: measured 1.0-3.4 s for this block on a loaded
// machine, so 60 s is ~18x the worst seen (and the same shape of budget as that file's 90 s).
describe('GitDrive when git runs out of time', { timeout: 60_000 }, () => {
  it('fails as a timeout and not as offline', async () => {
    const timing = timingOutRunner('push')
    const drive = new GitDrive({
      run: timing.run,
      dir: join(temp(), 'repo'),
      remoteUrl: bareRepo(),
      branch: 'main',
      authEnv: async () => ({}),
      author: { name: 'A', email: 'a@test.local' },
    })
    const err = await drive.flush().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SyncTimeoutError)
    expect(err).not.toBeInstanceOf(OfflineError)
    expect((err as SyncTimeoutError).timedOut).toBe(true)
    expect((err as { offline?: unknown }).offline).toBeUndefined()
    // The message says what happened and what the person can expect, not "you are offline".
    expect((err as Error).message).toMatch(/Sync gave up waiting for git push/)
    expect((err as Error).message).toMatch(/try again/)
  })

  it('makes a sync run report `error`, not `offline`', async () => {
    const timing = timingOutRunner('push')
    const local = memoryLocal()
    const remote = new GitDrive({
      run: timing.run,
      dir: join(temp(), 'repo'),
      remoteUrl: bareRepo(),
      branch: 'main',
      authEnv: async () => ({}),
      author: { name: 'A', email: 'a@test.local' },
    })
    const report = await new SyncEngine({ local, remote, deviceId: 'A', deviceName: 'A' }).syncOnce()
    expect(report.status).toBe('error')
    expect(report.message).toMatch(/gave up waiting/)
  })

  it('gives a command over many files proportionally longer', async () => {
    const timing = timingOutRunner('never')
    const drive = new GitDrive({
      run: timing.run,
      dir: join(temp(), 'repo'),
      remoteUrl: bareRepo(),
      branch: 'main',
      authEnv: async () => ({}),
      author: { name: 'A', email: 'a@test.local' },
    })
    const files = 40
    for (let i = 0; i < files; i++) await drive.upload(chunk(i), new Uint8Array([i]))
    await drive.flush()
    const of = (name: string) => timing.timeouts.filter((t) => t.args[0] === name).at(-1)?.timeoutMs ?? 0
    expect(of('add')).toBeGreaterThanOrEqual(gitTimeout('local', files))
    expect(of('push')).toBeGreaterThanOrEqual(gitTimeout('network', files))
    // The clone's first push, before anything was written, is the floor: nothing to size it from.
    expect(timing.timeouts.filter((t) => t.args[0] === 'push')[0]?.timeoutMs).toBe(NETWORK_TIMEOUT_MS)
  })
})

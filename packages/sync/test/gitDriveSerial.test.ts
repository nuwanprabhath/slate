// Two callers on one clone (a sync run, and whatever else reaches the same remote: an image fetched
// for the window, the settings panel listing devices). Git keeps one index per clone, so the drive
// runs one command at a time; concurrent `git add`s lose the race for `index.lock` (B6).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitDrive } from '../src/gitDrive'
import type { GitResult, GitRunner } from '../src/gitRunner'
import { bareRepo, removeTemps, run, temp } from './gitWorld'

afterEach(removeTemps)

/** Counts how many git commands were in flight at once. */
function countingRunner(): { run: GitRunner; peak: number; commands: string[] } {
  let inFlight = 0
  const state = { peak: 0, commands: [] as string[], run: null as unknown as GitRunner }
  state.run = async (args, opts): Promise<GitResult> => {
    inFlight++
    state.peak = Math.max(state.peak, inFlight)
    state.commands.push(args.join(' '))
    try {
      return await run(args, opts)
    } finally {
      inFlight--
    }
  }
  return state as { run: GitRunner; peak: number; commands: string[] }
}

const chunk = (n: number) => `docs/page_55555555-5555-4555-8555-555555555555/A/0000000${n}.chunk`

describe('GitDrive on one clone', { timeout: 30_000 }, () => {
  it('runs one git command at a time however many callers it has', async () => {
    const counting = countingRunner()
    const drive = new GitDrive({
      run: counting.run,
      dir: join(temp(), 'repo'),
      remoteUrl: bareRepo(),
      branch: 'main',
      authEnv: async () => ({}),
      author: { name: 'A', email: 'a@test.local' },
    })
    await drive.upload(chunk(1), new Uint8Array([1]))
    // Both callers start before either answers: on one index, that is the race.
    const [flushed, page] = await Promise.all([drive.flush().then(() => 'flushed'), drive.delta(null)])
    expect(flushed).toBe('flushed')
    expect(page.items.map((i) => i.path).sort()).toEqual(['README.md', chunk(1)].sort())
    expect(counting.peak).toBe(1)
    expect(counting.commands.some((c) => c.startsWith('add'))).toBe(true)
  })

  it('serves a second caller after the first, not inside it', async () => {
    const counting = countingRunner()
    const drive = new GitDrive({
      run: counting.run,
      dir: join(temp(), 'repo'),
      remoteUrl: bareRepo(),
      branch: 'main',
      authEnv: async () => ({}),
      author: { name: 'A', email: 'a@test.local' },
    })
    const uploads = [1, 2, 3].map((n) => drive.upload(chunk(n), new Uint8Array([n])))
    const removal = drive.remove(chunk(1))
    await Promise.all([...uploads, removal, drive.flush()])
    expect(counting.peak).toBe(1)
    expect(await drive.download(chunk(2))).toEqual(new Uint8Array([2]))
  })
})

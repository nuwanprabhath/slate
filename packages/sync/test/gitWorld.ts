// Git remotes and devices for the GitDrive tests: bare repositories and clones in temp folders, removed after each test.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../src/engine'
import { GitDrive } from '../src/gitDrive'
import { inheritedEnv } from '../src/childEnv'
import { nodeGitRunner } from '../src/gitRunner'
import { memoryLocal } from './memoryLocal'

export const PAGE = 'page:44444444-4444-4444-8444-444444444444'
export const run = nodeGitRunner()
/** git for the test's own setup, never pointed at another repository by an inherited GIT_DIR (a git hook's). */
export const gitSync = (args: string[], opts: { input?: string } = {}) => execFileSync('git', args, { ...opts, env: inheritedEnv() })
export const temps: string[] = []

export function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-git-'))
  temps.push(dir)
  return dir
}

/** Removes the folders `temp` made; each test file runs it after every test. */
export function removeTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function bareRepo(): string {
  const dir = temp()
  gitSync(['init', '--bare', '--initial-branch=main', dir])
  return `file://${dir}`
}

export function drive(remoteUrl: string, name: string, authEnv = async () => ({})): GitDrive {
  return new GitDrive({ run, dir: join(temp(), 'repo'), remoteUrl, branch: 'main', authEnv, author: { name, email: `${name}@test.local` } })
}

export function device(remoteUrl: string, id: string) {
  const local = memoryLocal()
  const remote = drive(remoteUrl, id)
  return { local, remote, engine: new SyncEngine({ local, remote, deviceId: id, deviceName: id, compactAfter: 2 }) }
}

export const log = (url: string) => gitSync(['--git-dir', url.slice('file://'.length), 'log', '--format=%s', 'main']).toString()

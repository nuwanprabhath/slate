// The environment-level defences on the git child: which protocols it may speak (B6/F8), and that a
// stopped sync leaves no child process running. The URL allow-list itself is the desktop's (review C3).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALLOWED_PROTOCOLS, PROMPT_FREE_ENV, isLocalRemote, nodeGitRunner, protocolEnv } from '../src/gitRunner'
import { bareRepo, drive, removeTemps, run, temp } from './gitWorld'

afterEach(removeTemps)

/** A stand-in for `git` that reports its own pid and then waits: a transfer that has not finished. */
function slowGit(): { path: string; pidFile: string } {
  const dir = temp()
  const path = join(dir, 'slow-git')
  // `exec`, so the pid reported is the one holding the pipes: killing it ends the whole child.
  writeFileSync(path, '#!/bin/sh\necho $$ > "$1"\nexec sleep 60\n')
  chmodSync(path, 0o755)
  return { path, pidFile: join(dir, 'pid') }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Two cases here run real git against a bare repository in a temp folder (an `ls-remote`, and a first
// clone with its README commit and push), which cost seconds, not milliseconds: the 5 s default left
// the clone case 0.9x on a loaded machine. 60 s is about 10x the slowest observed case.
describe('the git child', { timeout: 60_000 }, () => {
  it('speaks only https and ssh, and file for a local remote', () => {
    expect(PROMPT_FREE_ENV.GIT_ALLOW_PROTOCOL).toBe(ALLOWED_PROTOCOLS)
    expect(ALLOWED_PROTOCOLS).not.toMatch(/ext|file/)
    expect(protocolEnv('https://github.com/o/r.git').GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(protocolEnv('ext::sh -c cat').GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(protocolEnv('file:///tmp/r').GIT_ALLOW_PROTOCOL).toBe('https:ssh:file')
    expect(protocolEnv('/tmp/r').GIT_ALLOW_PROTOCOL).toBe('https:ssh:file')
    expect([isLocalRemote('git@github.com:o/r.git'), isLocalRemote('ssh://h/r'), isLocalRemote('../r')]).toEqual([false, false, true])
  })

  it('refuses an ext:: remote although this repository config allows it', async () => {
    const r = await run(['-c', 'protocol.ext.allow=always', 'ls-remote', '--', 'ext::sh -c "echo 0000"'], { cwd: temp(), timeoutMs: 20_000 })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/transport 'ext' not allowed|protocol/i)
  })

  it('still reaches a local remote, which the tests and the e2e sync against', async () => {
    const url = bareRepo()
    expect((await drive(url, 'A').delta(null)).items.map((i) => i.path)).toEqual(['README.md'])
  })

  it('kills the child when the sync is stopped, leaving nothing running', async () => {
    const { path, pidFile } = slowGit()
    const controller = new AbortController()
    const started = nodeGitRunner(path)([pidFile], { timeoutMs: 30_000, signal: controller.signal })
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 10))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(pid)).toBe(true)
    controller.abort()
    const result = await started
    expect(result.aborted).toBe(true)
    expect(result.code).toBe(-1)
    expect(alive(pid)).toBe(false)
  })

  it('does not start a child at all once the signal has aborted', async () => {
    const { path, pidFile } = slowGit()
    const result = await nodeGitRunner(path)([pidFile], { timeoutMs: 30_000, signal: AbortSignal.abort() })
    expect(result.aborted).toBe(true)
  })
})

#!/usr/bin/env node
// pre-push (.githooks/pre-push): main leaves this machine only when the maintainer has confirmed every
// guard-file change it carries since the remote's main, with `scripts/agents/merge-wp.sh
// --confirm-guard-changes` (batch mode: one Keychain-confirmed signature over the whole guard diff).
// Agents never push; this is the maintainer's last look before a push or release.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { confirmations, CONFIRMATIONS_FILE, guardDiffWith, pushConfirmed, unacceptedCommits } from './review-gate.mjs'

const ZERO = /^0+$/

/** The pushes to the remote's main in pre-push's stdin (`<local ref> <local sha> <remote ref> <remote sha>`); remote null for a new main. */
export function mainPushes(stdin) {
  return stdin
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4 && p[2] === 'refs/heads/main' && !ZERO.test(p[1]))
    .map(([, local, , remote]) => ({ remote: ZERO.test(remote) ? null : remote, local }))
}

function main() {
  const here = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const git = (...args) => spawnSync('git', args, { cwd: here, encoding: 'utf8' }).stdout ?? ''
  const commonDir = resolve(here, git('rev-parse', '--git-common-dir').trim())
  const pubFile = join(dirname(commonDir), 'tools/guards/unlock-key.pub')
  const confirmationsFile = join(commonDir, CONFIRMATIONS_FILE)
  const fail = (msg) => {
    process.stderr.write(`pre-push: ${msg}\n`)
    process.exit(1)
  }
  for (const { remote, local } of mainPushes(readFileSync(0, 'utf8'))) {
    if (remote === null) fail('pushing a new main: there is no remote main to compare guard files against. Push it by hand once, deliberately.')
    if (spawnSync('git', ['cat-file', '-e', `${remote}^{commit}`], { cwd: here }).status !== 0) fail(`the remote main ${remote.slice(0, 12)} is not here; git fetch first.`)
    const ok = pushConfirmed({
      guardDiff: guardDiffWith(git),
      confirmations: existsSync(confirmationsFile) ? readFileSync(confirmationsFile, 'utf8') : '',
      publicKey: existsSync(pubFile) ? readFileSync(pubFile, 'utf8') : null,
      remote,
      local,
    })
    if (!ok) fail(`main carries guard-file changes since ${remote.slice(0, 12)} that are not confirmed. Read and confirm them: scripts/agents/merge-wp.sh --confirm-guard-changes ${remote.slice(0, 12)}..${local.slice(0, 12)}`)
    // Every commit new on main's first-parent line is a merge merge-wp made and signed, or lies in a
    // range the maintainer confirmed (red team final F-3: a plain `git merge` skips review and checks).
    const publicKey = existsSync(pubFile) ? readFileSync(pubFile, 'utf8') : null
    const commits = git('rev-list', '--first-parent', `${remote}..${local}`).split('\n').filter(Boolean).map((sha) => {
      const [parents = '', tree = '', ...body] = git('log', '-1', '--format=%P%n%T%n%B', sha).split('\n')
      return { sha, parents: parents.split(' ').filter(Boolean), tree, body: body.join('\n') }
    })
    const ranges = confirmations(existsSync(confirmationsFile) ? readFileSync(confirmationsFile, 'utf8') : '', publicKey).map((c) => /^(\S+)\.\.(\S+)$/.exec(c.subject)).filter((m) => m !== null)
    const covered = new Set(ranges.flatMap((m) => git('rev-list', '--first-parent', `${m[1]}..${m[2]}`).split('\n').filter(Boolean)))
    const bad = unacceptedCommits({ commits, covered: (sha) => covered.has(sha), publicKey })
    if (bad.length > 0) {
      fail(`main has commits that merge-wp neither merged nor signed, and no confirmation covers (${bad.slice(0, 5).map((c) => c.sha.slice(0, 12)).join(', ')}). Merge branches with scripts/agents/merge-wp.sh, or read and confirm the range: scripts/agents/merge-wp.sh --confirm-guard-changes ${remote.slice(0, 12)}..${local.slice(0, 12)}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

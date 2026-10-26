#!/usr/bin/env node
// scripts/agents/merge-wp.sh <branch>: merge a work package into the current branch (main) only if
// the merged result passes typecheck, lint, guards and the tests, and the branch has the review its
// tier needs (review-gate.mjs reviewTier: security → .agent-reports/reviews/<slug>.md, architecture →
// <slug>.architecture.md or the security review) in the main checkout. A branch that changes guard
// files must be unlocked by a line the lead signed, and the person running this must confirm every
// guard file by typing the branch name. Prints every No-*-Reason trailer. Never pushes.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowlist } from '../../tools/eslint-rules/paths.mjs'
import {
  checkReview,
  CONFIRM_MESSAGE,
  confirmations,
  CONFIRMATIONS_FILE,
  confirmedFor,
  conventionalProblems,
  guardDiffHash,
  guardDiffWith,
  guardFilesBetween,
  isGuardFile,
  MERGE_MESSAGE,
  mergeTrailer,
  reasonTrailers,
  reviewFileName,
  reviewTier,
  sensitiveFiles,
  unlockedFor,
} from './review-gate.mjs'
import { signWithLeadKey } from './unlock.mjs'

export { checkReview, sensitiveFiles }

/** Editor, core or renderer code changed: the product rules' e2e specs run before the merge (red team G2-1). */
export const needsProductE2e = (changed) => changed.some((f) => /^packages\/(editor|core)\/src\/|^packages\/desktop\/src\/renderer\//.test(f))

/** Environment variables an agent session sets (Claude Code, the Agent SDK, other coding agents). */
const AGENT_ENV = /^(CLAUDE|ANTHROPIC_|AI_AGENT$|AGENT_|CODEX|CURSOR_AGENT|AIDER|GEMINI_CLI|OPENAI_AGENT)/

/**
 * Why this run is refused, or null (red team G2-12): merge-wp is the maintainer's, run by hand from a
 * shell in the main checkout. The script's own location says nothing about who runs it, so the shell's
 * cwd counts too, and any agent session's environment refuses outright.
 */
export function agentRefusal({ cwd, here, mainCheckout, env }) {
  const agent = Object.keys(env).filter((k) => AGENT_ENV.test(k))
  if (agent.length > 0) return `refused: this shell has agent environment variables (${agent.slice(0, 3).join(', ')}). merge-wp is the maintainer's and must run in a standalone terminal (Terminal.app, iTerm), not an agent session or an editor's integrated terminal: the Claude Code extension sets CLAUDE_CODE_SSE_PORT in VS Code's terminal.`
  if (resolve(cwd) !== resolve(mainCheckout) || resolve(here) !== resolve(mainCheckout)) return `run this from a shell in the main checkout (${mainCheckout}), not a worktree.`
  return null
}

/** `<from>..<to>` (two dots) as { from, to }, or null. */
export function parseRange(text) {
  const m = /^([^.\s]+(?:\.[^.\s]+)*)\.\.([^.\s]+(?:\.[^.\s]+)*)$/.exec(text ?? '')
  return m ? { from: m[1], to: m[2] } : null
}

/**
 * The human gate on guard-file changes (red team G2-13). A pty can type anything, so the person is
 * asked out of band: `sign` reads the lead key from the Keychain (`-T ""`: macOS shows its own dialog)
 * or asks its passphrase, and signs `<subject> <head> <guard diff hash>`; the signature must verify
 * against tools/guards/unlock-key.pub. Returns the line to record, or why there is none.
 */
export async function confirmGuardChanges({ subject, head, diff, sign, publicKey }) {
  const hash = guardDiffHash(diff)
  let signature
  try {
    signature = await sign(CONFIRM_MESSAGE(subject, head, hash))
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (/ENXIO|ENOTTY|no terminal|\/dev\/tty/.test(text) || (e && typeof e === 'object' && /^(ENXIO|ENOTTY|ENOENT)$/.test(String(e.code)))) return { ok: false, why: 'no terminal: run merge-wp yourself, in a terminal on this Mac, where the Keychain can ask you.' }
    return { ok: false, why: `not confirmed (${text.split('\n')[0]}). The Keychain dialog for the slate-guardrails item is the confirmation; allow it once you have read the diff.` }
  }
  const line = `${subject} ${head} ${hash} ${signature}`
  if (!confirmedFor(line, { subject, head, hash }, publicKey)) return { ok: false, why: 'the signature does not verify against tools/guards/unlock-key.pub in the main checkout.' }
  return { ok: true, line }
}

async function main() {
  const args = process.argv.slice(2)
  const batch = args[0] === '--confirm-guard-changes'
  const branch = batch ? null : args[0]
  if (!branch && !batch) {
    process.stderr.write('usage: scripts/agents/merge-wp.sh <branch>\n       scripts/agents/merge-wp.sh --confirm-guard-changes [<from>..<to>]\n')
    process.exit(64)
  }
  const here = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const sh = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { cwd: here, encoding: 'utf8', ...opts })
  const git = (...gitArgs) => sh('git', gitArgs).stdout?.trim() ?? ''
  const fail = (msg) => {
    process.stderr.write(`merge-wp: ${msg}\n`)
    process.exit(1)
  }

  // Reviews, the unlock list, the confirmations and the lead's public key are read from the main checkout.
  const commonDir = resolve(here, git('rev-parse', '--git-common-dir'))
  const mainCheckout = dirname(commonDir)
  const real = (p) => (existsSync(p) ? realpathSync(p) : p)
  const refusal = agentRefusal({ cwd: real(process.cwd()), here: real(here), mainCheckout: real(mainCheckout), env: process.env })
  if (refusal) fail(refusal)
  const pubFile = join(mainCheckout, 'tools/guards/unlock-key.pub')
  const publicKey = existsSync(pubFile) ? readFileSync(pubFile, 'utf8') : null
  const confirmationsFile = join(commonDir, CONFIRMATIONS_FILE)
  const guardDiff = guardDiffWith((...gitArgs) => sh('git', gitArgs).stdout ?? '')
  const confirm = async (subject, head, diff) => {
    const r = await confirmGuardChanges({ subject, head, diff, sign: (message) => signWithLeadKey(message), publicKey })
    if (!r.ok) fail(`guard-file changes not confirmed; nothing was recorded or merged. ${r.why}`)
    appendFileSync(confirmationsFile, `${r.line}\n`)
  }

  if (batch) {
    // Everything since the last confirmation (or since origin/main), up to main.
    const last = confirmations(existsSync(confirmationsFile) ? readFileSync(confirmationsFile, 'utf8') : '', publicKey).filter((c) => c.subject.includes('..')).at(-1)
    const range = parseRange(args[1] ?? '') ?? { from: last?.head ?? 'origin/main', to: 'main' }
    const from = git('rev-parse', '--verify', `${range.from}^{commit}`)
    const to = git('rev-parse', '--verify', `${range.to}^{commit}`)
    if (!from || !to) fail(`cannot resolve ${range.from}..${range.to}.`)
    const diff = guardDiff(from, to)
    // Every commit on main's first-parent line in the range, so a merge the lead made by hand (or a
    // release commit) is seen and covered too (final F-3); then every guard-file change in full.
    sh('git', ['--no-pager', 'log', '--first-parent', '--format=%h %s%n%(trailers:key=Merge-WP-Signature,valueonly,separator=%x20)', `${from}..${to}`], { stdio: 'inherit' })
    if (diff !== '') {
      sh('git', ['--no-pager', 'log', '--format=%h %s%n%(trailers:key=Guardrail-Change,separator=%x0a)', `${from}..${to}`, '--', ...guardFilesBetween(git, from, to)], { stdio: 'inherit' })
      process.stdout.write(diff.endsWith('\n') ? diff : `${diff}\n`)
    }
    process.stdout.write(`\nmerge-wp: those are the commits${diff === '' ? ' (no guard-file changes)' : ' and every guard-file change'} in ${from.slice(0, 12)}..${to.slice(0, 12)}. Allow the Keychain dialog to confirm them.\n`)
    await confirm(`${from}..${to}`, to, diff)
    process.stdout.write(`merge-wp: confirmed ${from.slice(0, 12)}..${to.slice(0, 12)}; main can be pushed.\n`)
    return
  }

  if (git('status', '--porcelain') !== '') fail('the working tree is not clean; commit or remove changes first.')
  const head = git('rev-parse', '--verify', `${branch}^{commit}`)
  if (!head) fail(`no branch ${branch}.`)

  const changed = git('diff', '--name-only', `HEAD...${branch}`).split('\n').filter(Boolean)
  const diff = git('diff', `HEAD...${branch}`)
  const log = git('log', '--format=%B%n---', `HEAD..${branch}`)
  const messages = log.split('\n---\n').map((m) => m.trim()).filter(Boolean)

  const commitProblems = conventionalProblems(messages)
  if (commitProblems.length > 0) fail(`commit messages the commit-msg hook should have refused: ${commitProblems.join('; ')}.`)

  const guardFiles = changed.filter(isGuardFile)
  if (guardFiles.length > 0) {
    const unlockFile = join(commonDir, 'slate-guardrails-unlock')
    const worktree = /worktree (.+)\nHEAD [0-9a-f]+\nbranch refs\/heads\/(.+)/g
    const paths = [...git('worktree', 'list', '--porcelain').matchAll(worktree)].filter((m) => m[2] === branch).map((m) => m[1])
    const firstCommit = git('rev-list', '--reverse', `HEAD..${branch}`).split('\n')[0] ?? ''
    const text = existsSync(unlockFile) ? readFileSync(unlockFile, 'utf8') : ''
    if (![...paths, ''].some((wt) => unlockedFor(text, { branch, worktree: wt, firstCommit }, publicKey))) {
      fail(`${branch} changes guard files (${guardFiles.slice(0, 6).join(', ')}) but has no unlock line signed by the lead (node scripts/agents/unlock.mjs ${branch} <worktree path>; public key ${pubFile}).`)
    }
    const guardText = guardDiff(git('merge-base', 'HEAD', head), head)
    process.stdout.write(guardText.endsWith('\n') ? guardText : `${guardText}\n`)
    process.stdout.write(`\nmerge-wp: those are ${branch}'s guard-file changes. Allow the Keychain dialog to confirm them.\n`)
    await confirm(branch, head, guardText)
  }

  const allowlisted = readdirSync(join(here, 'tools/guards/allowlists')).filter((f) => f.endsWith('.json')).flatMap((f) => Object.keys(allowlist(f.slice(0, -5))))
  const read = (f) => (existsSync(join(here, f)) ? readFileSync(join(here, f), 'utf8') : '')
  const tier = reviewTier({ changed, diff, security: read('tools/guards/security-paths.txt'), architecture: read('tools/guards/architecture-paths.txt'), allowlisted })
  if (tier.tier !== 'none') {
    const dir = join(mainCheckout, '.agent-reports', 'reviews')
    const securityFile = join(dir, reviewFileName(branch))
    const architectureFile = join(dir, reviewFileName(branch).replace(/\.md$/, '.architecture.md'))
    const review = (f) => checkReview(existsSync(f) ? readFileSync(f, 'utf8') : null, head)
    const problem = tier.tier === 'security' ? review(securityFile) : review(architectureFile) === null || review(securityFile) === null ? null : review(architectureFile)
    if (problem) {
      const why = [...tier.sensitive.slice(0, 6), ...tier.risky.map((r) => `${r.why}: ${r.line}`), ...tier.structural.slice(0, 6)].join('; ')
      const agent = tier.tier === 'security' ? 'security-reviewer' : 'architecture-reviewer'
      fail(`${branch} needs the ${tier.tier} review (${why}): ${problem}. Run the ${agent} agent (.claude/agents/${agent}.md) on ${head.slice(0, 12)} first.`)
    }
  }

  const trailers = reasonTrailers(log)
  if (trailers.length > 0) process.stdout.write(`merge-wp: judge these before merging (each claims a change needs no red test or no test):\n  ${trailers.join('\n  ')}\n`)

  const merge = sh('git', ['merge', '--no-ff', '--no-commit', branch], { stdio: 'inherit' })
  if (merge.status !== 0) {
    sh('git', ['merge', '--abort'])
    fail('the merge did not apply cleanly; resolve it on the branch (git merge main there) and try again.')
  }
  const checks = [['typecheck'], ['lint'], ['guards'], ['test'], ['test:main'], ...(needsProductE2e(changed) ? [['e2e', '--', 'spec/']] : [])]
  for (const [script, ...rest] of checks) {
    process.stdout.write(`merge-wp: npm run ${script} ${rest.join(' ')}\n`)
    const r = sh('npm', ['run', script, '--silent', ...rest], { stdio: 'inherit' })
    if (r.status !== 0) {
      sh('git', ['merge', '--abort'])
      fail(`npm run ${script} fails on the merge result; the merge was aborted. Fix it on ${branch}.`)
    }
  }
  // Signed over the parents and tree, so pre-push can tell this merge from a plain `git merge` (final F-3).
  const tree = git('write-tree')
  const base = git('rev-parse', 'HEAD')
  let mergeSignature
  try {
    mergeSignature = await signWithLeadKey(MERGE_MESSAGE(base, head, tree))
  } catch (e) {
    sh('git', ['merge', '--abort'])
    fail(`the merge was not signed (${e instanceof Error ? e.message.split('\n')[0] : e}); the merge was aborted. Allow the Keychain dialog to sign it.`)
  }
  const commit = sh('git', ['commit', '--no-edit', '--trailer', mergeTrailer(mergeSignature)], { stdio: 'inherit' })
  if (commit.status !== 0) {
    sh('git', ['merge', '--abort'])
    fail('the merge commit was refused (see the hook output above); the merge was aborted.')
  }
  process.stdout.write(`merge-wp: merged ${branch} (${head.slice(0, 12)}). Not pushed.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

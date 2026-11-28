#!/usr/bin/env node
// Refuses to push a release tag until CI has passed on the commit it tags. Run by .githooks/pre-push.
//
// The release workflow repeats CI's checks before it builds anything, so a tag pushed while CI on its
// commit is still running, cancelled or failed stops there and publishes nothing, and the version has to
// be bumped again. Waiting for CI by hand before each tag was the step most often done by eye.
import { execFileSync } from 'node:child_process'

/**
 * What to do about a tag on a commit whose CI runs are `runs` (newest first, as `gh run list` gives them):
 * null to go ahead, or why not, naming what to do.
 */
export function ciVerdict(runs, sha) {
  const short = sha.slice(0, 8)
  const run = runs[0]
  if (run === undefined) return `CI has not run on ${short}. Push main first, wait for CI to pass, then push the tag again.`
  if (run.status !== 'completed') return `CI on ${short} is still ${run.status}. Wait for it (gh run watch ${String(run.databaseId)}), then push the tag again.`
  if (run.conclusion === 'cancelled') {
    return `CI on ${short} was cancelled (gh run view ${String(run.databaseId)}). If no runner picked a job up, re-run it (gh run rerun ${String(run.databaseId)} --failed), wait for it to pass, then push the tag again.`
  }
  if (run.conclusion !== 'success') return `CI on ${short} ended "${String(run.conclusion)}" (gh run view ${String(run.databaseId)} --log-failed). Fix it on main and tag the fixed commit with a new version.`
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = process.argv[2]
  if (!sha) {
    console.error('usage: release-ci-gate.mjs <commit-sha>')
    process.exit(2)
  }
  let runs
  try {
    runs = JSON.parse(execFileSync('gh', ['run', 'list', '--workflow', 'ci.yml', '--commit', sha, '--limit', '5', '--json', 'databaseId,status,conclusion'], { encoding: 'utf8', timeout: 20_000 }))
  } catch (error) {
    console.error(`pre-push: could not ask GitHub about CI on ${sha.slice(0, 8)} (${String(error.message).split('\n')[0]}). Install and sign in to gh, then push the tag again.`)
    process.exit(1)
  }
  const why = ciVerdict(runs, sha)
  if (why !== null) {
    console.error(`pre-push: the release tag is not pushed. ${why}`)
    process.exit(1)
  }
  console.log(`pre-push: CI passed on ${sha.slice(0, 8)}.`)
}

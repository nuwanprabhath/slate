#!/usr/bin/env node
// When Slate's quality skills are owed a run, and the gate that makes them run before a release.
//
// A skill is owed a run on one of two kinds of milestone (docs/quality-cadence.json):
// - `every`: so many changed lines of code, or so many days once the code has moved. Lines, not commits,
//   because a release lands on main as one squash commit (0.8.0 was 9,400 lines in one).
// - `when`: something it exists for changed since its last run: a security path for the security review,
//   sync, the vault or the database for blast-radius, the renderer for ui-review's screenshot pass, a failed
//   scheduled nightly for nightly triage.
// A release tag is refused while any is owed (.githooks/pre-push), each session start says which are, and a
// skill's last step records its run with `done <skill>`. This file is a guard file; the ledger is not, so a
// run can be recorded, and the maintainer sees the ledger change when confirming the push.
//
//   node tools/guards/quality-cadence.mjs [status] [<sha>]   what is owed at <sha> (default HEAD); exit 0
//   node tools/guards/quality-cadence.mjs check <sha>        exit 1 when anything is owed (the release gate)
//   node tools/guards/quality-cadence.mjs hook               the SessionStart hook's JSON (nothing when nothing is owed)
//   node tools/guards/quality-cadence.mjs done <skill>       record a run at HEAD, now
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from '../eslint-rules/paths.mjs'

export const LEDGER = 'docs/quality-cadence.json'
const DAY_MS = 24 * 60 * 60 * 1000
/** Days alone do not make a skill owed on code that barely moved. */
export const MIN_LINES_FOR_DAYS = 200
/** The code a line count measures: not docs, lockfiles or the fuzz corpus. */
const CODE = ['packages', 'tools', 'scripts', ':(exclude)packages/*/test/corpus', ':(exclude)package-lock.json']

/** Why an `every` skill is owed (null when it is not), from the lines and days since its last run. */
export function changeReason(name, every, linesSince, daysSince) {
  if (linesSince >= every.lines) return `${name}: ${String(linesSince)} changed lines since its last run (owed every ${String(every.lines)})`
  if (daysSince >= every.days && linesSince >= MIN_LINES_FOR_DAYS) {
    return `${name}: ${String(Math.floor(daysSince))} days and ${String(linesSince)} changed lines since its last run (owed every ${String(every.days)} days)`
  }
  return null
}

/** A plain test file is not the code a path names (security-paths.txt: "test files count only under spec/"). */
const isPlainTest = (f) => /\.(test|spec)\.tsx?$/.test(f) && !/\/(test|e2e)\/spec\//.test(f)

/** The changed files under any of `globs`, plain tests left out. */
export function matchPaths(changed, globs) {
  const res = globs.map(globToRegExp)
  return changed.filter((f) => !isPlainTest(f) && res.some((re) => re.test(f)))
}

/** Why a `when.paths` skill is owed (null when nothing it covers changed). */
export function pathReason(name, matched) {
  if (matched.length === 0) return null
  const shown = matched.slice(0, 3).join(', ')
  return `${name}: ${String(matched.length)} file(s) it covers changed since its last run (${shown}${matched.length > 3 ? ', …' : ''})`
}

/** Why nightly triage is owed: scheduled nightly runs that failed after `sinceIso` (as `gh run list` gives them). */
export function nightlyReason(name, runs, sinceIso) {
  const since = Date.parse(sinceIso)
  const failed = runs.filter((r) => r.conclusion === 'failure' && Date.parse(r.createdAt) > since)
  if (failed.length === 0) return null
  const list = failed.map((r) => `#${String(r.number)} (${r.createdAt.slice(0, 10)})`).join(', ')
  return `${name}: scheduled nightly ${failed.length === 1 ? 'run' : 'runs'} ${list} failed since the last triage; read each (gh run view <id> --log-failed), replay its seed, and fix what it found`
}

/** The message an owed skill gets: what is owed and how to clear it. */
export function dueMessage(reasons) {
  return [
    `Quality skills owed a run: ${reasons.join('; ')}.`,
    'Run each (.claude/skills/<name>/SKILL.md; the security review is docs/review/REVIEW.md; nightly triage replays each failed seed); its last step records the run with `node tools/guards/quality-cadence.mjs done <name>`, committed with its work.',
  ].join(' ')
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

function isAncestor(commit, sha) {
  try {
    git('merge-base', '--is-ancestor', commit, sha)
    return true
  } catch {
    return false
  }
}

function linesBetween(from, to) {
  const stat = git('diff', '--shortstat', from, to, '--', ...CODE)
  const ins = /(\d+) insertion/.exec(stat)
  const del = /(\d+) deletion/.exec(stat)
  return Number(ins?.[1] ?? 0) + Number(del?.[1] ?? 0)
}

const changedBetween = (from, to) => git('diff', '--name-only', '--no-renames', from, to).split('\n').filter(Boolean)

function globsOf(when, sha) {
  if (when.paths) return when.paths
  const text = git('show', `${sha}:${when.pathsFile}`)
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
}

/** The scheduled nightly runs on main, newest first; throws when GitHub cannot be asked. */
function nightlyRuns() {
  const out = execFileSync('gh', ['run', 'list', '--workflow', 'nightly.yml', '--event', 'schedule', '--branch', 'main', '--limit', '30', '--json', 'number,createdAt,status,conclusion'], { encoding: 'utf8', timeout: 10_000 })
  return JSON.parse(out).filter((r) => r.status === 'completed')
}

/**
 * Why each skill in `ledger` is owed at `sha`. `offline` skips nightly triage instead of failing when
 * GitHub cannot be asked (the session hook); the release gate asks and fails closed.
 */
export function owedAt(ledger, sha, { now = Date.now(), offline = false } = {}) {
  const reasons = []
  for (const [name, skill] of Object.entries(ledger.skills)) {
    const last = skill.last
    if (skill.when?.nightly) {
      let runs
      try {
        runs = nightlyRuns()
      } catch (error) {
        if (offline) continue
        reasons.push(`${name}: could not ask GitHub for the nightly runs (${String(error.message).split('\n')[0]}); sign in to gh and try again`)
        continue
      }
      const why = nightlyReason(name, runs, last.at)
      if (why) reasons.push(why)
      continue
    }
    if (!isAncestor(last.commit, sha)) {
      reasons.push(`${name}: its last run (${last.commit.slice(0, 8)}) is not in this history`)
      continue
    }
    if (skill.every) {
      const why = changeReason(name, skill.every, linesBetween(last.commit, sha), (now - Date.parse(last.at)) / DAY_MS)
      if (why) reasons.push(why)
    }
    if (skill.when) {
      const why = pathReason(name, matchPaths(changedBetween(last.commit, sha), globsOf(skill.when, sha)))
      if (why) reasons.push(why)
    }
  }
  return reasons
}

const readLedgerAt = (sha) => JSON.parse(git('show', `${sha}:${LEDGER}`))

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command = 'status', arg] = process.argv.slice(2)
  if (command === 'done') {
    const path = join(git('rev-parse', '--show-toplevel'), LEDGER)
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    if (!arg || !(arg in ledger.skills)) {
      console.error(`usage: quality-cadence.mjs done <${Object.keys(ledger.skills).join('|')}>`)
      process.exit(2)
    }
    ledger.skills[arg].last = { commit: git('rev-parse', 'HEAD'), at: new Date().toISOString() }
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
    console.log(`quality-cadence: recorded ${arg} at ${ledger.skills[arg].last.commit.slice(0, 8)}; commit ${LEDGER} with the run.`)
    process.exit(0)
  }
  const sha = git('rev-parse', `${command === 'hook' || !arg ? 'HEAD' : arg}^{commit}`)
  let reasons
  try {
    reasons = owedAt(readLedgerAt(sha), sha, { offline: command !== 'check' })
  } catch (error) {
    if (command === 'hook') process.exit(0)
    console.error(`quality-cadence: could not read ${LEDGER} at ${sha.slice(0, 8)} (${String(error.message).split('\n')[0]}).`)
    process.exit(command === 'check' ? 1 : 0)
  }
  if (command === 'hook') {
    if (reasons.length > 0) {
      const context = `${dueMessage(reasons)} A release tag is refused until they have run (.githooks/pre-push), so tell the maintainer and offer to run them.`
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }))
    }
    process.exit(0)
  }
  if (reasons.length === 0) {
    console.log(`quality-cadence: nothing owed at ${sha.slice(0, 8)}.`)
    process.exit(0)
  }
  console.error(dueMessage(reasons))
  process.exit(command === 'check' ? 1 : 0)
}

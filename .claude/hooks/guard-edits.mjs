#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash): the guard layer cannot be edited away.
//
// The checks that keep Slate's security and architecture rules (lint config and rules, guard
// tests, hooks, tsconfigs, test configs, CI) are only worth something if the agent they stop
// cannot change them. Writes to those files are denied unless the unlock file
// `$(git rev-parse --git-common-dir)/slate-guardrails-unlock` has a line `<branch> <token>` for this
// branch, the token being this worktree's absolute path or the branch's first commit since main, so
// renaming another branch onto an unlocked name unlocks nothing. Only the lead writes that file.
// A shell cannot be fully parsed: anything this misses is caught in CI, where every commit that
// changes a guard file must carry a Guardrail-Change: trailer (scripts/agents/check-guard-commits.mjs),
// and by merge-wp, which refuses guard changes from a branch that is not unlocked.
// Exit 2 = the reason goes back to the agent and the tool call does not run.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isGuardFile, unlockedFor } from '../../scripts/agents/review-gate.mjs'

export const UNLOCK_FILE = 'slate-guardrails-unlock'

/**
 * A folder that holds guard files, the repo root among them: moving, formatting or restoring it
 * wholesale writes guard files (`.githooks` is a folder, whatever its name looks like).
 */
const GUARD_DIR = /^(|\.|tools(\/(guards|eslint-rules|lint))?|\.claude|\.githooks|\.github(\/workflows)?|scripts(\/agents)?|packages(\/[^/]+(\/(test|e2e)(\/spec)?)?)?)\/?$/

/** A guard file, or a folder that holds guard files. */
export const isGuarded = (rel) => isGuardFile(rel) || GUARD_DIR.test(rel)

const HOW =
  'If the accepted path the check names cannot work, stop that item and explain it in your report under "Guardrail conflicts"; the lead decides. ' +
  'Never route around a guard (CLAUDE.md, Guardrails).'

const unquote = (t) => t.replace(/^['"]|['"]$/g, '')
const posix = (p) => p.split('\\').join('/')

/** The paths a shell segment writes, renames or deletes (best effort, conservative). */
export function writtenPaths(segment) {
  const out = []
  for (const m of segment.matchAll(/(?:^|[^<>&0-9])>{1,2}\|?\s*([^\s;&|<>]+)/g)) out.push(unquote(m[1]))
  const tokens = segment.trim().split(/\s+/).map(unquote)
  const args = (from) => tokens.slice(from).filter((t) => t !== '' && !t.startsWith('-'))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'tee') out.push(...args(i + 1))
    if ((t === 'sed' || t === 'perl' || t === 'ruby') && tokens.slice(i + 1).some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) out.push(...args(i + 1))
    if (['rm', 'mv', 'cp', 'truncate', 'install', 'ln', 'chmod', 'unlink', 'rsync', 'dd'].includes(t)) out.push(...args(i + 1))
  }
  return out
}

/** Commands that only read (or run a guard tool); any other command naming a guard file is denied. */
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'wc', 'ls', 'stat', 'file', 'diff', 'cmp', 'sort', 'uniq', 'echo', 'true', 'test', '['])
const GIT_READERS = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'ls-tree', 'grep', 'rev-parse', 'cat-file', 'merge-base', 'rev-list', 'shortlog', 'add', 'commit'])

const commandWords = (tokens) => tokens.filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t))

/** A command that only reads whatever it names: a reader, sed without -i, a reading git verb. */
function readsPurely(tokens) {
  const words = commandWords(tokens)
  const cmd = words[0] ?? ''
  if (cmd === '') return true
  if (READERS.has(cmd)) return true
  if (cmd === 'sed') return !words.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')
  if (cmd === 'git') {
    const sub = words.slice(1).find((t, i, all) => !t.startsWith('-') && all[i - 1] !== '-C' && all[i - 1] !== '-c')
    return GIT_READERS.has(sub ?? '')
  }
  return false
}

/** A formatter or fixer flag: the tool writes the files it names (red team G2-16: `-w`, `--fix` via the bin path). */
const FIXES = (w) => /^(--write|--fix|--fix-type=.*|-w)$/.test(w)

function readsOnly(tokens, root, cwd) {
  if (readsPurely(tokens)) return true
  const words = commandWords(tokens)
  const cmd = words[0] ?? ''
  if (cmd === 'npx' || cmd === 'npm') return !words.some(FIXES)
  if (cmd === 'node') return words[1] !== undefined && !words[1].startsWith('-')
  // Running a guard tool (tools/lint/node_modules/.bin/eslint …) only reads, unless told to fix.
  const rel = repoRelative(root, cwd, cmd)
  return rel !== null && /^tools\/lint\/node_modules\/\.bin\//.test(rel) && !words.some(FIXES)
}

/**
 * merge-wp and unlock.mjs are the maintainer's: merge-wp merges into main and unlock.mjs signs with the
 * lead key (red team G2-10..G2-12). Matched with quotes, escapes and punctuation squeezed out, so
 * `'merge'-"wp"`, `merge_wp`, `unl\ock.mjs` and `'merge' + '-wp.mjs'` all count.
 */
const LEAD_TOOL = /mergewp|unlockm?js/
/** The agent scripts an agent may run itself; anything else under scripts/agents is the lead's. */
const AGENT_SAFE = /^(check-guard-commits|check-push|review-gate)\.mjs$/
const RUNNERS = /^(node|bash|sh|zsh|dash|ksh|deno|bun|tsx|ts-node|npx|exec|source|\.|env|xargs|python3?|perl|ruby|osascript|script)$/
const LEAD_TOOLS_DENIED = 'Denied: merge-wp and unlock.mjs are the lead\'s tools, run by the maintainer by hand (merging into main, signing unlocks); an agent never runs them. Finish your branch and report; the lead merges it.'

/** git verbs that change a checkout's branch, index, working tree or refs. */
const GIT_WRITES = new Set(['merge', 'commit', 'reset', 'cherry-pick', 'rebase', 'pull', 'update-ref', 'revert', 'am', 'checkout', 'switch', 'restore', 'stash', 'tag', 'push', 'symbolic-ref', 'notes', 'replace'])

/** Inside the main checkout's own tree (not a worktree under .claude/worktrees). */
const inMainTree = (path, mainCheckout) => {
  const p = posix(resolve(path))
  const m = posix(resolve(mainCheckout))
  return (p === m || p.startsWith(`${m}/`)) && !p.startsWith(`${m}/.claude/worktrees/`)
}

/**
 * Whether a git command acts on the main checkout: through the directory it runs in (after `cd`),
 * `-C`, `--git-dir`/`--work-tree` (either spelling), or GIT_DIR/GIT_WORK_TREE set before it.
 */
function targetsMain({ before, sub, here, mainCheckout, gitCommonDir }) {
  let dir = here
  let gitDir = null
  let workTree = null
  for (const t of before) {
    const m = /^GIT_(DIR|WORK_TREE)=(.+)$/.exec(t)
    if (m) (m[1] === 'DIR' ? (gitDir = resolve(dir, m[2])) : (workTree = resolve(dir, m[2])))
  }
  for (let i = 0; i < sub.length; i++) {
    const t = sub[i]
    if (!t.startsWith('-')) break
    const value = (name) => (t === name ? sub[++i] : t.startsWith(`${name}=`) ? t.slice(name.length + 1) : undefined)
    if (t === '-C') dir = resolve(dir, sub[++i] ?? '.')
    else if (t === '-c') i++
    else {
      const g = value('--git-dir')
      if (g !== undefined) gitDir = resolve(dir, g)
      const w = value('--work-tree')
      if (w !== undefined) workTree = resolve(dir, w)
    }
  }
  if (workTree !== null && inMainTree(workTree, mainCheckout)) return true
  if (gitDir !== null) return posix(gitDir) === posix(resolve(gitCommonDir))
  return inMainTree(dir, mainCheckout)
}

/** A push whose destination is main: a `<src>:main` or bare `main` refspec, or --all/--mirror. */
function pushesMain(sub) {
  const at = sub.indexOf('push')
  const args = sub.slice(at + 1)
  if (args.some((a) => a === '--all' || a === '--mirror' || a === '--branches')) return true
  const positional = args.filter((a) => !a.startsWith('-'))
  return positional.slice(1).some((spec) => /^(refs\/heads\/)?main$/.test(spec.replace(/^\+/, '').split(':').pop() ?? ''))
}

function repoRelative(root, cwd, path) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const rel = posix(relative(root, abs))
  return rel.startsWith('..') ? null : rel
}

/** A guard file of this checkout, of the main checkout, or of any other worktree under it. */
function guardTarget({ root, cwd, mainCheckout }, path) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path)
  const own = repoRelative(root, cwd, abs)
  if (own !== null) return isGuarded(own) ? { rel: own, own: true } : null
  const rel = repoRelative(mainCheckout, cwd, abs)
  if (rel === null) return null
  const inner = rel.replace(/^\.claude\/worktrees\/[^/]+\//, '')
  return isGuarded(inner) || isGuarded(rel) ? { rel, own: false } : null
}

/**
 * The decision, kept pure so it is unit-tested (tools/guards/guardEdits.test.ts).
 * @returns {string | null} why the call is denied, or null to let it run
 */
export function decide({ tool, input, root, cwd, branch, unlockText, firstCommit, gitCommonDir, mainCheckout, home, publicKey = null }) {
  const open = unlockedFor(unlockText, { branch, worktree: root, firstCommit }, publicKey)
  const unlockPath = resolve(gitCommonDir, UNLOCK_FILE)
  const inMain = resolve(root) === resolve(mainCheckout)
  const ctx = { root, cwd, mainCheckout }
  const isReview = (p) => /(^|\/)\.agent-reports\/reviews(\/|$)/.test(posix(isAbsolute(p) ? p : resolve(cwd, p)))
  const expand = (p) => (p.startsWith('~/') ? join(home, p.slice(2)) : p.replace(/^\$HOME\//, `${home}/`))
  const isUserSettings = (p) => posix(resolve(cwd, expand(p))).startsWith(posix(join(home, '.claude', 'settings')))
  // The user's own Claude files (settings, CLAUDE.md, hooks) steer every session: the maintainer's.
  const isUserClaude = (p) => posix(resolve(cwd, expand(p))).startsWith(`${posix(join(home, '.claude'))}/`)
  // The lead's guardrail key (scripts/agents/unlock.mjs): never read or written by an agent.
  const isLeadKey = (p) => posix(resolve(cwd, expand(p))).startsWith(`${posix(join(home, '.config', 'slate-release'))}`)

  if (tool === 'Read') {
    const path = String(input.file_path ?? '')
    return path !== '' && isLeadKey(path) ? `Denied: the lead's guardrail key is not for agents to read. ${HOW}` : null
  }

  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    if (/slate-release|guardrails\.key|\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain|export|delete-generic-password|add-generic-password|set-generic-password-partition-list)\b/.test(command)) {
      return `Denied: the lead's guardrail key (Keychain item slate-guardrails, ~/.config/slate-release) is not for agents. ${HOW}`
    }
    // The command as the shell reads it: quotes and backslash escapes gone (`core.hook\sPath`, `'merge'-"wp"`).
    const flat = command.replace(/\\(.)/g, '$1').replace(/['"]/g, '')
    const squeezed = flat.toLowerCase().replace(/[^a-z0-9]/g, '')
    const segments = command.split(/&&|\|\||;|\n|\||\$\(|`/)
    if (LEAD_TOOL.test(squeezed) && !segments.every((s) => readsPurely(s.trim().split(/\s+/).map(unquote).filter(Boolean)))) return `${LEAD_TOOLS_DENIED} ${HOW}`
    if (/\binclude(If)?\.|\binclude\.path\b/i.test(flat) && /\bgit\b/.test(flat)) return `Denied: a git include.path loads configuration from anywhere, hooks included. ${HOW}`
    if (/slate-guardrails|guardrails-unlock/.test(command)) return `Denied: the guardrail unlock file is written by the lead only, by hand. ${HOW}`
    if (/--no-verify\b/.test(flat)) return `Denied: --no-verify skips the git hooks that run the guard checks. Fix what they report. ${HOW}`
    if (/\bgit\b/.test(flat) && /\balias\./i.test(flat)) return `Denied: a git alias can hide --no-verify or -n behind another name. Run the git command itself. ${HOW}`
    if (/core\.hookspath/i.test(flat) || /\bGIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)/.test(flat)) return `Denied: core.hooksPath or a GIT_CONFIG_* variable can switch off the git hooks. ${HOW}`
    // Every worktree shares one git config: core.bare=true there (left behind by a bisect in phase 13)
    // turns the main checkout into "no work tree", and the lead's merges then fail.
    if (/\bgit\b/.test(flat) && /\bcore\.(bare|worktree)\b|\bextensions\.worktreeconfig\b/i.test(flat)) return `Denied: core.bare, core.worktree and extensions.worktreeConfig change where git finds the work tree for every worktree, the main checkout included. ${HOW}`
    const plumbing = /\bgit\s+(update-ref|commit-tree|update-index|read-tree|am|apply)\b/.exec(command)
    if (plumbing) return `Denied: git ${plumbing[1]} writes commits or files behind the hooks' back. Edit files and commit them normally. ${HOW}`
    if (/\bgit\s+stash\s+(pop|apply)\b/.test(command)) return `Denied: git stash pop/apply can restore anyone's changes, guard files included (the stash is shared by every worktree). Commit on your branch instead. ${HOW}`
    if (isUserSettings(command.match(/[~\w./-]*\.claude\/settings[\w.-]*/)?.[0]?.replace(/^~/, home) ?? '/nonexistent')) return `Denied: user-level Claude settings are the maintainer's. ${HOW}`
    let here = cwd
    for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
      const tokens = segment.trim().split(/\s+/).map(unquote).filter(Boolean)
      if (tokens[0] === 'cd' && tokens[1]) {
        here = resolve(here, tokens[1])
        continue
      }
      // A computed path into scripts/agents (`node scripts/agents/$F`, `cd scripts/agents && node $(ls | …)`).
      const run = commandWords(tokens)[0] ?? ''
      const agentsHere = [root, mainCheckout].some((r) => `${posix(here)}/`.startsWith(`${posix(join(r, 'scripts', 'agents'))}/`))
      const agentScripts = tokens.flatMap((t) => [...t.matchAll(/(?:^|\/)agents\/([^\s'"`)]*)/g)].map((m) => m[1]))
      const runs = RUNNERS.test(run) || /(^|\/)scripts\/agents\//.test(run) || (agentsHere && run.startsWith('./'))
      if (runs && (agentScripts.some((n) => !AGENT_SAFE.test(n)) || (agentsHere && !tokens.some((t) => AGENT_SAFE.test(t.split('/').pop() ?? ''))))) return `${LEAD_TOOLS_DENIED} ${HOW}`
      const gitAt = tokens.indexOf('git')
      if (gitAt >= 0) {
        const sub = tokens.slice(gitAt + 1)
        const verb = sub.find((t, i) => !t.startsWith('-') && !/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(sub[i - 1] ?? ''))
        if (verb === 'commit' && sub.some((t) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))) return `Denied: \`git commit -n\` is --no-verify. ${HOW}`
        if (verb === 'reset' && sub.includes('--hard') && sub.some((t) => /^(origin\/)?main$/.test(t))) return `Denied: resetting onto main rewrites history the guard checks compare against. Merge main instead (git merge main). ${HOW}`
        if (verb === 'branch' && sub.some((t) => /^-(f|D|M|C|m)$|^--(force|move|copy)$/.test(t))) return `Denied: renaming, copying or forcing a branch can take an unlocked name or rewrite main. ${HOW}`
        if (verb === 'push' && sub.some((t) => /^(-f|--force|--force-with-lease.*)$/.test(t))) return `Denied: force-pushing rewrites history. ${HOW}`
        if (verb === 'push' && pushesMain(sub)) return `Denied: only the maintainer pushes main, after merge-wp merged and signed every commit on it (red team final F-3). ${HOW}`
        // A work-package agent never changes the main checkout; the lead, whose session is the main
        // checkout, merges reviewed branches there, and pre-push holds main until the maintainer signs.
        if (!inMain && GIT_WRITES.has(verb ?? '') && targetsMain({ before: tokens.slice(0, gitAt), sub, here, mainCheckout, gitCommonDir })) {
          return `Denied: git ${verb} would change the main checkout. Work lands on main only through scripts/agents/merge-wp.sh, run by the maintainer (red team final F-3). Commit on your branch in your worktree and report. ${HOW}`
        }
      }
      const local = { ...ctx, cwd: here }
      // The guard tool being run is not a target of itself.
      const runsGuardTool = /^tools\/lint\/node_modules\/\.bin\//.test(repoRelative(root, here, run) ?? '')
      const named = tokens.filter((t) => !(runsGuardTool && t === run)).flatMap((t) => [t, ...t.split('=').slice(1), ...[...t.matchAll(/['"(,]([\w./-]+)['")]/g)].map((m) => m[1])])
      if (!inMain && (writtenPaths(segment).some(isReview) || (named.some(isReview) && !readsOnly(tokens, root, here)))) {
        return `Denied: review files are the reviewers' and the lead's, written in the main checkout. ${HOW}`
      }
      if (writtenPaths(segment).some(isUserClaude) || (named.some((p) => p.includes('.claude/') && isUserClaude(p)) && !readsOnly(tokens, root, here))) {
        return `Denied: ~/.claude (settings, CLAUDE.md, hooks) steers every Claude session and is the maintainer's. ${HOW}`
      }
      const hit = named.map((p) => guardTarget(local, p)).find((g) => g !== null)
      const written = writtenPaths(segment).map((p) => guardTarget(local, p)).find((g) => g !== null)
      const target = written ?? (hit && !readsOnly(tokens, root, here) ? hit : null)
      if (target && (!open || !target.own)) {
        const what = target.rel === '' || target.rel === '.' ? 'the whole tree (it holds guard files)' : `${target.rel} is a guard file or holds guard files (lint rules, guard tests, hooks, tsconfig, test config, CI), and it`
        return `Denied: ${what} may be written by this command; this branch is not unlocked for guardrail work. Read it with cat/grep/git show, or ${HOW}`
      }
    }
    return null
  }

  const path = String(input.file_path ?? input.notebook_path ?? '')
  if (path === '') return null
  if (resolve(cwd, path) === unlockPath || path.includes(UNLOCK_FILE)) return `Denied: ${UNLOCK_FILE} is written by the lead only, by hand. ${HOW}`
  if (isUserSettings(path)) return `Denied: user-level Claude settings (${path}) are the maintainer's. ${HOW}`
  if (isUserClaude(path)) return `Denied: ~/.claude (CLAUDE.md, hooks, settings) steers every Claude session and is the maintainer's. ${HOW}`
  if (isLeadKey(path)) return `Denied: the lead's guardrail key is not for agents to write. ${HOW}`
  if (isReview(path) && !inMain) return `Denied: review files are written by the reviewer agents and the lead in the main checkout, never from a work-package worktree. ${HOW}`
  const target = guardTarget(ctx, path)
  if (target && (!open || !target.own)) {
    return `Denied: ${target.rel} is a guard file (lint rules, guard tests, hooks, tsconfig, test config, CI), and this branch is not unlocked for guardrail work. Use the path the failing check names instead. ${HOW}`
  }
  return null
}

function main() {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout?.trim() ?? ''
  const root = git(['rev-parse', '--show-toplevel'])
  if (root === '' || !existsSync(join(root, 'tools/guards'))) process.exit(0)
  const gitCommonDir = resolve(cwd, git(['rev-parse', '--git-common-dir']))
  const unlockFile = join(gitCommonDir, UNLOCK_FILE)
  const pubKeyFile = join(dirname(gitCommonDir), 'tools/guards/unlock-key.pub')
  const reason = decide({
    tool: String(input.tool_name ?? ''),
    input: input.tool_input ?? {},
    root,
    cwd,
    branch: git(['symbolic-ref', '--short', '-q', 'HEAD']),
    unlockText: existsSync(unlockFile) ? readFileSync(unlockFile, 'utf8') : '',
    firstCommit: git(['rev-list', '--reverse', 'main..HEAD']).split('\n')[0] ?? '',
    gitCommonDir,
    mainCheckout: dirname(gitCommonDir),
    home: homedir(),
    // The lead's public key, from the main checkout: an unlock line counts only if the lead signed it.
    publicKey: existsSync(pubKeyFile) ? readFileSync(pubKeyFile, 'utf8') : null,
  })
  if (reason === null) process.exit(0)
  process.stderr.write(`${reason}\n`)
  process.exit(2)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

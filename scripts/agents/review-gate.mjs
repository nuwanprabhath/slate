// The review gate's rules, shared by scripts/agents/merge-wp.mjs, the Stop hook and the
// guard-edits hook, and unit-tested in tools/guards/reviewGate.test.ts. Plain functions over text.
import { createHash, verify } from 'node:crypto'
import { globToRegExp } from '../../tools/eslint-rules/paths.mjs'

/**
 * Guard files: the lint config and rules, guard tests (not the reasoned allowlists, which the
 * ratchet stops growing), hooks, tsconfigs, test configs, root manifest, CI and the agent scripts.
 * One list for guard-edits.mjs, merge-wp and the CI commit check.
 */
const GUARDED = [
  /^eslint\.config\.mjs$/,
  /^\.dependency-cruiser\.cjs$/,
  /^tools\/eslint-rules\//,
  /^tools\/lint\//,
  /^tools\/guards\/(?!allowlists\/[^/]+\.json$)/,
  /^\.claude\//,
  /^\.githooks\//,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest(\.\w+)?\.config\.[cm]?ts$/,
  /^package\.json$/,
  /^\.github\/workflows\//,
  /^scripts\/agents\//,
  // The CLAUDE.md product rules' spec tests (red team re-run R3).
  /^packages\/[^/]+\/(test|e2e)\/spec\//,
  // The UI audit and reviewUi: an agent whose screen fails the audit must fix the screen, not the audit (phase 13).
  /^packages\/desktop\/e2e\/ui\/(audit|review)\.ts$/,
]
export const isGuardFile = (rel) => GUARDED.some((re) => re.test(rel))

/** The trailer a commit that changes a guard file carries (checked in CI by check-guard-commits.mjs). */
export const GUARDRAIL_TRAILER = 'Guardrail-Change:'

/** Commits (from `git log --format=%H%x00%B%x00%x00 --name-only`) touching guard files without the trailer. */
export function unmarkedGuardCommits(commits, exempt = []) {
  return commits.filter((c) => !exempt.includes(c.sha) && c.files.some(isGuardFile) && !c.message.split('\n').some((l) => l.trim().startsWith(GUARDRAIL_TRAILER)))
}

/** `phase11/g1` → `phase11-g1.md`, the name the lead's reviews use. */
export const reviewFileName = (branch) => `${branch.replace(/\//g, '-')}.md`

/**
 * Null when the review approves exactly `head`, else what is wrong. The last non-empty line must be
 * `VERDICT: APPROVE`, and a `Reviewed: <sha>` (or `Commit: <sha>`) line must name the branch head:
 * a review of an older commit does not cover what was pushed after it.
 */
export function checkReview(text, head) {
  if (text === null) return 'no review file'
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (lines.at(-1) !== 'VERDICT: APPROVE') return `its last line is "${lines.at(-1) ?? ''}", not "VERDICT: APPROVE"`
  const commit = /^(?:\*\*)?(?:Reviewed|Commit):?(?:\*\*)?:?\s*`?([0-9a-f]{7,40})`?/im.exec(text)?.[1]
  if (!commit) return 'it records no "Reviewed: <sha>" line'
  if (!head.startsWith(commit)) return `it reviewed ${commit}, but the branch head is ${head.slice(0, 12)}`
  return null
}

/** Changed files under a security glob, or listed in any allowlist (an allowlisted file is reviewed code). */
export function sensitiveFiles(changed, globsText, allowlistedFiles = []) {
  const globs = globsText.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map(globToRegExp)
  return changed.filter((f) => allowlistedFiles.includes(f) || globs.some((re) => re.test(f)))
}

const isPlainTest = (f) => /\.(test|spec)\.tsx?$/.test(f) && !/\/(test|e2e)\/spec\//.test(f)

/**
 * Which review a branch needs (red team re-run, review volume):
 * - `security`: a security path, an allowlisted file, or a risky line anywhere;
 * - `architecture`: other main-process code (architecture-paths.txt);
 * - `none`: the rest. A plain test file triggers no path tier; its risky lines still count.
 */
export function reviewTier({ changed, diff, security, architecture, allowlisted = [] }) {
  const code = changed.filter((f) => !isPlainTest(f))
  const sensitive = sensitiveFiles(code, security, allowlisted)
  const risky = riskyAdditions(diff ?? '')
  if (sensitive.length > 0 || risky.length > 0) return { tier: 'security', sensitive, risky, structural: [] }
  const structural = sensitiveFiles(code, architecture, [])
  return { tier: structural.length > 0 ? 'architecture' : 'none', sensitive, risky, structural }
}

/** Added lines that need a reviewer whatever their path. */
const RISKY = [
  { why: 'child process', re: /child_process|\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(|\bshell\s*:/ },
  { why: 'crypto', re: /\bcrypto\b|createCipheriv|createHmac|createHash|randomBytes|\bsubtle\b|webcrypto/ },
  { why: 'environment', re: /process\s*(\.\s*env\b|\[\s*['"`]env)/ },
  { why: 'skipped test', re: /\.(skip|todo|skipIf|fixme)\s*\(/ },
  { why: 'inline lint comment', re: /eslint-disable|\/\*\s*(eslint|global)\b|@ts-(ignore|expect-error|nocheck)/ },
  { why: 'ungated IPC policy', re: /:\s*'(pre-unlock|flush|send-pre-unlock)'/ },
  { why: 'TLS or window security', re: /rejectUnauthorized|NODE_TLS|webPreferences|contextIsolation|sandbox\s*:|nodeIntegration|webSecurity/ },
  { why: 'SQL text', re: /\.(prepare|pragma)\s*\(\s*[^'"`)]|\.exec\s*\(\s*`[^`]*\$\{/ },
  { why: 'module loading', re: /createRequire|\brequire\s*\(/ },
  // The product rule "no auto-formatting by default" (red team G2-1).
  // Block formatting from anywhere but an explicit command, and the ProseMirror hooks that rewrite typing (final F-2).
  { why: 'editor input rules', re: /enableInputRules|enablePasteRules|Typography|addInputRules|addPasteRules|\bInputRule\b|\bPasteRule\b|\b(setHeading|toggleHeading|setBlockquote|toggleBlockquote|toggle\w*List|setCodeBlock|toggleCodeBlock|wrapIn\w*|setNode)\b|handleTextInput|appendTransaction|\binputRules\s*\(/ },
  // A key leaving the ring, unwrapped, or bytes becoming text (red team G2-5, G2-8).
  { why: 'key material', re: /\b(ring|keyRing|keys)\s*\.\s*get\s*\(|\.get\s*\(\s*['"`](mk|lk|sync|name|nameEnc|check|prefs|localwrap|kek\w*)['"`]\s*\)|vaultKeyBuffer\s*\(|withKeyBytes\s*\(|\.toString\s*\(\s*['"`](hex|base64|base64url)['"`]/i },
]

/** The risky categories among the `+` lines of a unified diff, one entry per category, in order. */
export function riskyAdditions(diff) {
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  const out = []
  for (const { why, re } of RISKY) {
    const line = added.find((l) => re.test(l))
    if (line) out.push({ why, line: line.slice(1).trim() })
  }
  // An expectation removed or rewritten in a test is how a test is bent to match a bug (red team re-run R3).
  let file = ''
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '')
    else if (l.startsWith('-') && !l.startsWith('---') && /\.(test|spec)\.tsx?$/.test(file) && /\bexpect(\.\w+)?\s*\(/.test(l)) {
      out.push({ why: 'removed expectation', line: `${file}: ${l.slice(1).trim()}` })
      break
    }
  }
  return out
}

/** Every `No-…-Reason:` trailer in the branch's commit messages. */
export const reasonTrailers = (log) => log.split('\n').map((l) => l.trim()).filter((l) => /^No-[A-Za-z-]+-Reason:/.test(l))

const CONVENTIONAL = /^(feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert)(\([a-z0-9-]+\))?!?: .+/
const AI = /^co-authored-by:.*(claude|anthropic|openai|copilot)|generated with \[?claude/im

/** What the commit-msg hook should have refused, re-checked (it can be skipped with git config). */
export function conventionalProblems(messages) {
  const out = []
  for (const message of messages) {
    const subject = message.split('\n')[0] ?? ''
    if (!subject.startsWith('Merge') && !CONVENTIONAL.test(subject)) out.push(`not a Conventional Commit: "${subject}"`)
    if (AI.test(message)) out.push(`AI attribution in "${subject}"`)
  }
  return out
}

/** What the lead signs for an unlock line (scripts/agents/unlock.mjs). */
export const UNLOCK_MESSAGE = (branch, token) => `slate-guardrails-unlock v1\n${branch} ${token}`

/**
 * The maintainer's confirmation that they read a set of guard-file changes (red team G2-13): Ed25519
 * by the lead key, which only a Keychain dialog (or, on Linux, a typed passphrase) releases, over the
 * subject (a branch, or `<from>..<to>` in batch mode), the head commit and the hash of the guard diff.
 */
export const CONFIRM_MESSAGE = (subject, head, hash) => `slate-guardrails-confirm v1\n${subject} ${head} ${hash}`
export const CONFIRMATIONS_FILE = 'slate-guardrails-confirmed'
export const guardDiffHash = (diff) => createHash('sha256').update(diff, 'utf8').digest('hex')

const verifies = (message, signature, publicKeyPem) => {
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKeyPem, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/**
 * merge-wp's signature on a merge it made (red team final F-3): Ed25519 by the lead key over the
 * merge's parents and tree, carried as a trailer. An amended tree, re-parented commit, or a plain
 * `git merge` carries none that verifies.
 */
export const MERGE_MESSAGE = (p1, p2, tree) => `slate-merge-wp v1\n${p1} ${p2} ${tree}`
const MERGE_TRAILER = 'Merge-WP-Signature'
export const mergeTrailer = (signature) => `${MERGE_TRAILER}: ${signature}`

/** Whether `commit` ({ parents, tree, body }) is a merge-wp merge signed by the lead key. */
export function mergeSignatureOk({ parents, tree, body }, publicKeyPem) {
  if (!publicKeyPem || parents.length !== 2) return false
  const m = new RegExp(`^${MERGE_TRAILER}:\\s*(\\S+)\\s*$`, 'm').exec(body)
  return m !== null && verifies(MERGE_MESSAGE(parents[0], parents[1], tree), m[1], publicKeyPem)
}

/** The first-parent commits new on main that are neither signed merge-wp merges nor covered by a maintainer confirmation. */
export const unacceptedCommits = ({ commits, covered, publicKey }) => commits.filter((c) => !mergeSignatureOk(c, publicKey) && !covered(c.sha))

/** The guard files that differ between two commits. `git(...args)` returns stdout. */
export const guardFilesBetween = (git, from, to) => git('diff', '--name-only', '--no-renames', from, to).split('\n').map((l) => l.trim()).filter((f) => f && isGuardFile(f))

/** `(from, to) => the guard-file diff text` ('' when no guard file differs), the text every confirmation hashes. */
export const guardDiffWith = (git) => (from, to) => {
  const files = guardFilesBetween(git, from, to)
  return files.length === 0 ? '' : git('diff', '--no-color', '--no-ext-diff', '--no-renames', '--full-index', from, to, '--', ...files)
}

/** Every confirmation line (`<subject> <head> <hash> <signature>`) the lead key signed. */
export function confirmations(text, publicKeyPem) {
  if (!publicKeyPem || !text) return []
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4 && verifies(CONFIRM_MESSAGE(p[0], p[1], p[2]), p[3], publicKeyPem))
    .map(([subject, head, hash]) => ({ subject, head, hash }))
}

/** Whether `text` holds a signed confirmation of exactly this subject, head and guard diff. */
export const confirmedFor = (text, { subject, head, hash }, publicKeyPem) => confirmations(text, publicKeyPem).some((c) => c.subject === subject && c.head === head && c.hash === hash)

/**
 * Whether pushing `local` over `remote` carries only confirmed guard-file changes: either none changed,
 * or one batch confirmation `<from>..<to>` covers them, `from` with the remote's guard files, `to` with
 * the local ones, and its hash is the guard diff between them. `guardDiff(from, to)` is the text.
 */
export function pushConfirmed({ guardDiff, confirmations: text, publicKey, remote, local }) {
  if (guardDiff(remote, local) === '') return true
  return confirmations(text, publicKey).some(({ subject, head, hash }) => {
    const m = /^(\S+)\.\.(\S+)$/.exec(subject)
    if (!m || m[2] !== head) return false
    return guardDiff(remote, m[1]) === '' && guardDiff(head, local) === '' && guardDiffHash(guardDiff(m[1], head)) === hash
  })
}

/**
 * Whether the unlock file lets `branch` edit guard files. Each line is `<branch> <token> <signature>`:
 * the token is the absolute worktree path or the branch's first commit since main, and the signature
 * is Ed25519 by the lead's key (public half in tools/guards/unlock-key.pub). An unsigned line, a
 * bare name, a line signed by any other key, or the name taken by renaming another branch unlocks
 * nothing; so does any line when there is no public key.
 */
export function unlockedFor(text, { branch, worktree, firstCommit }, publicKeyPem) {
  if (!publicKeyPem) return false
  for (const line of text.split('\n')) {
    const [name, token, signature, ...rest] = line.trim().split(/\s+/)
    if (rest.length > 0 || !name || !token || !signature || name !== branch) continue
    if (token !== worktree && !(/^[0-9a-f]{40}$/.test(token) && token === firstCommit)) continue
    try {
      if (verify(null, Buffer.from(UNLOCK_MESSAGE(name, token), 'utf8'), publicKeyPem, Buffer.from(signature, 'base64'))) return true
    } catch {
      // A malformed key or signature unlocks nothing.
    }
  }
  return false
}


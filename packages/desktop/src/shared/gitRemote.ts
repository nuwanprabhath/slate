/**
 * What Slate will hand `git` as a remote URL, a branch or a repository name (review C3).
 *
 * `git` reads its own options out of an argument list, and a remote URL of the form
 * `<helper>::<address>` makes it run `git-remote-<helper>`. A stored setting is therefore not just
 * data: an allow-list here, before the value is stored and again before it is used, keeps a value
 * that arrived over IPC or out of a settings file from turning into an option or a helper name.
 * Defence in depth, not a live hole: git 2.54 already refuses the `ext` transport by default.
 *
 * Pure and shared, so main's settings path and its git callers agree on one answer. `allowLocal`
 * is the caller's to decide; main sets it from the e2e/test hook, never from a bare environment read.
 */

/** Matches `ipcValidators.MAX_PATH`: a URL can be a deep path, but not unbounded. */
const MAX_REMOTE = 4096
const MAX_BRANCH = 200
const MAX_REPO_NAME = 100

/** True for anything outside printable ASCII-or-above: NUL, newlines, escapes and every space. */
function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}
const REMOTE_SCHEMES = ['https://', 'ssh://', 'git+ssh://']
const LOCAL_SCHEME = 'file://'
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** `[user@]host:path` — the host holds no `/` or `:`, and the path starts with neither `:` nor nothing. */
const SCP_STYLE = /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9._-]+:(?![:/])[^\s]+$/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/

export interface RemoteOptions {
  /** Accept `file://` and a path on this machine: the e2e and unit tests sync against a local repo. */
  allowLocal: boolean
}

function hasHost(url: string): boolean {
  try {
    return new URL(url).hostname.length > 0
  } catch {
    return false
  }
}

/** A remote URL Slate will pass to `git`. */
export function isAllowedRemote(value: unknown, { allowLocal }: RemoteOptions): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REMOTE) return false
  if (hasUnsafeChar(value) || value.startsWith('-')) return false
  // `<helper>::<address>`: a transport name is everything before the first `::` and holds no `/`.
  const helper = value.indexOf('::')
  if (helper >= 0 && !value.slice(0, helper).includes('/')) return false
  if (SCHEME.test(value)) {
    // An empty authority (`https:///owner/repo`) is read back as a host by `URL`; git is not so forgiving.
    const remote = REMOTE_SCHEMES.find((s) => value.toLowerCase().startsWith(s))
    if (remote) return !value.slice(remote.length).startsWith('/') && hasHost(value)
    return allowLocal && value.toLowerCase().startsWith(LOCAL_SCHEME) && value.length > LOCAL_SCHEME.length
  }
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || WINDOWS_PATH.test(value)) return allowLocal
  return SCP_STYLE.test(value)
}

/**
 * A branch name by git's rules (git-check-ref-format), minus the forms Slate never makes: it is one
 * component path, never a leading `-` that `git` would read as an option.
 */
export function isAllowedBranch(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BRANCH) return false
  if (hasUnsafeChar(value) || value.startsWith('-')) return false
  if (/[~^:?*[\\]/.test(value)) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.startsWith('.') || value.endsWith('.')) return false
  if (value === '@') return false
  // git applies the dot and `.lock` rules to every component, not only to the whole name.
  return value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** A repository name for GitHub's create-repository call, which becomes a remote URL afterwards. */
export function isAllowedRepoName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REPO_NAME) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { LOCAL_TIMEOUT_MS, NETWORK_TIMEOUT_MS, type GitResult, type GitRunner } from './gitRunner'
import { OfflineError, UnrelatedHistoryError, UnverifiableFileError, type DeltaPage, type RemoteDrive, type RemoteItem } from './types'

export interface GitDriveOptions {
  run: GitRunner
  /** The local clone; created on first use. */
  dir: string
  remoteUrl: string
  branch: string
  /** Extra environment for commands that reach the remote (a token's `GIT_CONFIG_*`). */
  authEnv: () => Promise<Record<string, string>>
  author: { name: string; email: string }
  /** Named in commit messages; defaults to the author name. */
  deviceName?: string
  /** Replaces the per-device commit message (encrypted remotes name no device). */
  commitMessage?: string
}

export const README = `# Slate notes

This repository is managed by Slate. It holds your notebooks as Slate sync files; edit them in
Slate, not here. Each device writes only its own files under \`docs/<notebook>/<device>/\`.
`

const MAX_PUSH_ATTEMPTS = 5
/** Present only on an encrypted remote (the desktop's `REMOTE_VAULT_PATH`). */
const VAULT_PATH = 'e2ee/vault.json'
// Regular files only: a gitlink (160000) or symlink (120000) is never a sync file.
const REGULAR = new Set(['100644', '100755'])
// Closes the gap between lstat and open; Windows has no O_NOFOLLOW (constants leaves it undefined).
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const OFFLINE = /Could not resolve host|Connection refused|unable to access|Network is unreachable|Operation timed out|Connection timed out|Could not resolve hostname/i
const SIGNED_OUT = /Authentication failed|Permission denied \(publickey|could not read Username|could not read Password|terminal prompts disabled/i
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
const fields = (bytes: Uint8Array) => text(bytes).split('\0').filter((s) => s !== '')

/** A git failure as the sync engine understands it: offline, signed out, or an error. */
function gitError(args: string[], r: GitResult): Error {
  const detail = r.stderr.trim().split('\n').slice(-3).join(' ')
  const message = `git ${args[0]} failed: ${r.timedOut ? 'timed out' : detail}`
  if (r.timedOut || OFFLINE.test(r.stderr)) return new OfflineError(message)
  if (SIGNED_OUT.test(r.stderr)) return Object.assign(new Error(message), { status: 401 })
  return new Error(message)
}

/**
 * The Slate sync folder as a git repository. Writes land in a local clone; `flush` commits and
 * pushes them, and `delta` fetches and rebases. Devices write disjoint paths, so a rebase never
 * conflicts.
 */
export class GitDrive implements RemoteDrive {
  readonly dir: string
  private readonly opts: GitDriveOptions
  private ready: Promise<void> | undefined

  constructor(opts: GitDriveOptions) {
    this.opts = opts
    this.dir = opts.dir
  }

  private get identity(): Record<string, string> {
    const { name, email } = this.opts.author
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
  }

  private async git(args: string[], network = false, input?: string): Promise<GitResult> {
    const env = { ...this.identity, ...(network ? await this.opts.authEnv() : {}) }
    return this.opts.run(args, {
      cwd: this.dir,
      env,
      timeoutMs: network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      ...(input !== undefined ? { input: new TextEncoder().encode(input) } : {}),
    })
  }

  private async must(args: string[], network = false, input?: string): Promise<GitResult> {
    const r = await this.git(args, network, input)
    if (r.code !== 0) throw gitError(args, r)
    return r
  }

  private file(path: string): string {
    const rel = normalize(path)
    if (path === '' || isAbsolute(path) || rel.startsWith('..') || rel.split(/[\\/]/)[0] === '.git') {
      throw new Error(`Not a sync path: ${path}`)
    }
    return join(this.dir, rel)
  }

  /** Retried on the next call until it succeeds. */
  private ensureClone(): Promise<void> {
    this.ready ??= this.setUp().catch((err: unknown) => {
      this.ready = undefined
      throw err
    })
    return this.ready
  }

  private async setUp(): Promise<void> {
    const { branch, remoteUrl } = this.opts
    if (!existsSync(join(this.dir, '.git'))) {
      await mkdir(this.dir, { recursive: true })
      await this.must(['init', `--initial-branch=${branch}`])
      await this.must(['remote', 'add', 'origin', remoteUrl])
    } else {
      await this.must(['remote', 'set-url', 'origin', remoteUrl])
    }
    // A symlink committed by someone with push access would otherwise point our reads and writes outside the clone.
    await this.must(['config', 'core.symlinks', 'false'])
    if ((await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0) return
    await this.fetch()
    if (await this.hasRemoteBranch()) {
      await this.must(['reset', '--hard', `origin/${branch}`])
      return
    }
    // An empty remote: the README makes the first commit, so every device then shares a root.
    await writeFile(join(this.dir, 'README.md'), README)
    await this.must(['add', '--', 'README.md'])
    await this.commit('slate: initialise')
    await this.push()
  }

  /** Only the sync branch, no tags: other branches may hold plaintext history that must not land here. */
  private async fetch(): Promise<void> {
    const { branch } = this.opts
    const args = ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]
    const r = await this.git(args, true)
    // An empty remote has no such branch yet; `hasRemoteBranch` then finds none.
    if (r.code !== 0 && !/couldn't find remote ref/i.test(r.stderr)) throw gitError(args, r)
  }

  private async hasRemoteBranch(): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${this.opts.branch}`])).code === 0
  }

  private async commit(message: string): Promise<void> {
    // The user's global hooks and signing setup are for their own repositories, not this one.
    await this.must(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message])
  }

  /**
   * Commits the work tree; returns false when there was nothing to commit. Each git process costs
   * tens of milliseconds (more under Electron), so an idle sync is kept to a few.
   */
  private async commitAll(): Promise<boolean> {
    const changes = fields((await this.must(['status', '--porcelain', '-z', '--untracked-files=all'])).stdout)
    if (changes.length === 0) return false
    // Every sync rewrites this device's record with a new lastSeen. Alone, that would be a commit
    // per device per sync interval forever, so it only rides along with real changes.
    if (changes.every((c) => c.startsWith(' M devices/') || c.startsWith(' M e2ee/v/'))) {
      await this.must(['checkout', '-q', '--', ...changes.map((c) => c.slice(3))])
      return false
    }
    await this.must(['add', '-A'])
    const n = changes.length
    await this.commit(this.opts.commitMessage ?? `slate: ${this.opts.deviceName ?? this.opts.author.name} (${n} ${n === 1 ? 'file' : 'files'})`)
    this.ahead = true
    return true
  }

  /** The local branch's and origin's commits, in one process. */
  private async refs(): Promise<{ head: string; remote: string | undefined }> {
    const { branch } = this.opts
    const out = text((await this.must(['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`])).stdout)
    const sha = (ref: string) => out.split('\n').find((l) => l.startsWith(`${ref} `))?.split(' ')[1]
    return { head: sha(`refs/heads/${branch}`) ?? '', remote: sha(`refs/remotes/origin/${branch}`) }
  }

  /** Puts local commits on top of origin's; returns the new HEAD. */
  private async rebase(): Promise<string> {
    const { head, remote } = await this.refs()
    if (!remote || remote === head) return head
    const related = (await this.git(['merge-base', head, remote])).code === 0
    // One process for both: a missing object prints "<name> missing".
    const check = await this.must(['cat-file', '--batch-check'], false, `${remote}:${VAULT_PATH}\n${head}:${VAULT_PATH}\n`)
    const [remoteVault, headVault] = text(check.stdout).split('\n').map((l) => !l.endsWith(' missing'))
    if (!related) throw new UnrelatedHistoryError(remoteVault === true)
    if (remoteVault && !headVault) throw new UnrelatedHistoryError(true)
    const r = await this.git(['rebase', '-q', `origin/${this.opts.branch}`])
    if (r.code !== 0) {
      await this.git(['rebase', '--abort'])
      throw gitError(['rebase'], r)
    }
    return text((await this.must(['rev-parse', 'HEAD'])).stdout).trim()
  }

  private async push(): Promise<void> {
    const args = ['push', '-q', 'origin', `HEAD:refs/heads/${this.opts.branch}`]
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const r = await this.git(args, true)
      if (r.code === 0) {
        this.ahead = false
        return
      }
      if (!REJECTED.test(r.stderr) || OFFLINE.test(r.stderr) || SIGNED_OUT.test(r.stderr)) throw gitError(args, r)
      await this.fetch()
      await this.rebase()
    }
    throw new Error(`git push was rejected ${MAX_PUSH_ATTEMPTS} times; another device keeps pushing`)
  }

  /** Known after this process's first commit or push; asked of git once otherwise. */
  private ahead: boolean | undefined

  private async unpushed(): Promise<boolean> {
    if (this.ahead !== undefined) return this.ahead
    const r = await this.git(['rev-list', '--count', `origin/${this.opts.branch}..HEAD`])
    this.ahead = r.code !== 0 || Number(text(r.stdout).trim()) > 0
    return this.ahead
  }

  async upload(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureClone()
    const file = this.file(path)
    await this.checkParents(path)
    await mkdir(dirname(file), { recursive: true })
    await this.checkParents(path)
    await this.regularOrMissing(path, file)
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
  }

  async download(path: string): Promise<Uint8Array> {
    await this.ensureClone()
    const file = this.file(path)
    await this.checkParents(path)
    let regular: boolean
    try {
      regular = await this.regularOrMissing(path, file)
    } catch (err) {
      // A gitlink checks out as a folder; whatever a remote put there, it is not a file of ours.
      throw new UnverifiableFileError(err instanceof Error ? err.message : undefined, { cause: err })
    }
    if (!regular) throw Object.assign(new Error(`404 ${path}`), { status: 404 })
    const handle = await open(file, constants.O_RDONLY | NOFOLLOW)
    try {
      return new Uint8Array(await handle.readFile())
    } finally {
      await handle.close()
    }
  }

  async remove(path: string): Promise<void> {
    await this.ensureClone()
    const file = this.file(path)
    await this.checkParents(path)
    if (await this.regularOrMissing(path, file)) await rm(file, { force: true })
  }

  /** Every existing folder on the way to `path` must be a real folder inside the clone, not a symlink. */
  private async checkParents(path: string): Promise<void> {
    const parts = normalize(path).split(/[\\/]/).slice(0, -1)
    let at = this.dir
    for (const part of parts) {
      at = join(at, part)
      const stat = await lstat(at).catch((err: { code?: string }) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (stat === null) return
      if (!stat.isDirectory()) throw new Error(`Refusing ${path}: it leads outside the sync folder`)
    }
  }

  /** True for a regular file, false when absent; anything else (a symlink, a folder, a device) is refused. */
  private async regularOrMissing(path: string, file: string): Promise<boolean> {
    const stat = await lstat(file).catch((err: { code?: string }) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (stat === null) return false
    if (!stat.isFile()) throw new Error(`Refusing ${path}: not a regular file`)
    return true
  }

  /** Commits what was written since the last flush and pushes it, rebasing on rejection. */
  async flush(): Promise<void> {
    await this.ensureClone()
    await this.commitAll()
    if (await this.unpushed()) await this.push()
  }

  async delta(cursor: string | null): Promise<DeltaPage> {
    await this.ensureClone()
    // A clean tree to rebase; the commit goes out with the next flush.
    await this.commitAll()
    await this.fetch()
    const head = await this.rebase()
    if (cursor === head) return { items: [], cursor: head }
    // A cursor this clone does not have (another remote's, or a re-clone) lists everything.
    const diff = cursor === null ? undefined : await this.git(['diff', '--name-status', '--no-renames', '-z', cursor, head])
    if (!diff || diff.code !== 0) {
      const items = [...(await this.tree())].map(([path, { sha, size }]): RemoteItem => ({ id: path, path, eTag: sha, deleted: false, isFile: true, size }))
      return { items, cursor: head }
    }
    const changed = fields(diff.stdout)
    const blobs = changed.some((s, i) => i % 2 === 0 && s !== 'D') ? await this.tree() : new Map<string, { sha: string; size: number }>()
    const items: RemoteItem[] = []
    for (let i = 0; i + 1 < changed.length; i += 2) {
      const path = changed[i + 1]!
      const deleted = changed[i] === 'D'
      const blob = deleted ? undefined : blobs.get(path)
      if (!deleted && !blob) continue
      items.push({ id: path, path, eTag: blob?.sha ?? '', deleted, isFile: true, ...(blob ? { size: blob.size } : {}) })
    }
    return { items, cursor: head }
  }

  /** Every file at HEAD with its blob sha and size. */
  private async tree(): Promise<Map<string, { sha: string; size: number }>> {
    const out = new Map<string, { sha: string; size: number }>()
    for (const entry of fields((await this.must(['ls-tree', '-r', '-l', '-z', 'HEAD'])).stdout)) {
      const tab = entry.indexOf('\t')
      // `-l` pads the size column with spaces.
      const [mode, type, sha, size] = entry.slice(0, tab).split(/ +/)
      if (type === 'blob' && REGULAR.has(mode!)) out.set(entry.slice(tab + 1), { sha: sha!, size: Number(size) })
    }
    return out
  }
}

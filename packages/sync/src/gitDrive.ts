import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { LOCAL_TIMEOUT_MS, NETWORK_TIMEOUT_MS, type GitResult, type GitRunner } from './gitRunner'
import { OfflineError, type DeltaPage, type RemoteDrive, type RemoteItem } from './types'

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
}

export const README = `# Slate notes

This repository is managed by Slate. It holds your notebooks as Slate sync files; edit them in
Slate, not here. Each device writes only its own files under \`docs/<notebook>/<device>/\`.
`

const MAX_PUSH_ATTEMPTS = 5
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

  private async git(args: string[], network = false): Promise<GitResult> {
    const env = { ...this.identity, ...(network ? await this.opts.authEnv() : {}) }
    return this.opts.run(args, { cwd: this.dir, env, timeoutMs: network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS })
  }

  private async must(args: string[], network = false): Promise<GitResult> {
    const r = await this.git(args, network)
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
    if ((await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0) return
    await this.must(['fetch', 'origin'], true)
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

  private async hasRemoteBranch(): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${this.opts.branch}`])).code === 0
  }

  private async commit(message: string): Promise<void> {
    // The user's global hooks and signing setup are for their own repositories, not this one.
    await this.must(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message])
  }

  /** Stages the work tree and commits it; returns false when there was nothing to commit. */
  private async commitAll(): Promise<boolean> {
    await this.must(['add', '-A'])
    const staged = fields((await this.must(['diff', '--cached', '--name-only', '-z'])).stdout)
    if (staged.length === 0) return false
    const n = staged.length
    await this.commit(`slate: ${this.opts.deviceName ?? this.opts.author.name} (${n} ${n === 1 ? 'file' : 'files'})`)
    return true
  }

  private async rebase(): Promise<void> {
    if (!(await this.hasRemoteBranch())) return
    const r = await this.git(['rebase', '-q', `origin/${this.opts.branch}`])
    if (r.code === 0) return
    await this.git(['rebase', '--abort'])
    throw gitError(['rebase'], r)
  }

  private async push(): Promise<void> {
    const args = ['push', '-q', 'origin', `HEAD:refs/heads/${this.opts.branch}`]
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const r = await this.git(args, true)
      if (r.code === 0) return
      if (!REJECTED.test(r.stderr) || OFFLINE.test(r.stderr) || SIGNED_OUT.test(r.stderr)) throw gitError(args, r)
      await this.must(['fetch', 'origin'], true)
      await this.rebase()
    }
    throw new Error(`git push was rejected ${MAX_PUSH_ATTEMPTS} times; another device keeps pushing`)
  }

  private async unpushed(): Promise<boolean> {
    if (!(await this.hasRemoteBranch())) return true
    const r = await this.must(['rev-list', '--count', `origin/${this.opts.branch}..HEAD`])
    return Number(text(r.stdout).trim()) > 0
  }

  async upload(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureClone()
    const file = this.file(path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }

  async download(path: string): Promise<Uint8Array> {
    await this.ensureClone()
    try {
      return new Uint8Array(await readFile(this.file(path)))
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') throw Object.assign(new Error(`404 ${path}`), { status: 404 })
      throw err
    }
  }

  async remove(path: string): Promise<void> {
    await this.ensureClone()
    await rm(this.file(path), { force: true })
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
    await this.must(['fetch', 'origin'], true)
    await this.rebase()
    const head = text((await this.must(['rev-parse', 'HEAD'])).stdout).trim()
    const blobs = await this.tree()
    const known = cursor !== null && (await this.git(['cat-file', '-e', `${cursor}^{commit}`])).code === 0
    if (!known) {
      const items = [...blobs].map(([path, sha]): RemoteItem => ({ id: path, path, eTag: sha, deleted: false, isFile: true }))
      return { items, cursor: head }
    }
    const diff = fields((await this.must(['diff', '--name-status', '--no-renames', '-z', cursor, head])).stdout)
    const items: RemoteItem[] = []
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const status = diff[i]!
      const path = diff[i + 1]!
      const deleted = status === 'D'
      items.push({ id: path, path, eTag: deleted ? '' : (blobs.get(path) ?? ''), deleted, isFile: true })
    }
    return { items, cursor: head }
  }

  /** Every file at HEAD with its blob sha. */
  private async tree(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const entry of fields((await this.must(['ls-tree', '-r', '-z', 'HEAD'])).stdout)) {
      const tab = entry.indexOf('\t')
      const [, type, sha] = entry.slice(0, tab).split(' ')
      if (type === 'blob') out.set(entry.slice(tab + 1), sha!)
    }
    return out
  }
}

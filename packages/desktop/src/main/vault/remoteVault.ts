import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { KeyHandle } from '@slate/native'
import { NETWORK_TIMEOUT_MS, OfflineError, type GitResult, type GitRunner } from '@slate/sync'
import { canonicalJson, floorOf, isDowngrade, parseHeader, verifyCheck, type VaultHeader } from './header'
import type { WeakKdfOption } from './kdf'

/** The remote copy of the header (§4); written only by compare-and-swap (§15 N2). */
export const REMOTE_VAULT_PATH = 'e2ee/vault.json'
/** A header is a few hundred bytes; anything far larger is refused unread. */
const MAX_HEADER_BYTES = 64 * 1024
const MAX_CLAIM_ATTEMPTS = 3
const MAX_HEADER_ATTEMPTS = 5

export const ROOT_README = `# Slate notes (end-to-end encrypted)

This repository is end-to-end encrypted by Slate. Only Slate, with your password or recovery key,
can read it. Slate 0.1.x cannot read it: update every device before syncing it again.
`
export const E2EE_README = `# Encrypted Slate notes

\`vault.json\` holds the encrypted keys; every other file here is sealed with AES-256-GCM. Do not
edit these files by hand.
`

export interface RemoteSnapshot {
  /** The parsed JSON of `e2ee/vault.json`, untrusted; null when there is none. */
  header: unknown
  /** What a compare-and-swap must still find: the branch's commit, or the header's eTag. Null: nothing there. */
  version: string | null
  /** Top-level entries (OneDrive) or files (git) that are not ours: plaintext from an older Slate. */
  otherFiles: string[]
}

export interface VaultRemote {
  read(): Promise<RemoteSnapshot>
  /**
   * §7.2: replaces the whole remote with the README and `e2ee/` files, only if it is still at
   * `version`. False when another writer got there first.
   */
  claim(header: VaultHeader, version: string | null): Promise<boolean>
  /** Writes `e2ee/vault.json` over `version` (from `read`); false when it changed since. */
  writeHeader(header: VaultHeader, version: string | null): Promise<boolean>
  /**
   * C9 (R-2, git only): the branch becomes one parentless commit of its current tree, pushed with a lease, so the
   * files sealed under earlier keys leave its history. False when the branch moved meanwhile.
   */
  replaceHistory?(): Promise<boolean>
}

const json = (header: VaultHeader) => `${JSON.stringify(header, null, 2)}\n`
const REJECTED = /\[rejected\]|stale info|non-fast-forward|fetch first|failed to push some refs/i
const OFFLINE = /Could not resolve host|Connection refused|unable to access|Network is unreachable|timed out|Could not resolve hostname/i

export interface GitVaultRemoteOptions {
  run: GitRunner
  /** A bare repository of its own: objects are built with plumbing, never in a work tree. */
  dir: string
  remoteUrl: string
  branch: string
  authEnv: () => Promise<Record<string, string>>
}

/** Claims and header writes on a git remote, by plumbing in a private bare repository. */
export class GitVaultRemote implements VaultRemote {
  /** The sync's vault check and a claim or header write can overlap; git locks its config and refs. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: GitVaultRemoteOptions) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }

  private async git(args: string[], opts: { network?: boolean; input?: string } = {}): Promise<GitResult> {
    const env = {
      GIT_AUTHOR_NAME: 'Slate',
      GIT_AUTHOR_EMAIL: 'slate@invalid',
      GIT_COMMITTER_NAME: 'Slate',
      GIT_COMMITTER_EMAIL: 'slate@invalid',
      ...(opts.network ? await this.opts.authEnv() : {}),
    }
    return this.opts.run(args, {
      cwd: this.opts.dir,
      env,
      ...(opts.input !== undefined ? { input: new TextEncoder().encode(opts.input) } : {}),
      ...(opts.network ? { timeoutMs: NETWORK_TIMEOUT_MS } : {}),
    })
  }

  private async must(args: string[], opts: { network?: boolean; input?: string } = {}): Promise<string> {
    const r = await this.git(args, opts)
    if (r.code !== 0) {
      const message = `git ${args[0]} failed: ${r.timedOut ? 'timed out' : r.stderr.trim().split('\n').slice(-2).join(' ')}`
      throw r.timedOut || OFFLINE.test(r.stderr) ? new OfflineError(message) : new Error(message)
    }
    return Buffer.from(r.stdout).toString('utf8')
  }

  private async ensure(): Promise<void> {
    if (!existsSync(join(this.opts.dir, 'HEAD'))) {
      await mkdir(this.opts.dir, { recursive: true })
      await this.must(['init', '-q', '--bare'])
      await this.must(['remote', 'add', 'origin', this.opts.remoteUrl])
    } else {
      await this.must(['remote', 'set-url', 'origin', this.opts.remoteUrl])
    }
  }

  private get ref(): string {
    return `refs/remotes/origin/${this.opts.branch}`
  }

  /** Fetches and returns the branch's commit, or null when the remote has no such branch. */
  private async fetch(): Promise<string | null> {
    await this.ensure()
    // Only the sync branch: other branches and tags may hold plaintext history that must not land here.
    const args = ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${this.opts.branch}:${this.ref}`]
    const fetched = await this.git(args, { network: true })
    if (fetched.code !== 0) {
      // An empty remote has no such branch: no vault, nothing to read.
      if (!/couldn't find remote ref/i.test(fetched.stderr)) await this.must(args, { network: true })
      await this.git(['update-ref', '-d', this.ref])
    }
    const r =await this.git(['rev-parse', '--verify', '-q', this.ref])
    return r.code === 0 ? Buffer.from(r.stdout).toString('utf8').trim() : null
  }

  read(): Promise<RemoteSnapshot> {
    return this.serial(() => this.readNow())
  }

  claim(header: VaultHeader, version: string | null): Promise<boolean> {
    return this.serial(() => this.claimNow(header, version))
  }

  writeHeader(header: VaultHeader, version: string | null): Promise<boolean> {
    return this.serial(() => (version === null ? this.claimNow(header, null) : this.writeHeaderNow(header, version)))
  }

  replaceHistory(): Promise<boolean> {
    return this.serial(async () => {
      const sha = await this.fetch()
      if (!sha) return false
      const tree = (await this.must(['rev-parse', `${sha}^{tree}`])).trim()
      const commit = (await this.must(['commit-tree', tree, '-m', 'slate: encrypted (history replaced)'])).trim()
      return this.push(commit, sha)
    })
  }

  private async readNow(): Promise<RemoteSnapshot> {
    const sha = await this.fetch()
    if (!sha) return { header: null, version: null, otherFiles: [] }
    const files = (await this.must(['ls-tree', '-r', '--name-only', '-z', sha])).split('\0').filter((f) => f !== '')
    let header: unknown = null
    if (files.includes(REMOTE_VAULT_PATH)) {
      const size = Number((await this.must(['cat-file', '-s', `${sha}:${REMOTE_VAULT_PATH}`])).trim())
      // An oversized or unparsable header is still a vault: parseHeader refuses it later.
      header = {}
      if (size <= MAX_HEADER_BYTES) {
        try {
          header = JSON.parse(await this.must(['cat-file', 'blob', `${sha}:${REMOTE_VAULT_PATH}`])) as unknown
        } catch {
          header = {}
        }
      }
    }
    return { header, version: sha, otherFiles: files.filter((f) => f !== 'README.md' && !f.startsWith('e2ee/')) }
  }

  private async blob(content: string): Promise<string> {
    return (await this.must(['hash-object', '-w', '--stdin'], { input: content })).trim()
  }

  private async mktree(entries: string[]): Promise<string> {
    return (await this.must(['mktree', '-z'], { input: entries.map((e) => `${e}\0`).join('') })).trim()
  }

  /** `git ls-tree -z` lines of a tree, or none when it does not exist. */
  private async entries(treeish: string): Promise<string[]> {
    const r = await this.git(['ls-tree', '-z', treeish])
    return r.code === 0 ? Buffer.from(r.stdout).toString('utf8').split('\0').filter((e) => e !== '') : []
  }

  private async push(commit: string, lease: string | null): Promise<boolean> {
    const { branch } = this.opts
    const args = ['push', '-q', ...(lease !== undefined ? [`--force-with-lease=refs/heads/${branch}:${lease ?? ''}`] : []), 'origin', `${commit}:refs/heads/${branch}`]
    const r = await this.git(args, { network: true })
    if (r.code === 0) return true
    if (REJECTED.test(r.stderr) && !OFFLINE.test(r.stderr)) return false
    throw r.timedOut || OFFLINE.test(r.stderr) ? new OfflineError(`git push failed: ${r.stderr.trim()}`) : new Error(`git push failed: ${r.stderr.trim()}`)
  }

  private async claimNow(header: VaultHeader, version: string | null): Promise<boolean> {
    await this.ensure()
    const e2ee = await this.mktree([`100644 blob ${await this.blob(E2EE_README)}\tREADME.md`, `100644 blob ${await this.blob(json(header))}\tvault.json`])
    const root = await this.mktree([`100644 blob ${await this.blob(ROOT_README)}\tREADME.md`, `040000 tree ${e2ee}\te2ee`])
    // No parent: the plaintext history is no longer reachable from the branch (§1).
    const commit = (await this.must(['commit-tree', root, '-m', 'slate: encrypted'])).trim()
    return this.push(commit, version)
  }

  private async writeHeaderNow(header: VaultHeader, version: string): Promise<boolean> {
    await this.ensure()
    const blob = await this.blob(json(header))
    const e2ee = await this.mktree([...(await this.entries(`${version}:e2ee`)).filter((e) => !e.endsWith('\tvault.json')), `100644 blob ${blob}\tvault.json`])
    const root = await this.mktree([...(await this.entries(version)).filter((e) => !e.endsWith('\te2ee')), `040000 tree ${e2ee}\te2ee`])
    const commit = (await this.must(['commit-tree', root, '-p', version, '-m', 'slate: vault'])).trim()
    // On top of `version`, so a plain push is refused when the branch moved: the swap.
    return this.push(commit, version)
  }
}

/** The subset of `GraphHttp` the OneDrive remote needs. */
export interface GraphLike {
  json<T>(url: string, init?: RequestInit): Promise<T>
  bytes(url: string): Promise<{ bytes: Uint8Array }>
  send(url: string, init: RequestInit): Promise<Response>
}

const APPROOT = '/me/drive/special/approot'
const itemPath = (path: string) => `${APPROOT}:/${path.split('/').map(encodeURIComponent).join('/')}`
const statusOf = (err: unknown) => (err as { status?: unknown }).status

/** Fetch rejects with a TypeError only when the network failed: the engine shows that as offline. */
async function offlineOnNetworkError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof TypeError) throw new OfflineError(err.message, { cause: err })
    throw err
  }
}

/** OneDrive's app folder: conditional create to claim, `If-Match` for header writes. */
export class OneDriveVaultRemote implements VaultRemote {
  constructor(private readonly http: GraphLike) {}

  read(): Promise<RemoteSnapshot> {
    return offlineOnNetworkError(() => this.readNow())
  }

  claim(header: VaultHeader, _version?: string | null): Promise<boolean> {
    return offlineOnNetworkError(() => this.claimNow(header))
  }

  writeHeader(header: VaultHeader, version: string | null): Promise<boolean> {
    return offlineOnNetworkError(() => this.writeHeaderNow(header, version))
  }

  private async readNow(): Promise<RemoteSnapshot> {
    const children = await this.http.json<{ value: Array<{ name: string }> }>(`${APPROOT}/children`)
    const otherFiles = children.value.map((c) => c.name).filter((n) => n !== 'e2ee' && n !== 'README.md')
    let meta: { eTag?: string; size?: number }
    try {
      meta = await this.http.json(itemPath(REMOTE_VAULT_PATH))
    } catch (err) {
      if (statusOf(err) === 404) return { header: null, version: null, otherFiles }
      throw err
    }
    let header: unknown = {}
    if ((meta.size ?? 0) <= MAX_HEADER_BYTES) {
      try {
        header = JSON.parse(new TextDecoder().decode((await this.http.bytes(`${itemPath(REMOTE_VAULT_PATH)}:/content`)).bytes)) as unknown
      } catch (err) {
        if (statusOf(err) !== undefined) throw err
      }
    }
    return { header, version: meta.eTag ?? '', otherFiles }
  }

  private put(path: string, body: string, init: { query?: string; ifMatch?: string } = {}): Promise<Response> {
    return this.http.send(`${itemPath(path)}:/content${init.query ?? ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...(init.ifMatch ? { 'If-Match': init.ifMatch } : {}) },
      body,
    })
  }

  /** The conditional create is the swap here, so no version is needed. */
  private async claimNow(header: VaultHeader): Promise<boolean> {
    try {
      await this.put(REMOTE_VAULT_PATH, json(header), { query: '?@microsoft.graph.conflictBehavior=fail' })
    } catch (err) {
      if (statusOf(err) === 409 || statusOf(err) === 412) return false
      throw err
    }
    await this.put('e2ee/README.md', E2EE_README)
    // Version history stays with OneDrive; the wizard tells the user to empty the recycle bin.
    for (const folder of ['docs', 'blobs', 'devices']) await this.http.send(itemPath(folder), { method: 'DELETE' }).catch((err: unknown) => {
      if (statusOf(err) !== 404) throw err
    })
    return true
  }

  private async writeHeaderNow(header: VaultHeader, version: string | null): Promise<boolean> {
    if (version === null) return this.claimNow(header)
    try {
      await this.put(REMOTE_VAULT_PATH, json(header), { ifMatch: version })
      return true
    } catch (err) {
      if (statusOf(err) === 412 || statusOf(err) === 409) return false
      throw err
    }
  }
}

export type ClaimResult = { kind: 'claimed' } | { kind: 'join'; header: unknown }

/** §7.2 step 2: claim, or join the vault another device put there first. */
export async function claimRemote(remote: VaultRemote, header: VaultHeader, beforeAttempt?: () => Promise<void>): Promise<ClaimResult> {
  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
    await beforeAttempt?.()
    const snap = await remote.read()
    if (snap.header !== null) return { kind: 'join', header: snap.header }
    if (await remote.claim(header, snap.version)) return { kind: 'claimed' }
  }
  throw new Error('The sync folder kept changing while Slate tried to encrypt it. Try again in a minute.')
}

/** Review C9 M5: the remote holds a header other than the one this device last saw: another device changed the vault. */
export class RemoteChangedElsewhere extends Error {
  override name = 'RemoteChangedElsewhere'
  constructor() {
    super('Another device changed the vault (its password or keys). Follow it first: let sync bring the change here, or lock Slate and unlock it with the current password, then try again.')
  }
}

/** The same header, compared as canonical JSON (a header has one text per content); null only matches null. */
export function sameHeader(remoteJson: unknown, expected: VaultHeader | null): boolean {
  if (remoteJson === null || expected === null) return remoteJson === expected
  try {
    return canonicalJson(remoteJson) === canonicalJson(expected)
  } catch {
    return false
  }
}

/**
 * Review C9 M4/M5: the one way a header is written to the remote: a true compare-and-swap. `expected` is the exact header
 * this device last read and verified there (null: an empty remote); the write is refused unless `snap` holds exactly
 * it, and then made only if the remote is still at `snap.version`. Another device's change, of any revision or epoch, is
 * never written over. False when the swap lost to a write made after `snap` was read.
 */
export async function casWriteHeader(remote: VaultRemote, snap: RemoteSnapshot, expected: VaultHeader | null, header: VaultHeader): Promise<boolean> {
  if (!sameHeader(snap.header, expected)) throw new RemoteChangedElsewhere()
  return remote.writeHeader(header, snap.version)
}

/** C9: the remote's header is newer than this device's and under keys it does not hold. */
export class KeysChangedElsewhere extends Error {
  override name = 'KeysChangedElsewhere'
  constructor() {
    super('The vault’s keys were changed on another device. Lock Slate and unlock it with your password, then try again.')
  }
}

/** The remote header as this version reads it; never one it cannot parse (review C5 L5). */
function remoteHeader(snap: RemoteSnapshot, opts: WeakKdfOption): VaultHeader {
  try {
    return parseHeader(snap.header, opts)
  } catch {
    const v = (snap.header as { version?: unknown } | null)?.version
    if (typeof v === 'number' && v > 3) throw new Error('The vault in the sync folder was made by a newer Slate. Update Slate on this device first.')
    throw new Error('The vault file in the sync folder is damaged; Slate will not write over it')
  }
}

/**
 * C9 (R-2): writes a rotated header by compare-and-swap over `seen`, the header this device last saw on the remote
 * (`base` when it has none recorded, a folder from an older build). A header changed on another device since stops the
 * rekey before anything local changed. Never written over a header this version cannot read.
 */
export async function commitRekeyedHeader(remote: VaultRemote, base: VaultHeader, header: VaultHeader, seen: VaultHeader | null, opts: WeakKdfOption = {}): Promise<void> {
  for (let attempt = 1; attempt <= MAX_HEADER_ATTEMPTS; attempt++) {
    const snap = await remote.read()
    if (snap.header !== null && remoteHeader(snap, opts).vaultId !== base.vaultId) throw new Error('The sync folder now holds a different encrypted vault')
    if (await casWriteHeader(remote, snap, snap.header === null ? null : (seen ?? base), header)) return
  }
  throw new Error('Another device keeps changing the vault; try again in a minute.')
}

/**
 * §15 N2: writes `build(base)` remotely by compare-and-swap over `seen` (the header this device last saw there; `local`
 * when none is recorded). `base` is `local`, or the seen header when it is a later one this MK verifies. A remote that
 * holds anything else (another device's password or key change, a replay, an older format) is never written over: the
 * user follows it first. Returns what was written.
 */
export async function updateRemoteHeader(
  remote: VaultRemote,
  local: VaultHeader,
  mk: KeyHandle,
  build: (base: VaultHeader) => VaultHeader | Promise<VaultHeader>,
  seen: VaultHeader | null,
  opts: WeakKdfOption = {},
): Promise<VaultHeader> {
  const expected = seen ?? local
  for (let attempt = 1; attempt <= MAX_HEADER_ATTEMPTS; attempt++) {
    const snap = await remote.read()
    let base = local
    if (snap.header !== null) {
      // Review C5 L5: a header this version cannot read is never overwritten.
      const theirs = remoteHeader(snap, opts)
      if (theirs.vaultId !== local.vaultId) throw new Error('The sync folder now holds a different encrypted vault')
      if (!sameHeader(snap.header, expected)) {
        // C9: a later header this MK does not verify is another device's key change: unlocking again follows it.
        if (theirs.revision > local.revision && !verifyCheck(theirs, mk) && !isDowngrade(theirs, floorOf(local))) throw new KeysChangedElsewhere()
        throw new RemoteChangedElsewhere()
      }
      if (theirs.revision > base.revision && verifyCheck(theirs, mk)) base = theirs
    }
    const next = await build(base)
    if (await casWriteHeader(remote, snap, snap.header === null ? null : expected, next)) return next
  }
  throw new Error('Another device keeps changing the vault; try again in a minute.')
}

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { markdownToBlocks, PageDoc, writeContent } from '@slate/core'
import { GraphHttp } from '@slate/importer'
import {
  GitDrive,
  nodeGitRunner,
  OneDriveClient,
  SyncEngine,
  tokenEnv,
  type ConflictRecord,
  type GitRunner,
  type LocalStore,
  type RemoteDrive,
  type SyncReport,
  type SyncStatus,
} from '@slate/sync'
import { noLog, type ScopedLog } from '../log/logger'
import type { DeviceCode, GitAuthInfo, GitAuthMode, GitCheck, GitSettings, Settings, SyncConfig, SyncState } from '../../shared/api'
import type { BlobStore } from '../blobs'
import { SIGN_IN_SCOPES, type AuthService, type SecretStorage } from '../onenote/auth'
import { readSettings, writeSettings } from '../settings'
import { DocStore } from '../store'
import { createPrivateRepo, ghToken, githubDeviceFlow, secretFile, testConnection, type SecretFile } from './git/auth'
import { docStoreLocal, scopedLocal } from './localStore'

const INTERVAL_MS = 30_000
const AFTER_EDIT_MS = 2_000

export interface SyncServiceDeps {
  dbFile: string
  blobs: BlobStore
  auth: AuthService
  graphUrl: string
  /** Holds the git clones and the encrypted git tokens. */
  gitDir: string
  secrets: SecretStorage
  /** The OAuth app for "Sign in with GitHub"; without one the device flow is not offered. */
  githubClientId?: string
  gitPath?: string
  /** Defaults to spawning `gh auth token`. */
  ghToken?: () => Promise<string>
  deviceName?: string
  /** Background sync period; 0 turns the timer off (tests drive `now()`). */
  intervalMs?: number
  emitStatus: (state: SyncState) => void
  emitNotice: (message: string) => void
  /** The diagnostic log, handed in so the sync package never imports main's logger. */
  log?: ScopedLog
}

/** Logs a git command that failed or timed out. Only the subcommand is named: the rest carries URLs. */
function loggedGit(run: GitRunner, log: ScopedLog): GitRunner {
  return async (args, opts) => {
    try {
      const result = await run(args, opts)
      if (result.code !== 0 || result.timedOut) {
        log.warn('git command failed', { command: args[0], code: result.code, timedOut: result.timedOut === true, stderr: result.stderr })
      }
      return result
    } catch (e) {
      log.error('git command could not run', { command: args[0], error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
}

interface Connection {
  key: string
  engine: SyncEngine
  drive: RemoteDrive
  local: LocalStore
}

const signedOut = (message: string) => Object.assign(new Error(message), { status: 401 })

/** The host a token's auth header is scoped to; SSH remotes never send it. */
function tokenHost(url: string): string {
  return /^https?:\/\//.test(url) ? `${new URL(url).origin}/` : 'https://github.com/'
}

/**
 * Sync for the app, to OneDrive or a git repository. Runs over its own database connection so that
 * what it pulls reaches the open window through the external-update watcher, like an agent's
 * writes. While sync is off or nobody is signed in, it makes no network call at all.
 */
export class SyncService {
  readonly deviceId: string
  private readonly store: DocStore
  private readonly deviceName: string
  private readonly baseLocal: LocalStore
  private readonly oneDrive: OneDriveClient
  private readonly git: GitRunner
  private readonly tokenSecret: SecretFile
  private readonly deviceSecret: SecretFile
  private current: Connection | undefined
  private deviceWait: Promise<GitCheck> | undefined
  private report: SyncReport = { status: 'disabled', pushed: 0, pulled: 0, conflicts: 0, at: 0 }
  private lastSyncedAt: number | undefined
  private running: Promise<SyncReport> | undefined
  private again = false
  private timer: ReturnType<typeof setInterval> | undefined
  private soon: ReturnType<typeof setTimeout> | undefined
  private closed = false

  private get log(): ScopedLog {
    return this.deps.log ?? noLog
  }

  constructor(private readonly deps: SyncServiceDeps) {
    this.store = new DocStore(deps.dbFile, { compact: false })
    this.deviceId = readSettings(this.store).deviceId ?? writeSettings(this.store, { deviceId: randomUUID() }).deviceId!
    const http = new GraphHttp({ baseUrl: deps.graphUrl, getToken: () => deps.auth.token(SIGN_IN_SCOPES) })
    this.oneDrive = new OneDriveClient(http)
    this.deviceName = deps.deviceName ?? hostname()
    this.baseLocal = docStoreLocal(this.store, deps.blobs, deps.emitNotice)
    this.git = loggedGit(nodeGitRunner(deps.gitPath), this.log)
    this.tokenSecret = secretFile(join(deps.gitDir, 'token.bin'), deps.secrets)
    this.deviceSecret = secretFile(join(deps.gitDir, 'github-device-token.bin'), deps.secrets)
  }

  private settings(): Settings {
    return readSettings(this.store)
  }

  /** The engine for the configured remote, rebuilt when the remote changes. */
  private connection(settings: Settings): Connection | undefined {
    const { syncProvider: provider, git } = settings
    if (!provider || (provider === 'git' && !git?.remoteUrl)) return undefined
    const key = provider === 'git' ? `git|${git!.remoteUrl}|${git!.branch}` : 'onedrive'
    if (this.current?.key === key) return this.current
    let drive: RemoteDrive = this.oneDrive
    // OneDrive's sync state predates providers, so it keeps the unprefixed keys.
    let local = this.baseLocal
    if (provider === 'git') {
      const { remoteUrl, branch } = git!
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
      drive = new GitDrive({
        run: this.git,
        dir: join(this.deps.gitDir, hash),
        remoteUrl,
        branch,
        authEnv: () => this.gitAuthEnv(this.settings().git ?? git!),
        author: { name: `Slate (${this.deviceName})`, email: `slate@${this.deviceId}.local` },
        deviceName: this.deviceName,
      })
      local = scopedLocal(this.baseLocal, `git:${remoteUrl}#${branch}:`)
    }
    const engine = new SyncEngine({ local, remote: drive, deviceId: this.deviceId, deviceName: this.deviceName, platform: platform() })
    this.current = { key, engine, drive, local }
    return this.current
  }

  private async token(mode: GitAuthMode): Promise<string | undefined> {
    if (mode === 'token') return this.tokenSecret.get()
    if (mode === 'device') return this.deviceSecret.get()
    if (mode === 'gh') return (this.deps.ghToken ?? ghToken)()
    return undefined
  }

  private async gitAuthEnv(git: GitSettings): Promise<Record<string, string>> {
    if (git.auth === 'system') return {}
    const token = await this.token(git.auth)
    if (!token) throw signedOut(git.auth === 'token' ? 'Add a personal access token in Sync settings' : 'Sign in with GitHub in Sync settings')
    return tokenEnv(token, tokenHost(git.remoteUrl))
  }

  /** Syncs now and then every interval. */
  start(): void {
    const interval = this.deps.intervalMs ?? INTERVAL_MS
    // A tick during a sync is skipped, not queued: a sync slower than the interval would
    // otherwise run back to back forever.
    if (interval > 0) this.timer = setInterval(() => this.running || void this.now(), interval)
    void this.now()
  }

  /** A local edit happened: sync shortly after, once edits pause. */
  edited(): void {
    if (this.soon) clearTimeout(this.soon)
    this.soon = setTimeout(() => {
      this.soon = undefined
      void this.now()
    }, AFTER_EDIT_MS)
  }

  async status(): Promise<SyncState> {
    const { syncProvider: provider, git } = this.settings()
    const auth = provider === 'onedrive' ? await this.deps.auth.status() : undefined
    return {
      ...this.report,
      enabled: provider !== null,
      provider,
      ...(auth?.account ? { account: auth.account } : {}),
      ...(provider === 'git' && git ? { remote: git.remoteUrl } : {}),
      ...(this.lastSyncedAt !== undefined ? { lastSyncedAt: this.lastSyncedAt } : {}),
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.configure({ provider: on ? 'onedrive' : null })
  }

  async configure(config: SyncConfig): Promise<void> {
    if (config.token && config.git?.auth === 'token') this.tokenSecret.set(config.token)
    writeSettings(this.store, { syncProvider: config.provider, ...(config.git ? { git: config.git } : {}) })
    this.lastSyncedAt = undefined
    if (config.provider === 'onedrive' && !(await this.deps.auth.status()).signedIn) await this.deps.auth.signIn()
    if (config.provider) await this.now()
    else await this.setReport(this.idle('disabled'))
  }

  async testGit(git: GitSettings, token?: string): Promise<GitCheck> {
    let env: Record<string, string>
    try {
      env = token ? tokenEnv(token, tokenHost(git.remoteUrl)) : await this.gitAuthEnv(git)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    return testConnection(this.git, git.remoteUrl, env)
  }

  gitAuthInfo(): GitAuthInfo {
    return { deviceFlow: Boolean(this.deps.githubClientId), hasToken: this.tokenSecret.get() !== undefined, hasDeviceToken: this.deviceSecret.get() !== undefined }
  }

  async createRepo(name: string, auth: GitAuthMode, token?: string): Promise<GitCheck> {
    let use = token
    try {
      use ??= await this.token(auth)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    if (!use) return { ok: false, message: 'Creating a repository needs a GitHub token: use the GitHub CLI, a token or Sign in with GitHub' }
    return createPrivateRepo(use, name)
  }

  /** Resolves with the code to show; the token is stored when the user approves it. */
  deviceSignIn(): Promise<DeviceCode> {
    const clientId = this.deps.githubClientId
    if (!clientId) return Promise.reject(new Error('Sign in with GitHub is not available in this build'))
    return new Promise((resolve, reject) => {
      this.deviceWait = githubDeviceFlow(clientId, resolve).then(
        (token): GitCheck => {
          this.deviceSecret.set(token)
          return { ok: true, message: 'Signed in to GitHub' }
        },
        (err: unknown): GitCheck => {
          reject(err)
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        },
      )
    })
  }

  deviceSignInWait(): Promise<GitCheck> {
    return this.deviceWait ?? Promise.resolve({ ok: false, message: 'Sign-in has not started' })
  }

  /** One sync at a time; asking during a sync runs exactly one more after it. */
  now(): Promise<SyncReport> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = undefined
      if (this.again && !this.closed) {
        this.again = false
        void this.now()
      }
    })
    return this.running
  }

  private idle(status: SyncStatus): SyncReport {
    return { status, pushed: 0, pulled: 0, conflicts: 0, at: Date.now() }
  }

  private async run(): Promise<SyncReport> {
    if (this.closed) return this.report
    const settings = this.settings()
    if (!settings.syncProvider) return this.setReport(this.idle('disabled'))
    if (settings.syncProvider === 'onedrive' && !(await this.deps.auth.status()).signedIn) return this.setReport(this.idle('signed-out'))
    const connection = this.connection(settings)
    if (!connection) return this.setReport({ ...this.idle('error'), message: 'Choose a repository in Sync settings' })
    await this.setReport({ ...this.report, status: 'syncing' })
    const started = Date.now()
    this.log.info('sync start', { provider: settings.syncProvider })
    let report: SyncReport
    try {
      report = await connection.engine.syncOnce()
    } catch (e) {
      this.log.error('sync threw', { provider: settings.syncProvider, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    const fields = { provider: settings.syncProvider, status: report.status, pushed: report.pushed, pulled: report.pulled, conflicts: report.conflicts, ms: Date.now() - started }
    if (report.status === 'error') this.log.error('sync end', { ...fields, message: report.message })
    else this.log.info('sync end', fields)
    if (report.status === 'idle-synced') this.lastSyncedAt = report.at
    return this.setReport(report)
  }

  private async setReport(report: SyncReport): Promise<SyncReport> {
    this.report = report
    if (!this.closed) this.deps.emitStatus(await this.status())
    return report
  }

  conflicts(pageId?: string): ConflictRecord[] {
    return this.store.listConflicts(pageId)
  }

  /**
   * 'mine' and 'theirs' rewrite the box as a new local edit, which the next sync pushes;
   * 'merged' keeps what the merge produced.
   */
  async resolve(id: string, choice: 'merged' | 'mine' | 'theirs'): Promise<void> {
    const conflict = this.store.listConflicts().find((c) => c.id === id)
    if (!conflict) return
    if (choice !== 'merged') {
      const page = PageDoc.fromUpdates(this.store.load(conflict.pageId))
      const root = page.contentMap(conflict.boxId)
      if (root) {
        const from = page.doc.oplogVersion()
        writeContent(root, markdownToBlocks(choice === 'mine' ? conflict.mine : conflict.theirs), page.doc)
        page.doc.commit()
        this.store.append(conflict.pageId, page.doc.export({ mode: 'update', from }))
        this.edited()
      }
    }
    this.store.removeConflict(id)
  }

  /** For the slate-blob protocol: fetches an image another device pushed. False when it cannot. */
  async ensureBlob(name: string): Promise<boolean> {
    if (this.deps.blobs.has(name)) return true
    const settings = this.settings()
    if (settings.syncProvider === 'onedrive' && !(await this.deps.auth.status()).signedIn) return false
    const connection = this.connection(settings)
    if (!connection) return false
    try {
      this.deps.blobs.write(name, await connection.drive.download(`blobs/${name}`))
      // Came from the drive, so there is nothing to push.
      await connection.local.markBlobSynced(name)
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.store.close()
  }
}

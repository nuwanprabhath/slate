import type { KeyHandle } from '@slate/native'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { markdownToBlocks, newId, NotebookDoc, PageDoc, writeContent } from '@slate/core'
import { GraphHttp } from '@slate/importer'
import {
  GitDrive,
  nodeGitRunner,
  OneDriveClient,
  SyncAborted,
  SyncEngine,
  tokenEnv,
  UnrelatedHistoryError,
  type ConflictRecord,
  type GitRunner,
  type LocalStore,
  type RemoteDrive,
  type SyncReport,
  type SyncStatus,
} from '@slate/sync'
import { noLog, type ScopedLog } from '../log/logger'
import type { DeviceCode, GitAuthInfo, GitAuthMode, GitCheck, GitSettings, Settings, SyncConfig, SyncState, VaultProblem } from '../../shared/api'
import type { BlobStore } from '../blobs'
import { SIGN_IN_SCOPES, type AuthService } from '../onenote/auth'
import { secretFile, type SecretFile, type SecretStorage } from '../secretStorage'
import { readSettings, writeSettings } from '../settings'
import { DocStore } from '../store'
import { createPrivateRepo, ghToken, githubDeviceFlow, testConnection } from './git/auth'
import type { KeyRing } from '../vault/keyring'
import { GitVaultRemote, OneDriveVaultRemote, type VaultRemote } from '../vault/remoteVault'
import { toHex, utf8, vaultNative } from '../vault/native'
import { VaultSyncProblem } from '../vault/vaultCheck'
import { SUITE } from '../vault/suite'
import { EncryptingDrive } from './encryptingDrive'
import { docStoreLocal, scopedLocal } from './localStore'
import { notebookFacts, ownCurrent, pickNotebook } from './openNotebook'

const INTERVAL_MS = 30_000
const AFTER_EDIT_MS = 2_000
/** Reopening the same notebook within this long is not recorded again, so browsing does not churn sync. */
const OPEN_RECORD_MS = 10 * 60_000

export interface SyncServiceDeps {
  dbFile: string
  /** The SQLCipher key of an encrypted database (§5.1); null or absent for a plaintext one. */
  /** A module key handle for the encrypted database (used to open the connection, not kept). */
  dbKey?: KeyHandle | null
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
  /** After the first sync, the notebook the window should show instead of an empty default. */
  emitOpenNotebook?: (notebookId: string) => void
  /** The diagnostic log, handed in so the sync package never imports main's logger. */
  log?: ScopedLog
  /** Set once the vault is unlocked: every remote file is then sealed by `EncryptingDrive`. */
  keyRing?: KeyRing
  /** §7.3: runs before any upload of each sync; a throw stops the run. */
  checkVault?: (remote: VaultRemote) => Promise<void>
  /** Written into this device's record on the remote. */
  appVersion?: string
  /**
   * C9: after every sync run, the rekey runner (`Migration.afterSync`): the re-push, the removal of the old trees,
   * the pruning of `history`. True asks for another run at once. A throw is logged and the run's report stands.
   */
  afterSync?: (outcome: {
    complete: boolean
    drive: EncryptingDrive | null
    localBlobs: () => Promise<string[]>
    forgetPushed: () => Promise<void>
    superseded: () => Promise<{ id: string; names: readonly string[] }>
    clearSuperseded: () => Promise<void>
    replaceable: boolean
  }) => Promise<boolean>
}

/** A device's record on the remote, as the engine writes it (`writeDevice`). */
export interface RemoteDeviceRecord {
  name: string
  appVersion?: string
  lastSeen?: number
  /** The key-epoch capability (C9); absent from builds that cannot follow a key change. */
  epochs?: number
}

/** The level of key-epoch support this build writes into its device record (D-7, review C9 L3). */
export const KEY_EPOCHS_CAPABILITY = 1

/** Review C9 M2: the files a conversion listed and pulled under the old keys (unscoped meta, kept by the rekeyed copy). */
const SUPERSEDED = 'c9:superseded'

const DEVICE_PATH = /^devices\/[0-9a-f-]{36}\.json$/

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
  vault: VaultRemote
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
  private readonly oneDriveVault: OneDriveVaultRemote
  private vaultProblem: VaultProblem | undefined
  private plaintextWarning = false
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
  private readonly abort = new AbortController()
  private paused = false
  private lastOpen: { id: string; at: number } | undefined
  private choseDuringSync = false

  private get log(): ScopedLog {
    return this.deps.log ?? noLog
  }

  private readonly deps: Omit<SyncServiceDeps, 'dbKey'>

  constructor(input: SyncServiceDeps) {
    // The key opens the connection and is not kept (§15 N9).
    const { dbKey, ...deps } = input
    this.deps = deps
    this.store = new DocStore(deps.dbFile, { compact: false, key: dbKey ?? null })
    this.deviceId = readSettings(this.store).deviceId ?? writeSettings(this.store, { deviceId: newId() }).deviceId!
    const http = new GraphHttp({ baseUrl: deps.graphUrl, getToken: () => deps.auth.token(SIGN_IN_SCOPES) })
    this.oneDrive = new OneDriveClient(http)
    this.oneDriveVault = new OneDriveVaultRemote(http)
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
    let vault: VaultRemote = this.oneDriveVault
    // OneDrive's sync state predates providers, so it keeps the unprefixed keys.
    let local = this.baseLocal
    if (provider === 'git') {
      const { remoteUrl, branch } = git!
      // A short, stable folder name for this remote: an identifier, not a secret.
      const hash = toHex(vaultNative().sha256(utf8(key))).slice(0, 16)
      vault = new GitVaultRemote({
        run: this.git,
        dir: join(this.deps.gitDir, `${hash}.vault`),
        remoteUrl,
        branch,
        authEnv: () => this.gitAuthEnv(this.settings().git ?? git!),
      })
      drive = new GitDrive({
        run: this.git,
        dir: join(this.deps.gitDir, hash),
        remoteUrl,
        branch,
        authEnv: () => this.gitAuthEnv(this.settings().git ?? git!),
        // Encrypted remotes name no host or device in their history (§5.4).
        ...(this.deps.keyRing
          ? { author: { name: 'Slate', email: 'slate@invalid' }, commitMessage: 'slate: sync' }
          : { author: { name: `Slate (${this.deviceName})`, email: `slate@${this.deviceId}.local` }, deviceName: this.deviceName }),
      })
      local = scopedLocal(this.baseLocal, `git:${remoteUrl}#${branch}:`)
    }
    if (provider === 'git') {
      const cloneDir = join(this.deps.gitDir, toHex(vaultNative().sha256(utf8(key))).slice(0, 16))
      drive = this.noticeUnrelated(drive, async () => {
        // C9 (R-2): another device replaced the branch's history with one commit of this same vault's files, so this
        // clone's history is the old one. The clone goes (what only it held is pushed again) and sync starts afresh.
        const schedule = this.deps.keyRing?.schedule
        const header = (await vault.read()).header as { vaultId?: unknown } | null
        if (!schedule || schedule.suite !== SUITE.KBKDF_AES256GCM || header?.vaultId !== schedule.vaultId) return false
        await this.current?.engine.forgetPushed()
        rmSync(cloneDir, { recursive: true, force: true })
        this.current = undefined
        this.again = true
        return true
      })
    }
    if (this.deps.keyRing) drive = new EncryptingDrive(drive, this.deps.keyRing)
    const check = this.deps.checkVault
    const engine = new SyncEngine({
      local,
      remote: drive,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      platform: platform(),
      ...(this.deps.appVersion ? { appVersion: this.deps.appVersion } : {}),
      // D-7 (review C9 L3): this build reads key epochs; a rekey waits for every device record to say so.
      capabilities: { epochs: KEY_EPOCHS_CAPABILITY },
      ...(check
        ? {
            beforeUpload: async () => {
              try {
                await check(vault)
              } catch (e) {
                if (e instanceof VaultSyncProblem) this.vaultProblem = e.problem
                throw e
              }
            },
          }
        : {}),
    })
    this.current = { key, engine, drive, local, vault }
    return this.current
  }

  /** A git remote that no longer shares our history becomes the vault state the renderer can act on. */
  private noticeUnrelated(drive: RemoteDrive, historyReplaced: () => Promise<boolean>): RemoteDrive {
    const watch = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work()
      } catch (e) {
        if (e instanceof UnrelatedHistoryError) {
          const replaced = e.encryptedRemote && this.deps.keyRing !== undefined && (await historyReplaced().catch(() => false))
          if (!replaced) this.vaultProblem = !e.encryptedRemote ? 'not-encrypted' : this.deps.keyRing ? 'other-vault' : 'join-needed'
        }
        throw e
      }
    }
    return {
      upload: (path, bytes) => drive.upload(path, bytes),
      download: (path) => drive.download(path),
      remove: (path) => drive.remove(path),
      delta: (cursor) => watch(() => drive.delta(cursor)),
      flush: () => watch(async () => drive.flush?.()),
    }
  }

  /**
   * C9 (D-7): every device record on the remote, read through the drive (sealed ones through `EncryptingDrive`).
   * Waits for a sync in flight; an unreadable record counts as a device of unknown version.
   */
  async deviceRecords(): Promise<RemoteDeviceRecord[]> {
    const connection = this.connection(this.settings())
    if (!connection) return []
    await this.running?.catch(() => {})
    const page = await connection.drive.delta(null)
    const out: RemoteDeviceRecord[] = []
    for (const item of page.items) {
      if (item.deleted || !DEVICE_PATH.test(item.path)) continue
      try {
        const r = JSON.parse(new TextDecoder().decode(await connection.drive.download(item.path))) as Partial<RemoteDeviceRecord>
        out.push({
          name: typeof r.name === 'string' ? r.name : 'A device',
          ...(typeof r.appVersion === 'string' ? { appVersion: r.appVersion } : {}),
          ...(typeof r.lastSeen === 'number' ? { lastSeen: r.lastSeen } : {}),
          ...(typeof r.epochs === 'number' ? { epochs: r.epochs } : {}),
        })
      } catch {
        out.push({ name: 'A device record Slate cannot read' })
      }
    }
    // Device records under keys this ring does not hold (no epoch it reads) are devices too, of unknown version.
    const unreadable = connection.drive instanceof EncryptingDrive ? connection.drive.unreadableDeviceRecords() : 0
    for (let i = 0; i < unreadable; i++) out.push({ name: 'A device record Slate cannot read' })
    return out
  }

  /**
   * Review C9 M2, before a conversion: lists this epoch's files from scratch, runs one complete sync (which pulls every
   * one of them it had not seen), and records those still readable as superseded. False when the sync did not complete.
   */
  async supersedeCurrent(id: string): Promise<boolean> {
    const connection = this.connection(this.settings())
    if (!connection || !(connection.drive instanceof EncryptingDrive)) return false
    const drive = connection.drive
    await this.running?.catch(() => {})
    const listed = await drive.currentFiles(await this.baseLocal.blobNames())
    if ((await this.now()).status !== 'idle-synced') return false
    const readable = await drive.currentFiles(await this.baseLocal.blobNames())
    await this.baseLocal.setMeta(SUPERSEDED, JSON.stringify({ id, names: [...listed].filter((r) => readable.has(r)) }))
    return true
  }

  /** Review C9 M5: this device has synced before: sync is configured, or the engine has a delta cursor. */
  async hasSyncedBefore(): Promise<boolean> {
    if (this.settings().syncProvider) return true
    return (await this.baseLocal.getMeta('deltaCursor')) !== undefined
  }

  /** Review C9 L4: the superseded list goes with a conversion that did not happen. */
  async clearSuperseded(): Promise<void> {
    await this.baseLocal.setMeta(SUPERSEDED, '{}')
  }

  /** The configured remote's vault header access, for the migration; null while sync is off. */
  vaultRemote(): VaultRemote | null {
    return this.connection(this.settings())?.vault ?? null
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
    if (interval > 0) this.timer = setInterval(() => {
      if (!this.running) void this.now()
    }, interval)
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
      ...(this.vaultProblem ? { vaultProblem: this.vaultProblem } : {}),
      ...(this.plaintextWarning ? { plaintextWarning: true } : {}),
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.configure({ provider: on ? 'onedrive' : null })
  }

  async configure(config: SyncConfig): Promise<void> {
    if (config.token && config.git?.auth === 'token') await this.tokenSecret.set(config.token)
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

  async gitAuthInfo(): Promise<GitAuthInfo> {
    return { deviceFlow: Boolean(this.deps.githubClientId), hasToken: (await this.tokenSecret.get()) !== undefined, hasDeviceToken: (await this.deviceSecret.get()) !== undefined }
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
        async (token): Promise<GitCheck> => {
          await this.deviceSecret.set(token)
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

  /** The window opened a notebook: recorded in the notebook doc so other devices can follow. */
  recordOpen(notebookId: string): void {
    const now = Date.now()
    // The window's first open at start-up is not a choice; moving from it is.
    if (this.running && this.lastOpen && this.lastOpen.id !== notebookId) this.choseDuringSync = true
    if (this.lastOpen?.id === notebookId && now - this.lastOpen.at < OPEN_RECORD_MS) return
    this.lastOpen = { id: notebookId, at: now }
    const docId = `notebook:${notebookId}`
    const nb = NotebookDoc.fromUpdates(this.store.load(docId))
    const from = nb.doc.oplogVersion()
    nb.markOpen(this.deviceId, now)
    this.store.append(docId, nb.doc.export({ mode: 'update', from }))
  }

  /** After the first pull from a remote, moves the window off an empty or unopened notebook. */
  private followOtherDevices(): void {
    const notebooks = notebookFacts(this.store)
    const pick = pickNotebook({ notebooks, deviceId: this.deviceId, current: ownCurrent(notebooks, this.deviceId), userChose: this.choseDuringSync })
    if (pick) this.deps.emitOpenNotebook?.(pick)
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

  /** Lets the run in flight finish and starts no other until `resume` (the remote claim, §7.2). */
  async pause(): Promise<void> {
    this.paused = true
    await this.running?.catch(() => {})
  }

  resume(): void {
    this.paused = false
  }

  private async run(): Promise<SyncReport> {
    if (this.closed || this.paused) return this.report
    const settings = this.settings()
    if (!settings.syncProvider) return this.setReport(this.idle('disabled'))
    if (settings.syncProvider === 'onedrive' && !(await this.deps.auth.status()).signedIn) return this.setReport(this.idle('signed-out'))
    const connection = this.connection(settings)
    if (!connection) return this.setReport({ ...this.idle('error'), message: 'Choose a repository in Sync settings' })
    await this.setReport({ ...this.report, status: 'syncing' })
    const started = Date.now()
    this.log.info('sync start', { provider: settings.syncProvider })
    // No delta cursor yet: nothing has ever been pulled from this remote.
    const first = (await connection.local.getMeta('deltaCursor')) === undefined
    this.choseDuringSync = false
    this.vaultProblem = undefined
    let report: SyncReport
    try {
      report = await connection.engine.syncOnce({ signal: this.abort.signal })
      if (connection.drive instanceof EncryptingDrive) this.plaintextWarning = connection.drive.plaintextItemsSeen > 0
    } catch (e) {
      if (e instanceof SyncAborted) {
        this.log.info('sync stopped', { provider: settings.syncProvider, ms: Date.now() - started })
        return this.report
      }
      this.log.error('sync threw', { provider: settings.syncProvider, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    const fields = { provider: settings.syncProvider, status: report.status, pushed: report.pushed, pulled: report.pulled, conflicts: report.conflicts, ms: Date.now() - started }
    if (report.status === 'error') this.log.error('sync end', { ...fields, message: report.message })
    else this.log.info('sync end', fields)
    if (report.status === 'idle-synced') this.lastSyncedAt = report.at
    if (report.status === 'idle-synced' && first && !this.closed) this.followOtherDevices()
    if (this.deps.afterSync && !this.closed) {
      try {
        const drive = connection.drive instanceof EncryptingDrive ? connection.drive : null
        const outcome = {
          complete: report.status === 'idle-synced',
          drive,
          localBlobs: () => this.baseLocal.blobNames(),
          forgetPushed: () => connection.engine.forgetPushed(),
          superseded: async () => {
            const v = JSON.parse((await this.baseLocal.getMeta(SUPERSEDED)) ?? '{}') as { id?: unknown; names?: unknown }
            return { id: typeof v.id === 'string' ? v.id : '', names: Array.isArray(v.names) ? v.names.filter((n): n is string => typeof n === 'string') : [] }
          },
          clearSuperseded: () => this.clearSuperseded(),
          replaceable: settings.syncProvider === 'git',
        }
        if (await this.deps.afterSync(outcome)) this.again = true
      } catch (e) {
        this.log.error('after-sync step failed', { error: e instanceof Error ? e.message : String(e) })
      }
    }
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

  /**
   * For the vault lock (§6.4): no new sync starts, and the one running is aborted at its next
   * transfer (a transfer in flight is abandoned) before the database closes.
   */
  async stop(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.abort.abort()
    await this.running?.catch(() => {})
    this.store.close()
  }
}

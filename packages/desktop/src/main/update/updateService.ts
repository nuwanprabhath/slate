import type { InstallKind, InstallOutcome, PrepareInstallResult, UpdateState } from '../../shared/api'
import type { SecretBytes } from '../../shared/secret'
import type { ScopedLog } from '../log/logger'
import { capabilityReason } from './capability'
import { CHANGED_SINCE_VERIFIED } from './installCommands'
import { installCommand, pickInstaller, type UpdateFile } from './pickInstaller'
import { UpdateSignatureError } from './signature'
import type { UpdateVerifier, VerifiedRelease } from './verifier'
import { isNewer, releaseUrl } from './versions'
import { securityEvent } from '../log/securityEvents'

export interface FoundUpdate {
  version: string
  files: UpdateFile[]
}

/** What the service needs from the outside world; electron-updater in the app, a stub in tests. */
export interface UpdateBackend {
  /** The latest release in the feed, whatever its version. */
  check(): Promise<FoundUpdate | null>
  /** Must refuse unless electron-updater's cached update is exactly `expected` (a later check replaces it). */
  downloadAuto(expected: VerifiedRelease, onProgress: (percent: number) => void): Promise<void>
  /** Same rule, right before quitAndInstall; throws instead of installing. */
  installAuto(expected: VerifiedRelease): void
  /** Downloads `file`, checks its sha512 and resolves to the local path. */
  downloadFile(file: UpdateFile, version: string, onProgress: (percent: number) => void): Promise<string>
  /** A file of the release (a feed or a `.sig`), or null when the release has none by that name. */
  fetchAsset(version: string, name: string): Promise<Uint8Array | null>
  openPath(path: string): Promise<void>
  showInFolder(path: string): void
  openExternal(url: string): void
  copy(text: string): void
  /** dmg, deb: whether installing the file at `path` needs the user's sudo password. Throws when this install cannot be replaced at all. */
  needsPassword(path: string): Promise<boolean>
  /** Whether the file at `path` still hashes to `sha512`, the one the signed feed names for it. */
  stillVerified(path: string, sha512: string): Promise<boolean>
  /**
   * Installs the verified file (deb), or hands it to the helper that installs it once Slate has quit
   * (dmg). The password is sudo's, as bytes: it goes to sudo's stdin and nowhere else.
   */
  installDownloaded(path: string, opts: { password: SecretBytes | null; version: string; sha512: string }): Promise<InstallOutcome>
  /** Quits (through the orderly shutdown); the installed version starts once this process has exited. */
  restart(): void
  /** What the macOS helper left from the last install, read once and deleted. */
  takePreviousInstall(): Promise<PreviousInstall | null>
}

/** What a helper that installed after quit (macOS) left for the next start to read. */
export interface PreviousInstall {
  version: string
  ok: boolean
  message: string
  /** The installer it kept, when it failed and the file is still there. */
  path: string | null
}

/** Kept in the settings store under `update`. */
export interface UpdatePrefs {
  skipped?: string
  dismissed?: string
  /** The last failure, kept quietly instead of shown. */
  lastError?: string
  lastCheckedAt?: number
}

export interface UpdateServiceDeps {
  backend: UpdateBackend
  /** Nothing is offered, downloaded or installed unless it passes (C12). */
  verifier: UpdateVerifier
  kind: InstallKind
  arch: string
  currentVersion: string
  loadPrefs(): UpdatePrefs
  savePrefs(prefs: UpdatePrefs): void
  log(message: unknown): void
  /** The diagnostic log. */
  diag?: ScopedLog
  emit(state: UpdateState): void
  /** Read at each use, so a change in Settings takes effect without a restart. */
  settings?(): UpdateSettings
  firstCheckMs?: number
}

export interface UpdateSettings {
  automaticChecks: boolean
  intervalHours: number
}

const FIRST_CHECK_MS = 10_000
const DEFAULT_SETTINGS: UpdateSettings = { automaticChecks: true, intervalHours: 6 }
const MIN_INTERVAL_HOURS = 1
const MAX_INTERVAL_HOURS = 24 * 7
const NOTHING_WAITING = 'There is no verified installer waiting to be installed.'

/** Never throws and never opens a dialog: failures go to the log and to `lastError`. */
export class UpdateService {
  private s: Omit<UpdateState, 'visible'>
  /** The release the latest check verified; null after any failed check, so nothing stale is downloaded or installed. */
  private found: VerifiedRelease | null = null
  /** A manual check shows the update even when it was skipped or dismissed. */
  private forced = false
  /** The installer a verified download left on disk, and the sha512 the signed feed names for it. */
  /** An Install and restart is already between its first click and its install or its password form. */
  private preparing = false
  private downloaded: { path: string; sha512: string; version: string } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false

  constructor(private readonly deps: UpdateServiceDeps) {
    this.s = { phase: 'idle', kind: deps.kind }
  }

  /** Arms the schedule to match the settings; with automatic checks off nothing is scheduled. */
  start(): void {
    this.started = true
    clearTimeout(this.timer)
    if (!this.settings().automaticChecks) return
    this.timer = setTimeout(() => void this.runScheduled(), this.deps.firstCheckMs ?? FIRST_CHECK_MS)
  }

  stop(): void {
    this.started = false
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Called when Settings change: re-arms the schedule, but only where updates were started (not in a dev run). */
  settingsChanged(): void {
    if (this.started) this.start()
  }

  private settings(): UpdateSettings {
    return this.deps.settings?.() ?? DEFAULT_SETTINGS
  }

  // Re-armed after each check rather than on an interval, so a slow check cannot queue up behind itself.
  private async runScheduled(): Promise<void> {
    await this.check()
    const { automaticChecks, intervalHours } = this.settings()
    if (!automaticChecks) return
    const hours = Math.min(Math.max(intervalHours, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS)
    this.timer = setTimeout(() => void this.runScheduled(), hours * 3600_000)
  }

  state(): UpdateState {
    const prefs = this.deps.loadPrefs()
    const { phase } = this.s
    const offered = phase === 'available' || phase === 'downloading' || phase === 'downloaded'
    // Someone pressing Install and restart has seen the banner, so a skip or a dismiss no longer hides it.
    const installing = phase === 'needs-password' || phase === 'installing' || phase === 'restarting'
    const hidden = !this.forced && (prefs.skipped === this.s.version || prefs.dismissed === this.s.version)
    return {
      ...this.s,
      visible: installing || (offered && !hidden),
      installable: this.installable() || undefined,
      currentVersion: this.deps.currentVersion,
      lastCheckedAt: prefs.lastCheckedAt,
      skippedVersion: prefs.skipped,
      reason: capabilityReason(this.deps.kind),
      error: this.s.phase === 'error' ? prefs.lastError : undefined,
    }
  }

  /** Resolves with the state the check ended in, so a manual check can report its own outcome. */
  async check(opts: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.s.phase === 'checking' || this.s.phase === 'downloading' || this.s.phase === 'needs-password' || this.s.phase === 'installing' || this.s.phase === 'restarting') return this.state()
    // A finished download stays put: checking again would only offer the same file.
    if (this.s.phase === 'downloaded' && !opts.manual) return this.state()
    if (opts.manual) this.forced = true
    this.set({ phase: 'checking', kind: this.deps.kind })
    this.deps.diag?.info('update check start', { manual: opts.manual === true, kind: this.deps.kind, current: this.deps.currentVersion })
    let offered: string | undefined
    const previous = this.found?.version
    // Whatever this check ends in, the previous verification no longer describes what electron-updater holds.
    this.found = null
    try {
      const found = await this.deps.backend.check()
      offered = found?.version
      // A download of another version is no longer what Install and restart would install.
      if (this.downloaded !== null && this.downloaded.version !== found?.version) this.downloaded = null
      this.savePrefs({ lastCheckedAt: Date.now(), lastError: undefined })
      this.deps.diag?.info('update check result', { latest: found?.version ?? null, newer: found ? isNewer(found.version, this.deps.currentVersion) : false })
      if (found && isNewer(found.version, this.deps.currentVersion)) {
        const verified = await this.deps.verifier.release(found)
        if (verified.version !== previous) this.forced = opts.manual === true
        this.found = verified
        this.set({ phase: 'available', kind: this.deps.kind, version: found.version, releaseUrl: releaseUrl(found.version) })
      } else {
        this.found = null
        this.set({ phase: 'idle', kind: this.deps.kind })
      }
    } catch (e) {
      this.found = null
      this.fail('update check failed', e, offered)
    }
    return this.state()
  }

  async download(): Promise<void> {
    await this.fetch({ forInstall: false })
  }

  /** `forInstall`: the download is for Install and restart, which installs the file itself, so nothing opens it. */
  private async fetch({ forInstall }: { forInstall: boolean }): Promise<void> {
    const found = this.found
    if (!found || this.s.phase !== 'available') return
    const { backend, kind } = this.deps
    const base = { kind, version: found.version, releaseUrl: releaseUrl(found.version) }
    if (kind === 'manual') {
      backend.openExternal(base.releaseUrl)
      return
    }
    const progress = (p: number) => this.set({ ...base, phase: 'downloading', progress: Math.round(p), installRequested: forInstall || undefined })
    progress(0)
    try {
      if (kind === 'auto') {
        // electron-updater picks the file itself, so every artefact of the release must verify.
        for (const f of found.files) await this.deps.verifier.artifact(found, f)
        await backend.downloadAuto(found, progress)
        this.set({ ...base, phase: 'downloaded' })
        return
      }
      const file = pickInstaller(found.files, kind, this.deps.arch)
      if (!file) throw new Error(`no ${kind} for ${this.deps.arch} in release ${found.version}`)
      await this.deps.verifier.artifact(found, file)
      const path = await backend.downloadFile(file, found.version, progress)
      this.downloaded = { path, sha512: file.sha512, version: found.version }
      this.set({ ...base, phase: 'downloaded', file: path, command: installCommand(kind, path) ?? undefined, installRequested: forInstall || undefined })
      if (kind === 'dmg' && !forInstall) await backend.openPath(path)
    } catch (e) {
      this.fail('update download failed', e)
    }
  }

  /** Whether Install and restart can run: a dmg or deb install, with a release to fetch or its verified download in hand. */
  private installable(): boolean {
    const { kind } = this.deps
    if (kind !== 'dmg' && kind !== 'deb') return false
    if (this.s.phase === 'available') return this.found !== null
    return this.s.phase === 'downloaded' && this.downloaded !== null && this.downloaded.version === this.s.version
  }

  /**
   * Install and restart, first half (dmg, deb): downloads and verifies the installer unless the
   * verified one is already on disk, then asks whether the install needs a password. If it does, the
   * state waits in `needs-password` for `installAndRestart`; if not, this installs and restarts at once.
   */
  async prepareInstall(): Promise<PrepareInstallResult> {
    // A second click while the first still downloads or asks sudo would start a second install.
    if (this.preparing || !this.installable()) return { needsPassword: false }
    this.preparing = true
    try {
      return await this.prepare()
    } finally {
      this.preparing = false
    }
  }

  private async prepare(): Promise<PrepareInstallResult> {
    if (this.s.phase === 'available') {
      await this.fetch({ forInstall: true })
    }
    const downloaded = this.downloaded
    if (downloaded === null) return { needsPassword: false }
    this.patch({ installRequested: true, installError: undefined })
    let needsPassword: boolean
    try {
      needsPassword = await this.deps.backend.needsPassword(downloaded.path)
    } catch (e) {
      this.patch({ installError: e instanceof Error ? e.message : String(e) })
      return { needsPassword: false }
    }
    if (needsPassword) {
      this.patch({ phase: 'needs-password' })
      return { needsPassword: true }
    }
    await this.runInstall(downloaded, null)
    return { needsPassword: false }
  }

  /** Install and restart, second half: only from `needs-password`, with the password the person typed. */
  async installAndRestart(password: SecretBytes | null): Promise<InstallOutcome> {
    const downloaded = this.downloaded
    if (this.s.phase !== 'needs-password' || downloaded === null) return { ok: false, reason: 'install', message: NOTHING_WAITING }
    return this.runInstall(downloaded, password)
  }

  private async runInstall(downloaded: { path: string; sha512: string; version: string }, password: SecretBytes | null): Promise<InstallOutcome> {
    const { backend, diag } = this.deps
    this.patch({ phase: 'installing', installError: undefined })
    let outcome: InstallOutcome
    try {
      outcome = await backend.stillVerified(downloaded.path, downloaded.sha512)
        ? await backend.installDownloaded(downloaded.path, { password, version: downloaded.version, sha512: downloaded.sha512 })
        : { ok: false, reason: 'install', message: CHANGED_SINCE_VERIFIED }
    } catch (e) {
      outcome = { ok: false, reason: 'install', message: e instanceof Error ? e.message : String(e) }
    }
    if (outcome.ok) {
      this.downloaded = null
      this.patch({ phase: 'restarting', file: undefined, command: undefined })
      backend.restart()
    } else if (outcome.reason === 'password') {
      this.patch({ phase: 'needs-password', installError: outcome.message })
    } else if (outcome.reason === 'password-required') {
      this.patch({ phase: 'needs-password', installError: undefined })
    } else if (outcome.message === CHANGED_SINCE_VERIFIED) {
      this.downloaded = null
      diag?.warn('update install refused: the download changed', { version: downloaded.version })
      this.patch({ phase: 'available', file: undefined, command: undefined, installError: outcome.message })
    } else {
      diag?.warn('update install failed', { version: downloaded.version, message: outcome.message })
      this.patch({ phase: 'downloaded', installError: outcome.message })
    }
    return outcome
  }

  /**
   * Called once at startup: when the macOS helper could not install the last update after quit, the
   * banner says so and offers the installer it kept. A success says nothing; the version is the proof.
   */
  async restorePreviousInstall(): Promise<void> {
    const previous = await this.deps.backend.takePreviousInstall()
    if (previous === null || previous.ok) return
    this.forced = true
    this.set({
      phase: 'downloaded',
      kind: this.deps.kind,
      version: previous.version,
      releaseUrl: releaseUrl(previous.version),
      file: previous.path ?? undefined,
      command: previous.path === null ? undefined : installCommand(this.deps.kind, previous.path) ?? undefined,
      installRequested: true,
      installError: previous.message,
    })
  }

  install(): void {
    const found = this.found
    if (this.s.phase !== 'downloaded' || this.deps.kind !== 'auto' || !found) return
    try {
      this.deps.backend.installAuto(found)
    } catch (e) {
      this.fail('update install failed', e)
    }
  }

  openInstaller(): void {
    if (this.s.file) void this.deps.backend.openPath(this.s.file).catch((e: unknown) => this.deps.log(e))
  }

  showInFolder(): void {
    if (this.s.file) this.deps.backend.showInFolder(this.s.file)
  }

  copyCommand(): void {
    if (this.s.command) this.deps.backend.copy(this.s.command)
  }

  copyReleaseUrl(): void {
    if (this.s.releaseUrl) this.deps.backend.copy(this.s.releaseUrl)
  }

  skip(): void {
    if (!this.s.version) return
    this.forced = false
    this.savePrefs({ skipped: this.s.version })
    this.emit()
  }

  unskip(): void {
    this.savePrefs({ skipped: undefined })
    this.emit()
  }

  dismiss(): void {
    // Cancel on the password form: the verified download stays, and Install and restart is offered again.
    if (this.s.phase === 'needs-password') {
      this.patch({ phase: 'downloaded', installRequested: undefined, installError: undefined })
      return
    }
    if (!this.s.version) return
    this.forced = false
    this.savePrefs({ dismissed: this.s.version })
    this.emit()
  }

  private fail(what: string, e: unknown, version = this.found?.version): void {
    const message = `${what}: ${e instanceof Error ? e.message : String(e)}`
    this.deps.log(message)
    const fields = { error: e instanceof Error ? e.message : String(e), version }
    if (e instanceof UpdateSignatureError && this.deps.diag) securityEvent.updateSignatureFailed({ version: fields.version }, this.deps.diag)
    this.deps.diag?.error(what, fields)
    this.savePrefs({ lastError: message })
    this.set({ phase: 'error', kind: this.deps.kind, version: this.found?.version, releaseUrl: this.s.releaseUrl })
  }

  private savePrefs(patch: Partial<UpdatePrefs>): void {
    const next: UpdatePrefs = { ...this.deps.loadPrefs(), ...patch }
    for (const k of Object.keys(next) as Array<keyof UpdatePrefs>) if (next[k] === undefined) delete next[k]
    this.deps.savePrefs(next)
  }

  private patch(changes: Partial<Omit<UpdateState, 'visible'>>): void {
    this.set({ ...this.s, ...changes })
  }

  private set(next: Omit<UpdateState, 'visible'>): void {
    this.s = next
    this.emit()
  }

  private emit(): void {
    this.deps.emit(this.state())
  }
}

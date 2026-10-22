import type { InstallKind, UpdateState } from '../../shared/api'
import { capabilityReason } from './capability'
import { installCommand, pickInstaller, type UpdateFile } from './pickInstaller'
import { isNewer, releaseUrl } from './versions'

export interface FoundUpdate {
  version: string
  files: UpdateFile[]
}

/** What the service needs from the outside world; electron-updater in the app, a stub in tests. */
export interface UpdateBackend {
  /** The latest release in the feed, whatever its version. */
  check(): Promise<FoundUpdate | null>
  downloadAuto(onProgress: (percent: number) => void): Promise<void>
  installAuto(): void
  /** Downloads `file`, checks its sha512 and resolves to the local path. */
  downloadFile(file: UpdateFile, version: string, onProgress: (percent: number) => void): Promise<string>
  openPath(path: string): Promise<void>
  showInFolder(path: string): void
  openExternal(url: string): void
  copy(text: string): void
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
  kind: InstallKind
  arch: string
  currentVersion: string
  loadPrefs(): UpdatePrefs
  savePrefs(prefs: UpdatePrefs): void
  log(message: unknown): void
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

/** Never throws and never opens a dialog: failures go to the log and to `lastError`. */
export class UpdateService {
  private s: Omit<UpdateState, 'visible'>
  private found: FoundUpdate | null = null
  /** A manual check shows the update even when it was skipped or dismissed. */
  private forced = false
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
    const shown = this.s.phase === 'available' || this.s.phase === 'downloading' || this.s.phase === 'downloaded'
    const hidden = !this.forced && (prefs.skipped === this.s.version || prefs.dismissed === this.s.version)
    return {
      ...this.s,
      visible: shown && !hidden,
      currentVersion: this.deps.currentVersion,
      lastCheckedAt: prefs.lastCheckedAt,
      skippedVersion: prefs.skipped,
      reason: capabilityReason(this.deps.kind),
      error: this.s.phase === 'error' ? prefs.lastError : undefined,
    }
  }

  /** Resolves with the state the check ended in, so a manual check can report its own outcome. */
  async check(opts: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.s.phase === 'checking' || this.s.phase === 'downloading') return this.state()
    // A finished download stays put: checking again would only offer the same file.
    if (this.s.phase === 'downloaded' && !opts.manual) return this.state()
    if (opts.manual) this.forced = true
    this.set({ phase: 'checking', kind: this.deps.kind })
    try {
      const found = await this.deps.backend.check()
      this.savePrefs({ lastCheckedAt: Date.now(), lastError: undefined })
      if (found && isNewer(found.version, this.deps.currentVersion)) {
        if (found.version !== this.found?.version) this.forced = opts.manual === true
        this.found = found
        this.set({ phase: 'available', kind: this.deps.kind, version: found.version, releaseUrl: releaseUrl(found.version) })
      } else {
        this.found = null
        this.set({ phase: 'idle', kind: this.deps.kind })
      }
    } catch (e) {
      this.fail('update check failed', e)
    }
    return this.state()
  }

  async download(): Promise<void> {
    const found = this.found
    if (!found || (this.s.phase !== 'available' && this.s.phase !== 'error')) return
    const { backend, kind } = this.deps
    const base = { kind, version: found.version, releaseUrl: releaseUrl(found.version) }
    if (kind === 'manual') {
      backend.openExternal(base.releaseUrl)
      return
    }
    const progress = (p: number) => this.set({ ...base, phase: 'downloading', progress: Math.round(p) })
    progress(0)
    try {
      if (kind === 'auto') {
        await backend.downloadAuto(progress)
        this.set({ ...base, phase: 'downloaded' })
        return
      }
      const file = pickInstaller(found.files, kind, this.deps.arch)
      if (!file) throw new Error(`no ${kind} for ${this.deps.arch} in release ${found.version}`)
      const path = await backend.downloadFile(file, found.version, progress)
      this.set({ ...base, phase: 'downloaded', file: path, command: installCommand(kind, path) ?? undefined })
      if (kind === 'dmg') await backend.openPath(path)
    } catch (e) {
      this.fail('update download failed', e)
    }
  }

  install(): void {
    if (this.s.phase === 'downloaded' && this.deps.kind === 'auto') this.deps.backend.installAuto()
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
    if (!this.s.version) return
    this.forced = false
    this.savePrefs({ dismissed: this.s.version })
    this.emit()
  }

  private fail(what: string, e: unknown): void {
    const message = `${what}: ${e instanceof Error ? e.message : String(e)}`
    this.deps.log(message)
    this.savePrefs({ lastError: message })
    this.set({ phase: 'error', kind: this.deps.kind, version: this.found?.version, releaseUrl: this.s.releaseUrl })
  }

  private savePrefs(patch: Partial<UpdatePrefs>): void {
    const next: UpdatePrefs = { ...this.deps.loadPrefs(), ...patch }
    for (const k of Object.keys(next) as Array<keyof UpdatePrefs>) if (next[k] === undefined) delete next[k]
    this.deps.savePrefs(next)
  }

  private set(next: Omit<UpdateState, 'visible'>): void {
    this.s = next
    this.emit()
  }

  private emit(): void {
    this.deps.emit(this.state())
  }
}

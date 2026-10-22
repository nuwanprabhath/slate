import type { InstallKind, UpdateState } from '../../shared/api'
import type { ScopedLog } from '../log/logger'
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
  /** The diagnostic log. */
  diag?: ScopedLog
  emit(state: UpdateState): void
  firstCheckMs?: number
  everyMs?: number
}

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 6 * 3600_000

/** Never throws and never opens a dialog: failures go to the log and to `lastError`. */
export class UpdateService {
  private s: Omit<UpdateState, 'visible'>
  private found: FoundUpdate | null = null
  /** A manual check shows the update even when it was skipped or dismissed. */
  private forced = false
  private first: ReturnType<typeof setTimeout> | undefined
  private every: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: UpdateServiceDeps) {
    this.s = { phase: 'idle', kind: deps.kind }
  }

  start(): void {
    this.first = setTimeout(() => {
      void this.check()
      this.every = setInterval(() => void this.check(), this.deps.everyMs ?? CHECK_EVERY_MS)
    }, this.deps.firstCheckMs ?? FIRST_CHECK_MS)
  }

  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.every)
  }

  state(): UpdateState {
    const prefs = this.deps.loadPrefs()
    const shown = this.s.phase === 'available' || this.s.phase === 'downloading' || this.s.phase === 'downloaded'
    const hidden = !this.forced && (prefs.skipped === this.s.version || prefs.dismissed === this.s.version)
    return { ...this.s, visible: shown && !hidden }
  }

  async check(opts: { manual?: boolean } = {}): Promise<void> {
    if (this.s.phase === 'checking' || this.s.phase === 'downloading') return
    // A finished download stays put: checking again would only offer the same file.
    if (this.s.phase === 'downloaded' && !opts.manual) return
    if (opts.manual) this.forced = true
    this.set({ phase: 'checking', kind: this.deps.kind })
    this.deps.diag?.info('update check start', { manual: opts.manual === true, kind: this.deps.kind, current: this.deps.currentVersion })
    try {
      const found = await this.deps.backend.check()
      this.savePrefs({ lastCheckedAt: Date.now(), lastError: undefined })
      this.deps.diag?.info('update check result', { latest: found?.version ?? null, newer: found ? isNewer(found.version, this.deps.currentVersion) : false })
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

  dismiss(): void {
    if (!this.s.version) return
    this.forced = false
    this.savePrefs({ dismissed: this.s.version })
    this.emit()
  }

  private fail(what: string, e: unknown): void {
    const message = `${what}: ${e instanceof Error ? e.message : String(e)}`
    this.deps.log(message)
    this.deps.diag?.error(what, { error: e instanceof Error ? e.message : String(e), version: this.found?.version })
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

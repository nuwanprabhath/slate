import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact, redactString } from '../../shared/redact'
import { filesToPrune, shouldRotate, type LogFile } from './rotation'

/**
 * The diagnostic log. Rules: `main/log/CLAUDE.md`.
 *
 * - **Off unless asked for.** Disabled means no directory, no file, and `log()` returns at once.
 * - **Redacted on the way in.** Fields go through `redact` before they are serialised.
 * - **Synchronous appends.** Volume is low (events only), and a buffered log loses the last line
 *   before a crash.
 * - **Never breaks the app.** Every entry point swallows its own errors.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogScope = 'app' | 'sync' | 'git' | 'update' | 'import' | 'watch' | 'ipc' | 'renderer'

export interface LoggerOptions {
  enabled: boolean
  /** Created only when logging is switched on. */
  dir: string
  maxSizeMb: number
  retentionDays?: number
  /** The running user's home, rewritten to `~` in every field. */
  home?: string
}

export type LogFields = Record<string, unknown>

const ACTIVE = 'slate.log'
const PREFIX = 'slate'
const SUFFIX = '.log'

export class Logger {
  private opts: LoggerOptions = { enabled: false, dir: '', maxSizeMb: 20 }
  /** Size of the active file as last known, so an append does not stat on every line. */
  private activeBytes = 0
  private ready = false

  configure(opts: LoggerOptions): void {
    this.opts = opts
    // Another process's rotation, or a folder emptied by hand, changes the size from outside.
    this.ready = false
    this.activeBytes = 0
    if (!opts.enabled) return
    try {
      this.prepare()
      this.prune()
    } catch {
      // A directory that cannot be made means no logging.
    }
  }

  get enabled(): boolean { return this.opts.enabled && this.opts.dir !== '' }

  get dir(): string { return this.opts.dir }

  get file(): string { return join(this.opts.dir, ACTIVE) }

  private get budgetBytes(): number { return Math.max(1, this.opts.maxSizeMb) * 1024 * 1024 }

  private prepare(): void {
    if (this.ready) return
    mkdirSync(this.opts.dir, { recursive: true })
    this.activeBytes = this.sizeOf(ACTIVE)
    this.ready = true
  }

  private sizeOf(name: string): number {
    try { return statSync(join(this.opts.dir, name)).size } catch { return 0 }
  }

  private listFiles(): LogFile[] {
    try {
      return readdirSync(this.opts.dir)
        .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
        .map((name) => {
          const s = statSync(join(this.opts.dir, name))
          return { name, bytes: s.size, modifiedMs: s.mtimeMs }
        })
    } catch {
      return []
    }
  }

  private prune(): void {
    const doomed = filesToPrune(this.listFiles(), {
      now: Date.now(),
      retentionDays: this.opts.retentionDays ?? 7,
      budgetBytes: this.budgetBytes,
      activeName: ACTIVE,
    })
    for (const name of doomed) {
      try { rmSync(join(this.opts.dir, name), { force: true }) } catch { /* it can go next time */ }
    }
  }

  /** Rolls the active file aside under a sortable, timestamped name. */
  private rotate(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      renameSync(this.file, join(this.opts.dir, `${PREFIX}-${stamp}${SUFFIX}`))
      this.activeBytes = 0
      this.prune()
    } catch {
      // A failed rename leaves the active file growing; the size budget still removes older files.
    }
  }

  log(level: LogLevel, scope: LogScope, message: string, fields: LogFields = {}): void {
    if (!this.enabled) return
    try {
      this.prepare()
      const home = this.opts.home
      const body = redact(fields, { home }) as LogFields
      const tail = Object.keys(body).length > 0 ? ` ${JSON.stringify(body)}` : ''
      const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${redactString(message, { home }).replace(/\s*\n\s*/g, ' ')}${tail}\n`
      const bytes = Buffer.byteLength(line)
      if (shouldRotate(this.activeBytes, bytes, this.budgetBytes)) this.rotate()
      appendFileSync(this.file, line)
      this.activeBytes += bytes
    } catch {
      // Logging must never break the app.
    }
  }

  debug(scope: LogScope, message: string, fields?: LogFields): void { this.log('debug', scope, message, fields) }
  info(scope: LogScope, message: string, fields?: LogFields): void { this.log('info', scope, message, fields) }
  warn(scope: LogScope, message: string, fields?: LogFields): void { this.log('warn', scope, message, fields) }
  error(scope: LogScope, message: string, fields?: LogFields): void { this.log('error', scope, message, fields) }

  /** All log files, oldest first. Every line was redacted when written. */
  read(): string {
    try {
      const names = this.listFiles().map((f) => f.name).filter((n) => n !== ACTIVE).sort()
      return [...names, ACTIVE].map((n) => {
        try { return readFileSync(join(this.opts.dir, n), 'utf8') } catch { return '' }
      }).join('')
    } catch {
      return ''
    }
  }

  clear(): void {
    for (const file of this.listFiles()) {
      try { rmSync(join(this.opts.dir, file.name), { force: true }) } catch { /* it can go next time */ }
    }
    this.activeBytes = 0
  }
}

/** The app's logger: inert until startup calls `configure`, so a test that never does writes no files. */
export const log = new Logger()

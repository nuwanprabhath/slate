import type { ImportProgress, OneNoteNotebook } from '@slate/importer'
import type { ConflictRecord, SyncReport } from '@slate/sync'

export interface Settings {
  /** When true, typing "1. ", "- ", "# " or "```" turns into lists/headings/code. Off by default. */
  markdownShortcuts: boolean
  /** Application (client) id of the user's Azure app registration, for OneNote import. */
  msClientId: string | null
  /** Where notebooks sync to; null (the default) is off, and sync then never touches the network. */
  syncProvider: SyncProvider | null
  /** The repository for the git provider. */
  git: GitSettings | null
  /** This install's id in the sync folder, created once. */
  deviceId: string | null
  /** Writes a redacted diagnostic log to the user-data folder. Off by default; off writes nothing. */
  debugLog: boolean
}

export type SyncProvider = 'onedrive' | 'git'

/**
 * `system`: the machine's SSH keys or credential helper. `token`: a personal access token.
 * `gh`: the GitHub CLI's token, read at each sync. `device`: signed in through GitHub's device flow.
 */
export type GitAuthMode = 'system' | 'token' | 'gh' | 'device'

export interface GitSettings {
  remoteUrl: string
  branch: string
  auth: GitAuthMode
}

export const DEFAULT_SETTINGS: Settings = { markdownShortcuts: false, msClientId: null, syncProvider: null, git: null, deviceId: null, debugLog: false }

export interface DiagnosticsStatus {
  enabled: boolean
  /** The log file, whether or not it exists yet. */
  file: string
  /** Size of the log files on disk, in bytes. */
  bytes: number
}

/** An error in the renderer, reduced to what is safe to log: no message, only the stack's frames. */
export interface RendererErrorReport {
  kind: 'error' | 'unhandledrejection'
  name: string
  frames: string[]
}

/** What the sync settings overlay saves. A token is stored encrypted, never in the settings. */
export interface SyncConfig {
  provider: SyncProvider | null
  git?: GitSettings
  token?: string
}

export interface GitAuthInfo {
  /** Sign in with GitHub is offered only when the build has an OAuth app (SLATE_GITHUB_CLIENT_ID). */
  deviceFlow: boolean
  hasToken: boolean
  hasDeviceToken: boolean
}

export interface GitCheck {
  ok: boolean
  message: string
  /** The new repository's URL, from createRepo. */
  url?: string
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
}

export interface SyncState extends SyncReport {
  enabled: boolean
  provider: SyncProvider | null
  /** The git repository URL, when syncing to git. */
  remote?: string
  account?: string
  /** When the last sync that reached the drive finished. */
  lastSyncedAt?: number
}

/**
 * How this installation takes an update. `auto`: electron-updater installs it (AppImage).
 * `dmg`: an unsigned mac build downloads the dmg and opens it. `deb`: downloads the .deb and offers
 * the apt command. `manual`: only the release page (dev runs, other platforms).
 */
export type InstallKind = 'auto' | 'dmg' | 'deb' | 'manual'

export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  kind: InstallKind
  version?: string
  releaseUrl?: string
  /** 0–100 while downloading. */
  progress?: number
  /** The downloaded installer. */
  file?: string
  /** The shell command that installs `file`, for dmg and deb. */
  command?: string
  /** Whether the banner shows: an update is available or downloaded, and not skipped or dismissed. */
  visible: boolean
}

export interface AuditEntryRow {
  id: number
  ts: number
  tool: string
  target: string
  outcome: string
}

export type MenuCommand =
  | { cmd: 'undo' }
  | { cmd: 'redo' }
  | { cmd: 'paste-plain' }
  | { cmd: 'settings-changed'; settings: Settings }
  | { cmd: 'show-ai-activity' }
  | { cmd: 'show-import' }
  | { cmd: 'show-import-backup' }
  | { cmd: 'show-connect-agents' }
  | { cmd: 'find' }

export interface SlateApi {
  isE2E: boolean
  docs: {
    list(prefix: string): Promise<string[]>
    load(docId: string): Promise<Uint8Array[]>
    append(docId: string, update: Uint8Array): Promise<void>
    remove(docId: string): Promise<void>
  }
  blobs: {
    put(bytes: Uint8Array, mime: string): Promise<string>
    copyImage(url: string): Promise<boolean>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  audit: { list(limit?: number): Promise<AuditEntryRow[]> }
  diagnostics: {
    status(): Promise<DiagnosticsStatus>
    /** The redacted log text, oldest line first. */
    read(): Promise<string>
    /** Puts the redacted log on the clipboard; resolves to its length in characters. */
    copy(): Promise<number>
    clear(): Promise<void>
    openFolder(): Promise<void>
    /** Forwards a renderer error to the log. */
    rendererError(report: RendererErrorReport): Promise<void>
  }
  mcp: { launcherInfo(): Promise<{ command: string; claudeCommand: string; packaged: boolean }> }
  clipboardText(): Promise<string>
  onenote: {
    status(): Promise<OneNoteStatus>
    signIn(): Promise<void>
    signOut(): Promise<void>
    tree(): Promise<OneNoteNotebook[]>
    start(ids: string[]): Promise<ImportProgress>
    retryFailed(): Promise<ImportProgress>
    cancel(): Promise<void>
    /** Asks for backup files or folders (a native dialog) and lists their sections; null when cancelled. */
    pickBackup(): Promise<BackupPick | null>
    startBackup(paths: string[], sectionIds: string[]): Promise<ImportProgress>
    onProgress(handler: (p: ImportProgress) => void): () => void
    setClientId(id: string): Promise<void>
  }
  sync: {
    status(): Promise<SyncState>
    /** OneDrive on, or sync off. */
    setEnabled(on: boolean): Promise<void>
    configure(config: SyncConfig): Promise<void>
    testGit(git: GitSettings, token?: string): Promise<GitCheck>
    gitAuthInfo(): Promise<GitAuthInfo>
    createRepo(name: string, auth: GitAuthMode, token?: string): Promise<GitCheck>
    /** Starts GitHub's device flow; `deviceSignInWait` resolves once the user approved it. */
    deviceSignIn(): Promise<DeviceCode>
    deviceSignInWait(): Promise<GitCheck>
    now(): Promise<SyncReport>
    conflicts(pageId?: string): Promise<ConflictRecord[]>
    resolve(id: string, choice: 'merged' | 'mine' | 'theirs'): Promise<void>
    onStatus(handler: (state: SyncState) => void): () => void
    onNotice(handler: (message: string) => void): () => void
  }
  update: {
    state(): Promise<UpdateState>
    check(): Promise<void>
    download(): Promise<void>
    install(): Promise<void>
    openInstaller(): Promise<void>
    showInFolder(): Promise<void>
    copyCommand(): Promise<void>
    copyReleaseUrl(): Promise<void>
    skip(): Promise<void>
    dismiss(): Promise<void>
    onState(handler: (state: UpdateState) => void): () => void
  }
  onMenu(handler: (command: MenuCommand) => void): () => void
  /** Updates another process (an agent via slate-mcp) wrote to the database. */
  onExternalUpdates(handler: (batches: ExternalBatch[]) => void): () => void
}

export interface BackupPick {
  paths: string[]
  /** `date` is the backup date from the file name (ISO), or '' when it has none. */
  sections: Array<{ id: string; name: string; date: string; notebook: string }>
}

export interface OneNoteStatus {
  configured: boolean
  signedIn: boolean
  account?: string
}

export interface ExternalBatch {
  docId: string
  updates: Uint8Array[]
}

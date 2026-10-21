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

export const DEFAULT_SETTINGS: Settings = { markdownShortcuts: false, msClientId: null, syncProvider: null, git: null, deviceId: null }

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
  | { cmd: 'show-connect-agents' }

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
  onMenu(handler: (command: MenuCommand) => void): () => void
  /** Updates another process (an agent via slate-mcp) wrote to the database. */
  onExternalUpdates(handler: (batches: ExternalBatch[]) => void): () => void
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

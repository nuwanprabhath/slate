import type { ImportProgress, OneNoteNotebook } from '@slate/importer'
import type { ConflictRecord, SyncReport } from '@slate/sync'

export interface Settings {
  /** When true, typing "1. ", "- ", "# " or "```" turns into lists/headings/code. Off by default. */
  markdownShortcuts: boolean
  /** Application (client) id of the user's Azure app registration, for OneNote import. */
  msClientId: string | null
  /** OneDrive sync. Off by default; while off, sync never touches the network. */
  syncEnabled: boolean
  /** This install's id in the sync folder, created once. */
  deviceId: string | null
}

export const DEFAULT_SETTINGS: Settings = { markdownShortcuts: false, msClientId: null, syncEnabled: false, deviceId: null }

export interface SyncState extends SyncReport {
  enabled: boolean
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
  | { cmd: 'show-import-backup' }
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
    /** Asks for backup files or folders (a native dialog) and lists their sections; null when cancelled. */
    pickBackup(): Promise<BackupPick | null>
    startBackup(paths: string[], sectionIds: string[]): Promise<ImportProgress>
    onProgress(handler: (p: ImportProgress) => void): () => void
    setClientId(id: string): Promise<void>
  }
  sync: {
    status(): Promise<SyncState>
    setEnabled(on: boolean): Promise<void>
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

import type { ImportProgress, OneNoteNotebook } from '@slate/importer'
import type { ConflictRecord, SyncReport } from '@slate/sync'
import type { FontOverride } from './theme/fonts'
import type { MotionSetting } from './theme/motion'
import type { SavedTheme, ThemeGenerateResult } from './theme/resolve'
import type { ThemeSpec } from './theme/spec'
import type { AppMenuNode, ChromeColors, WindowChrome } from './windowChrome/chrome'
import type { SecretBytes } from './secret'

/** Themes: the user's saved ones live in main, validated on load and save (main/theme/themeStore.ts). */
export interface ThemesApi {
  /** Read synchronously at preload, so the first paint already has the theme. */
  initial: {
    settings: Pick<Settings, 'themeId' | 'followSystem' | 'motion' | 'fontOverrides'>
    saved: SavedTheme[]
    safeMode: boolean
    gpuCompositing: boolean
    systemDark: boolean
  }
  list(): Promise<SavedTheme[]>
  save(spec: unknown, prompt?: string | null): Promise<SavedTheme>
  rename(id: string, name: string): Promise<SavedTheme>
  remove(id: string): Promise<void>
  onChange(handler: (saved: SavedTheme[]) => void): () => void
  /** Whether the user's `claude` CLI was found on the login shell's PATH. */
  claudeAvailable(): Promise<boolean>
  generate(request: string, current: ThemeSpec | null): Promise<ThemeGenerateResult>
  cancelGenerate(): Promise<void>
}

export interface Settings {
  /** When true, typing "1. ", "- ", "# " or "```" turns into lists/headings/code. Off by default. */
  markdownShortcuts: boolean
  /** Typing `* ` at the start of a line starts a bulleted list. On by default. */
  autoBullets: boolean
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
  /** Whether Slate asks GitHub for a newer release on its own; a manual check always works. */
  updateAutomaticChecks: boolean
  /** Hours between automatic checks. */
  updateCheckIntervalHours: number
  /** Activity-bar plugins' own settings, keyed `plugins.<pluginId>.<key>`. */
  plugins: Record<string, unknown>
  /** The active theme: a `builtin:*` id or a saved theme's id (`themes`). */
  themeId: string
  /** Animations: `auto` follows the OS reduced-motion setting and the GPU. */
  motion: MotionSetting
  /** Light or Dark by the OS, whatever `themeId` says. */
  followSystem: boolean
  /** The OS title bar instead of Slate's themed one. Read when a window opens, so it needs a restart. */
  systemTitleBar: boolean
  /** POAM-16: the user dismissed Settings → Security's no-sandbox notice. */
  sandboxNoticeDismissed: boolean
  /** Note and UI fonts the user picked, per theme id; a theme without an entry uses its own. */
  fontOverrides: Record<string, FontOverride>
  /** Encrypted vaults lock after this many minutes without Slate input; 0 = never. */
  idleMinutes: number
  lockOnSleep: boolean
  lockOnScreenLock: boolean
  quickUnlock: boolean
}

/** §6.2. `migrating`: a vault header exists but the plaintext database is still the one in use. */
/**
 * `selftest` while the power-up self-test runs (no window shows it), `selftest-failed` after a failed one:
 * terminal, the error screen is all there is (audit §4.2).
 */
export type VaultState = 'selftest' | 'selftest-failed' | 'plaintext' | 'locked' | 'unlocking' | 'unlocked' | 'locking' | 'migrating'

export interface VaultStatus {
  state: VaultState
  /** False when Linux has no `gdbus`, so only idle and sleep lock Slate. */
  screenLockDetected: boolean
  /** Set once after an unlock that adopted a header changed on another device. */
  passwordChangedElsewhere: boolean
  /** Set once after an unlock that found preunlock.json edited while locked. */
  preunlockTampered: boolean
  /** How the lock screen offers quick unlock (§8): only when it is set up and the OS can do it now. */
  quickUnlock: QuickUnlockKind | null
  /** The vault's crypto profile as vault.json names it (audit §4.1; header v1 is `standard`); null without a vault. */
  profile: VaultProfile | null
  /** The last power-up or on-demand self-test (audit §4.2): its failed check ids, first is the reason shown. */
  selfTest: SelfTestSummary
  /** POAM-16: a renderer runs without Chromium's sandbox (--no-sandbox, or Linux seccomp off: the AppImage). */
  rendererUnsandboxed: boolean
}

/** A self-test run as Settings and the error screen show it. */
export interface SelfTestSummary {
  passed: boolean
  /** In run order; empty when it passed. */
  failed: string[]
  /** How long the run took, in ms; null before the first run finished. */
  ms: number | null
}

/** `standard` (BSI-aligned, Argon2id) or `fips-140-3` (NIST SP 800-132 PBKDF2, the FIPS module required). */
export type VaultProfile = 'standard' | 'fips-140-3'

/** C9 (audit §4.7): a key rotation (R-1), the header-v1 to v2 upgrade (R-5), or the conversion to fips-140-3 (R-3). */
export type RekeyKind = 'rotate' | 'upgrade' | 'convert'

/** C9: Settings → Security's key section. */
export interface VaultKeysInfo {
  headerVersion: 1 | 2
  profile: VaultProfile
  keyEpoch: number
  /** When the current master key was made. */
  createdAt: number
  /** R-4 (fips-140-3): when the keys fell due for rotation, or null. */
  rotationDueSince: number | null
  /** A key change still being synced: its re-push, the removal of the old files, or the pruning of the key history. */
  inProgress: 'repush' | 'sweep' | 'prune' | null
  /** D-7: devices on the remote that must update Slate before any key change. */
  blockingDevices: Array<{ name: string; appVersion?: string }>
  /** Why the device list could not be read (offline, signed out); key changes wait for it. */
  devicesUnknown?: string
  canRotate: boolean
  canUpgrade: boolean
  canConvert: boolean
  /** R-2 (git): the sync branch's history still holds files sealed under earlier keys. */
  canReplaceHistory: boolean
}

export type QuickUnlockKind = 'touchid' | 'keyring'

/** Settings → Security: the cryptographic module @slate/native found at launch (audit C2, F-FIPS-08). */
export interface CryptoModuleStatus {
  /** False when slate_native.node is missing from this build (development checkouts without OpenSSL). */
  available: boolean
  /** Why the module is unavailable or failed its start-up checks (a POST code); null when healthy. */
  problem: string | null
  module: string
  version: string
  cmvp: number
  standard: string
  certificateUrl: string
  /** The FIPS provider is loaded, passed its self-tests, and `fips=yes` is the default property query. */
  approvedMode: boolean
  errorState: boolean
  /** How long loading, the provider's self-tests and the round trip took, in ms. */
  postMs: number | null
  libcrypto: string | null
  /** False when the secure heap could not be locked into memory. */
  secureHeapLocked: boolean | null
  /** A checkout build, which may run without the provider (no FIPS claim). Packaged builds never do. */
  development: boolean
}

export interface QuickUnlockInfo {
  /** Null when this computer cannot (no Touch ID, or Linux without a real keyring). */
  kind: QuickUnlockKind | null
  enabled: boolean
  /** Set once after a password unlock that followed a failed quick unlock: offer to set it up again. */
  offerReenable: boolean
}

/** Unlock never says why it failed beyond this (§4: same message as a wrong password). */
export type UnlockResult = { ok: true } | { ok: false; message: string; /** Failed attempts in a row; at 5 the lock screen offers the recovery key. */ failures?: number }

/** Z-5 (C7): a typed secret crosses IPC as bytes (`SecretBytes`, shared/secret.ts), never as a string. */
export type VaultSecret = { password: SecretBytes } | { recoveryKey: SecretBytes }
export interface PasswordCheck {
  ok: boolean
  reason?: string
  strength: 0 | 1 | 2 | 3 | 4
}
export type PrepareEncryption = { kind: 'recovery'; recoveryKey: string } | { kind: 'join' }
/** The migration's phases in order (main/vault/migration.ts `MIGRATION_PHASES`). */
export interface EncryptProgress {
  phase: 'remote' | 'claim' | 'close' | 'copy' | 'bookkeeping' | 'switch' | 'cleanup' | 'open'
}

export interface VaultApi {
  status(): Promise<VaultStatus>
  unlock(password: SecretBytes): Promise<UnlockResult>
  unlockRecovery(recoveryKey: SecretBytes): Promise<UnlockResult>
  /** Touch ID / keyring (§8). Any failure reads "Touch ID unavailable — enter your password". */
  quickUnlock(): Promise<UnlockResult>
  quickUnlockInfo(): Promise<QuickUnlockInfo>
  /** Needs the password once; `ok: false` carries the reason to show. */
  enableQuickUnlock(password: SecretBytes): Promise<UnlockResult>
  /** "Forget quick unlock": deletes the sealed key from this computer. */
  disableQuickUnlock(): Promise<void>
  /** §15 N10: re-asks the password and resumes a migration that stopped before the switch. */
  finishMigration(password: SecretBytes): Promise<UnlockResult>
  cancelMigration(): Promise<void>
  /**
   * The strength hint for a new password under `profile` (the vault's, when omitted); `ok` false says why it is
   * refused. Main decodes it to text for the policy check (C7 criterion 5).
   */
  checkPassword(password: SecretBytes, profile?: VaultProfile): Promise<PasswordCheck>
  /**
   * Wizard: checks the remote, then makes the vault in memory and returns its recovery key. `fips-140-3` is
   * accepted only when the module runs in approved mode (`moduleStatus().approvedMode`).
   */
  prepareEncryption(password: SecretBytes, profile?: VaultProfile): Promise<PrepareEncryption>
  /** Wizard: a real unlock round trip with the recovery key the user typed back. */
  confirmRecovery(recoveryKey: SecretBytes): Promise<boolean>
  /**
   * Save dialog for the recovery key (defaults to Documents, refuses the data folder). Text, not bytes: the key was
   * just made and is on screen, so this adds no copy that `prepareEncryption`/`newRecoveryKey` did not (Z-11 residual).
   */
  saveRecoveryKey(recoveryKey: string): Promise<{ saved: boolean; message?: string }>
  /** Claims the remote (if syncing) and migrates; `join` means another device's vault is there. */
  encrypt(): Promise<{ kind: 'done' } | { kind: 'join' }>
  /** Forgets a prepared, unconfirmed vault. */
  discardEncryption(): Promise<void>
  /** §7.3 / §7.5: adopts the remote's vault with its password or recovery key. */
  join(secret: VaultSecret): Promise<UnlockResult>
  /** §7.3 last bullet: wipes a plaintext remote and encrypts it with this vault. */
  encryptRemote(): Promise<UnlockResult>
  changePassword(current: VaultSecret, next: SecretBytes): Promise<UnlockResult>
  newRecoveryKey(password: SecretBytes): Promise<{ ok: true; recoveryKey: string } | { ok: false; message: string }>
  onProgress(handler: (progress: EncryptProgress) => void): () => void
  /** The cryptographic module's state, measured once at launch. */
  moduleStatus(): Promise<CryptoModuleStatus>
  /**
   * Settings → Security → Run self-tests (audit S-7 a): the whole power-up self-test again. A failure stops
   * Slate at once (every window replaced by the error screen), so the caller sees `passed: false` only if its
   * window is still there.
   */
  selfTest(): Promise<SelfTestSummary>
  /** C9: the vault's key epoch and format, and which key changes it can take now. */
  keysInfo(): Promise<VaultKeysInfo>
  /**
   * C9 R-1/R-3/R-5, the first half: after the self-test, makes the new header in memory and returns its new recovery
   * key, shown once and typed back with `confirmRecovery`. `password` is the current one; `newPassword` (convert
   * only) the fips-140-3 vault's.
   */
  prepareRekey(kind: RekeyKind, password: SecretBytes, newPassword?: SecretBytes): Promise<{ ok: true; recoveryKey: string } | { ok: false; message: string }>
  /** C9: applies the prepared change: notes re-encrypted under new keys, the remote header replaced. */
  runRekey(): Promise<UnlockResult>
  /** C9 R-2 (git): the sync branch becomes one commit of its current, re-encrypted files. */
  replaceSyncHistory(): Promise<UnlockResult>
  /** Throttled pointer/wheel activity, for the idle lock. */
  activity(): void
  /** Mod+Shift+L as the page saw it (the main process also watches real key input). */
  lock(): void
  /** The renderer copied or cut something, so a lock may clear it. */
  copied(): void
  /** The lock sequence asks the window to write pending edits before the keys go. */
  onFlush(handler: () => Promise<void>): () => void
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

export { DEFAULT_SETTINGS } from './settings/schema'

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
  /** The last run stopped at the vault check (§7.3) and uploaded nothing. */
  vaultProblem?: VaultProblem
  /** §7.6: an older Slate is writing unencrypted files to this encrypted remote. */
  plaintextWarning?: boolean
}

/**
 * `join-needed`: a plaintext device found an encrypted remote. `other-vault`: the remote holds a
 * different vault. `not-encrypted`: an encrypted device found a plaintext, non-empty remote.
 */
/** `keys-changed` (C9): another device rotated, upgraded or converted this vault; its password adopts the new keys. */
export type VaultProblem = 'join-needed' | 'other-vault' | 'not-encrypted' | 'keys-changed'

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
  currentVersion?: string
  lastCheckedAt?: number
  /** The version the user chose to skip, shown in Settings with a way to stop skipping. */
  skippedVersion?: string
  /** What this build can do about an update, in a sentence; absent where electron-updater installs it. */
  reason?: string
  /** The last check or download failure. */
  error?: string
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
  | { cmd: 'show-settings'; section?: string }
  | { cmd: 'link' }
  | { cmd: 'find-in-notes' }

export type SearchScope = { kind: 'all' } | { kind: 'notebook'; id: string } | { kind: 'section'; id: string }

export interface SearchQuery {
  text: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
  scope: SearchScope
}

export interface SearchMatch {
  boxId: string
  snippet: string
  /** `[from, to)` in `snippet`. */
  ranges: Array<[number, number]>
  /** Which match this is within its box, in the in-page find bar's order. */
  occurrence: number
}

export interface SearchPageResult {
  pageId: string
  pageTitle: string
  sectionId: string
  sectionName: string
  notebookId: string
  notebookName: string
  matches: SearchMatch[]
}

export interface SearchResults {
  pages: SearchPageResult[]
  total: number
  /** More matches exist than the cap returned. */
  truncated: boolean
}

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
    /** The full settings after any window (or the menu, or sync) wrote them. */
    onChange(handler: (settings: Settings) => void): () => void
  }
  themes: ThemesApi
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
    /** The self-test error screen's "Copy diagnostic report" (audit S-6): redacted, no path, no key. */
    copyReport(): Promise<void>
  }
  mcp: { launcherInfo(): Promise<{ command: string; claudeCommand: string; packaged: boolean }> }
  clipboardText(): Promise<string>
  /** Opens an http(s) or mailto link in the system browser. Anything else is ignored. */
  openExternal(url: string): Promise<void>
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
    /** The window shows this notebook; synced so other devices can open it after their first sync. */
    opened(notebookId: string): Promise<void>
    /** After this device's first sync: the notebook to show instead of an empty default. */
    onOpenNotebook(handler: (notebookId: string) => void): () => void
  }
  update: {
    state(): Promise<UpdateState>
    /** Resolves with the state this check ended in, so the caller can say what it found. */
    check(): Promise<UpdateState>
    download(): Promise<void>
    install(): Promise<void>
    openInstaller(): Promise<void>
    showInFolder(): Promise<void>
    copyCommand(): Promise<void>
    copyReleaseUrl(): Promise<void>
    skip(): Promise<void>
    unskip(): Promise<void>
    dismiss(): Promise<void>
    onState(handler: (state: UpdateState) => void): () => void
  }
  search: { query(query: SearchQuery): Promise<SearchResults> }
  /** The themed title bar (renderer/src/titleBar/). */
  chrome: {
    /** Which bar this window was opened with, read once at preload. */
    kind: WindowChrome
    platform: string
    setColors(colors: ChromeColors): void
    toggleMaximize(): void
    menu(): Promise<AppMenuNode[]>
    invokeMenu(path: number[]): void
  }
  onMenu(handler: (command: MenuCommand) => void): () => void
  /** Updates another process (an agent via slate-mcp) wrote to the database. */
  onExternalUpdates(handler: (batches: ExternalBatch[]) => void): () => void
  vault: VaultApi
  appVersion(): Promise<string>
  /** Quits Slate (the self-test error screen's only way out, S-6). */
  quit(): Promise<void>
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
  /** False when this computer has no keyring Slate can use: the sign-in lasts until Slate quits. */
  remembered?: boolean
}

export interface ExternalBatch {
  docId: string
  updates: Uint8Array[]
}

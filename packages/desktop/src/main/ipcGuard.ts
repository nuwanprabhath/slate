import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { CH } from '../shared/ipc'
import { isAppEntry } from './appProtocol'
import { logHandlers } from './log/ipcLog'
import { log } from './log/logger'
import { Locked } from './vault/keyring'
import { secretsIn, zeroSecret } from '../shared/secret'
import { originOf, securityEvent } from './log/securityEvents'

/** Every channel name the app has. A string that is not one of these does not compile as a channel. */
export type Channel = (typeof CH)[keyof typeof CH]

/**
 * How main treats each channel. `Record<keyof typeof CH, …>`, so a channel added to `CH` without a
 * decision here is a compile error.
 *
 * - `pre-unlock`: an `invoke` handler the lock screen may call (§6.3).
 * - `flush`: a note write let through while the lock flushes the renderer (§6.4).
 * - `unlocked`: an `invoke` handler that throws `Locked` until the vault is open (the default).
 * - `send`: renderer → main fire-and-forget (`ipc.on`), dropped while the vault is locked.
 * - `send-pre-unlock`: a `send` the lock screen needs (window chrome, its theme, locking, the flush
 *   reply); delivered while locked, so it must be harmless then.
 *
 * Every policy but `unlocked` and `event` is pinned in tools/guards/allowlists/ipc-ungated.json,
 * which only the maintainer grows (tools/guards/ipcChannels.test.ts, ratchet.test.ts).
 * - `event`: main → renderer only (`webContents.send`); never registered as a handler.
 */
export type ChannelPolicy = 'pre-unlock' | 'flush' | 'unlocked' | 'send' | 'send-pre-unlock' | 'event'

/**
 * Z-5 (C7, re-review M): the invoke channels whose arguments carry a typed secret (`SecretBytes`, or a
 * `VaultSecret`). `createIpc` zeroes those arguments at its outermost layer, around the sender check, the
 * vault gate and the handler, so a refusal (`UntrustedSender`, `Locked`) zeroes them too.
 * tools/guards/vaultSecrets.test.ts holds this list to every VaultApi method that takes one.
 */
export const SECRET_CHANNELS: Readonly<Partial<Record<keyof typeof CH, true>>> = {
  vaultUnlock: true,
  vaultUnlockRecovery: true,
  vaultQuickUnlockEnable: true,
  vaultFinishMigration: true,
  vaultCheckPassword: true,
  vaultPrepare: true,
  vaultConfirmRecovery: true,
  vaultJoin: true,
  vaultChangePassword: true,
  vaultNewRecovery: true,
  vaultRekeyPrepare: true,
}
const SECRET: ReadonlySet<string> = new Set(Object.keys(SECRET_CHANNELS).map((k) => CH[k as keyof typeof CH]))

/**
 * S-7 (b), review C6: the invoke channels that write a vault key or file (a key wrap, a header, an encrypted
 * database). The registrar runs the power-up self-test before each, after the vault gate, and a failed self-test
 * stops the change; tools/guards/selfTest.test.ts keeps the list.
 */
export const VAULT_CHANGE_CHANNELS: Readonly<Partial<Record<keyof typeof CH, true>>> = {
  vaultPrepare: true,
  vaultEncrypt: true,
  vaultEncryptRemote: true,
  vaultFinishMigration: true,
  vaultJoin: true,
  vaultChangePassword: true,
  vaultNewRecovery: true,
  vaultQuickUnlockEnable: true,
  vaultRekeyPrepare: true,
  vaultRekeyRun: true,
}
const VAULT_CHANGE: ReadonlySet<string> = new Set(Object.keys(VAULT_CHANGE_CHANNELS).map((k) => CH[k as keyof typeof CH]))

export const CHANNEL_POLICY: Readonly<Record<keyof typeof CH, ChannelPolicy>> = {
  docsList: 'unlocked',
  docsLoad: 'unlocked',
  docsAppend: 'flush',
  docsRemove: 'unlocked',
  blobsPut: 'flush',
  blobsCopyImage: 'unlocked',
  blobsCopyRich: 'unlocked',
  settingsGet: 'unlocked',
  settingsSet: 'unlocked',
  settingsChanged: 'event',
  clipboardText: 'unlocked',
  openExternal: 'pre-unlock',
  auditList: 'unlocked',
  diagnosticsStatus: 'unlocked',
  diagnosticsRead: 'unlocked',
  diagnosticsCopy: 'unlocked',
  diagnosticsClear: 'unlocked',
  diagnosticsOpenFolder: 'unlocked',
  diagnosticsRendererError: 'unlocked',
  diagnosticsCopyReport: 'unlocked',
  menu: 'event',
  externalUpdates: 'event',
  onenoteStatus: 'unlocked',
  onenoteSignIn: 'unlocked',
  onenoteSignOut: 'unlocked',
  onenoteTree: 'unlocked',
  onenoteStart: 'unlocked',
  onenoteRetry: 'unlocked',
  onenoteCancel: 'unlocked',
  onenotePickBackup: 'unlocked',
  onenoteStartBackup: 'unlocked',
  onenoteSetClientId: 'unlocked',
  onenoteProgress: 'event',
  syncStatus: 'unlocked',
  syncSetEnabled: 'unlocked',
  syncConfigure: 'unlocked',
  syncTestGit: 'unlocked',
  syncGitAuthInfo: 'unlocked',
  syncCreateRepo: 'unlocked',
  syncDeviceSignIn: 'unlocked',
  syncDeviceSignInWait: 'unlocked',
  syncNow: 'unlocked',
  syncConflicts: 'unlocked',
  syncResolve: 'unlocked',
  syncStatusEvent: 'event',
  syncNotice: 'event',
  syncOpened: 'unlocked',
  syncOpenNotebook: 'event',
  mcpLauncher: 'unlocked',
  updateState: 'pre-unlock',
  updateCheck: 'unlocked',
  updateDownload: 'unlocked',
  updateInstall: 'unlocked',
  updateOpenInstaller: 'unlocked',
  updateShowInFolder: 'unlocked',
  updateCopyCommand: 'unlocked',
  updateCopyReleaseUrl: 'unlocked',
  updateSkip: 'unlocked',
  updateUnskip: 'unlocked',
  updateDismiss: 'unlocked',
  updateStateEvent: 'event',
  searchQuery: 'unlocked',
  themesInitial: 'send-pre-unlock',
  themesList: 'unlocked',
  themesSave: 'unlocked',
  themesRename: 'unlocked',
  themesRemove: 'unlocked',
  themesChanged: 'event',
  themesClaude: 'unlocked',
  themesGenerate: 'unlocked',
  themesCancel: 'unlocked',
  chromeKind: 'send-pre-unlock',
  chromeSetColors: 'send-pre-unlock',
  chromeToggleMaximize: 'send-pre-unlock',
  chromeMenu: 'pre-unlock',
  chromeInvokeMenu: 'send-pre-unlock',
  appVersion: 'pre-unlock',
  appQuit: 'unlocked',
  vaultStatus: 'pre-unlock',
  vaultUnlock: 'pre-unlock',
  vaultUnlockRecovery: 'pre-unlock',
  vaultQuickUnlock: 'pre-unlock',
  vaultQuickUnlockInfo: 'unlocked',
  vaultQuickUnlockEnable: 'unlocked',
  vaultQuickUnlockDisable: 'unlocked',
  vaultFinishMigration: 'unlocked',
  vaultCancelMigration: 'unlocked',
  vaultFlush: 'event',
  vaultFlushed: 'send-pre-unlock',
  vaultActivity: 'send',
  vaultCopied: 'send',
  vaultLock: 'send-pre-unlock',
  vaultCheckPassword: 'unlocked',
  vaultPrepare: 'unlocked',
  vaultConfirmRecovery: 'unlocked',
  vaultSaveRecovery: 'unlocked',
  vaultEncrypt: 'unlocked',
  vaultDiscard: 'unlocked',
  vaultJoin: 'unlocked',
  vaultEncryptRemote: 'unlocked',
  vaultChangePassword: 'unlocked',
  vaultNewRecovery: 'unlocked',
  vaultProgress: 'event',
  vaultModuleStatus: 'unlocked',
  vaultSelfTest: 'unlocked',
  vaultKeysInfo: 'unlocked',
  vaultRekeyPrepare: 'unlocked',
  vaultRekeyRun: 'unlocked',
  vaultReplaceHistory: 'unlocked',
  vaultPqReadiness: 'unlocked',
  syncCheckTransport: 'unlocked',
  pagePrint: 'unlocked',
  editCommand: 'unlocked',
}


/**
 * C6 (audit §4.2, S-6): what main serves while the power-up self-test runs (`selftest`) or after it failed
 * (`selftest-failed`), whatever CHANNEL_POLICY says. `Record<keyof typeof CH, …>` like CHANNEL_POLICY, so a new
 * channel is a compile error until it is decided here too. The error screen needs its status, the version, its
 * window chrome (the preload's theme and title bar), Quit and Copy diagnostic report; every other invoke throws
 * `SelfTestFailed` and every other send is dropped. tools/guards/ipcChannels.test.ts pins the served set.
 */
export type SelfTestPolicy = 'served' | 'refused' | 'event'
export const SELF_TEST_POLICY: Readonly<Record<keyof typeof CH, SelfTestPolicy>> = {
  docsList: 'refused',
  docsLoad: 'refused',
  docsAppend: 'refused',
  docsRemove: 'refused',
  blobsPut: 'refused',
  blobsCopyImage: 'refused',
  blobsCopyRich: 'refused',
  settingsGet: 'refused',
  settingsSet: 'refused',
  settingsChanged: 'event',
  clipboardText: 'refused',
  openExternal: 'refused',
  auditList: 'refused',
  diagnosticsStatus: 'refused',
  diagnosticsRead: 'refused',
  diagnosticsCopy: 'refused',
  diagnosticsClear: 'refused',
  diagnosticsOpenFolder: 'refused',
  diagnosticsRendererError: 'refused',
  diagnosticsCopyReport: 'served',
  menu: 'event',
  externalUpdates: 'event',
  onenoteStatus: 'refused',
  onenoteSignIn: 'refused',
  onenoteSignOut: 'refused',
  onenoteTree: 'refused',
  onenoteStart: 'refused',
  onenoteRetry: 'refused',
  onenoteCancel: 'refused',
  onenotePickBackup: 'refused',
  onenoteStartBackup: 'refused',
  onenoteSetClientId: 'refused',
  onenoteProgress: 'event',
  syncStatus: 'refused',
  syncSetEnabled: 'refused',
  syncConfigure: 'refused',
  syncTestGit: 'refused',
  syncGitAuthInfo: 'refused',
  syncCreateRepo: 'refused',
  syncDeviceSignIn: 'refused',
  syncDeviceSignInWait: 'refused',
  syncNow: 'refused',
  syncConflicts: 'refused',
  syncResolve: 'refused',
  syncStatusEvent: 'event',
  syncNotice: 'event',
  syncOpened: 'refused',
  syncOpenNotebook: 'event',
  mcpLauncher: 'refused',
  updateState: 'refused',
  updateCheck: 'refused',
  updateDownload: 'refused',
  updateInstall: 'refused',
  updateOpenInstaller: 'refused',
  updateShowInFolder: 'refused',
  updateCopyCommand: 'refused',
  updateCopyReleaseUrl: 'refused',
  updateSkip: 'refused',
  updateUnskip: 'refused',
  updateDismiss: 'refused',
  updateStateEvent: 'event',
  searchQuery: 'refused',
  themesInitial: 'served',
  themesList: 'refused',
  themesSave: 'refused',
  themesRename: 'refused',
  themesRemove: 'refused',
  themesChanged: 'event',
  themesClaude: 'refused',
  themesGenerate: 'refused',
  themesCancel: 'refused',
  chromeKind: 'served',
  chromeSetColors: 'served',
  chromeToggleMaximize: 'served',
  chromeMenu: 'served',
  chromeInvokeMenu: 'served',
  appVersion: 'served',
  appQuit: 'served',
  vaultStatus: 'served',
  vaultUnlock: 'refused',
  vaultUnlockRecovery: 'refused',
  vaultQuickUnlock: 'refused',
  vaultQuickUnlockInfo: 'refused',
  vaultQuickUnlockEnable: 'refused',
  vaultQuickUnlockDisable: 'refused',
  vaultFinishMigration: 'refused',
  vaultCancelMigration: 'refused',
  vaultFlush: 'event',
  vaultFlushed: 'refused',
  vaultActivity: 'refused',
  vaultCopied: 'refused',
  vaultLock: 'refused',
  vaultCheckPassword: 'refused',
  vaultPrepare: 'refused',
  vaultConfirmRecovery: 'refused',
  vaultSaveRecovery: 'refused',
  vaultEncrypt: 'refused',
  vaultDiscard: 'refused',
  vaultJoin: 'refused',
  vaultEncryptRemote: 'refused',
  vaultChangePassword: 'refused',
  vaultNewRecovery: 'refused',
  vaultProgress: 'event',
  vaultModuleStatus: 'refused',
  vaultSelfTest: 'refused',
  vaultKeysInfo: 'refused',
  vaultRekeyPrepare: 'refused',
  vaultRekeyRun: 'refused',
  vaultReplaceHistory: 'refused',
  vaultPqReadiness: 'refused',
  syncCheckTransport: 'refused',
  pagePrint: 'refused',
  editCommand: 'refused',
}

const channelsWith = (policy: ChannelPolicy): ReadonlySet<string> =>
  new Set((Object.keys(CHANNEL_POLICY) as Array<keyof typeof CH>).filter((k) => CHANNEL_POLICY[k] === policy).map((k) => CH[k]))

/** What the lock screen may call (§6.3). Every other handler throws `Locked` until the vault is unlocked. */
export const PRE_UNLOCK_CHANNELS: ReadonlySet<string> = channelsWith('pre-unlock')

/** Note writes the lock lets through while the renderer flushes, so an edit in flight is kept (§6.4). */
export const FLUSH_CHANNELS: ReadonlySet<string> = channelsWith('flush')

const HANDLED: ReadonlySet<string> = new Set([...PRE_UNLOCK_CHANNELS, ...FLUSH_CHANNELS, ...channelsWith('unlocked')])

/** What main serves in `selftest` and `selftest-failed` (SELF_TEST_POLICY): invoke and send channels alike. */
export const SELF_TEST_CHANNELS: ReadonlySet<string> = new Set(
  (Object.keys(SELF_TEST_POLICY) as Array<keyof typeof CH>).filter((k) => SELF_TEST_POLICY[k] === 'served').map((k) => CH[k]),
)

/**
 * What the IPC gate asks about the vault on every message: `true` while notes are open, `false` while locked,
 * `'self-test'` while the power-up self-test runs or after it failed (audit §4.2), when only SELF_TEST_CHANNELS
 * are served, whatever CHANNEL_POLICY says.
 */
export type VaultGate = boolean | 'self-test'

/** Every channel outside SELF_TEST_CHANNELS throws this while the power-up self-test runs or after it failed. */
export class SelfTestFailed extends Error {
  override name = 'SelfTestFailed'
  constructor() {
    super('Slate stopped because a cryptographic self-test failed')
  }
}
const SENT: ReadonlySet<string> = channelsWith('send')
const SENT_PRE_UNLOCK: ReadonlySet<string> = channelsWith('send-pre-unlock')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a handler's arguments are whatever its channel takes; the renderer is untrusted, so each handler checks them
export type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as Handler: the payload is whatever the channel sends
export type Listener = (event: IpcMainEvent, ...args: any[]) => void

/**
 * The one way main code registers IPC. Built once by `createIpc` in index.ts and passed to every
 * `register…Ipc`; nothing else touches `ipcMain` (lint rule `slate/ipc-through-registrar`).
 */
export interface IpcRegistrar {
  /** An `invoke` handler, gated by the channel's policy; each channel once. */
  handle(channel: Channel, handler: Handler): void
  /** A renderer → main message (`send` policy only). Returns the unsubscribe. */
  on(channel: Channel, listener: Listener): () => void
}

interface Registrar {
  handle(channel: Channel, handler: Handler): void
}

/**
 * Wraps `handle`: deny by default while locked (`Locked`) and while the self-test runs or failed
 * (`SelfTestFailed`), and each channel registered once only.
 */
export function guardHandlers<T extends Registrar>(ipc: T, open: () => VaultGate, flushing: () => boolean = () => false, beforeChange: () => Promise<void> = refuseChange): T {
  const registered = new Set<string>()
  return {
    ...ipc,
    handle: (channel: Channel, handler: Handler) => {
      if (!HANDLED.has(channel)) throw new Error(`IPC channel ${channel} is not an invoke channel in CHANNEL_POLICY (src/main/ipcGuard.ts)`)
      if (registered.has(channel)) throw new Error(`IPC channel ${channel} is already registered`)
      registered.add(channel)
      const allowed = PRE_UNLOCK_CHANNELS.has(channel)
      const flushWrite = FLUSH_CHANNELS.has(channel)
      const inSelfTest = SELF_TEST_CHANNELS.has(channel)
      const change = VAULT_CHANGE.has(channel)
      ipc.handle(channel, (...args) => {
        const gate = open()
        if (gate === 'self-test') {
          if (!inSelfTest) throw new SelfTestFailed()
        } else if (!allowed && !gate && !(flushWrite && flushing())) throw new Locked()
        if (change) return beforeChange().then(() => handler(...args))
        return handler(...args)
      })
    },
  }
}

/** Without a self-test to run, a vault change does not happen (a registrar built without one fails closed). */
async function refuseChange(): Promise<void> {
  throw new SelfTestFailed()
}

export class UntrustedSender extends Error {
  override name = 'UntrustedSender'
  constructor() {
    super('IPC from a frame that is not Slate')
  }
}

/** The part of Electron's `WebFrameMain` the sender check reads. */
export interface SenderFrame {
  readonly url: string
  readonly parent: unknown
}

/**
 * Only the top frame of a Slate window showing Slate's own page may call IPC (audit B-2): a remote
 * page that a window was navigated to, or an iframe, would otherwise get the vault's channels.
 */
export function isTrustedSender(frame: SenderFrame | null | undefined, isApp: (url: string) => boolean, slateWindow = false): boolean {
  try {
    if (!frame || frame.parent !== null) return false
    // While the preload runs the page has not committed and the frame has no URL yet. Only a window
    // the factory made (which the navigation guards keep on Slate's page) is trusted then.
    if (frame.url === '') return slateWindow
    return isApp(frame.url)
  } catch {
    // A frame that navigated away or was destroyed throws on access.
    return false
  }
}

const senderFrame = (event: unknown): SenderFrame | null | undefined => (event as { senderFrame?: SenderFrame | null } | null)?.senderFrame
const sender = (event: unknown): unknown => (event as { sender?: unknown } | null)?.sender

/** The slice of Electron's `ipcMain` the registrar wraps; tests pass a fake. */
export interface RawIpc {
  handle(channel: string, handler: Handler): void
  on(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
}

/**
 * The app's registrar: every message must come from Slate's own page (`isApp`, B-2), and every
 * `invoke` handler logs its rejections and is gated by the vault state (`open`, or `flushing` for
 * the flush channels). Call once, before any `register…Ipc`.
 */
export function createIpc(
  open: () => VaultGate,
  flushing: () => boolean,
  raw: RawIpc = ipcMain,
  isApp: (url: string) => boolean = (url) => isAppEntry(url),
  slateWindow: (webContents: unknown) => boolean = () => false,
  /** S-7 (b): the self-test every VAULT_CHANGE_CHANNELS call runs first; it throws when the self-test failed. */
  beforeChange: () => Promise<void> = refuseChange,
): IpcRegistrar {
  // One registrar per ipcMain: a second one could be built with an always-open gate.
  if (wrapped.has(raw)) throw new Error('createIpc runs once, in index.ts; take the IpcRegistrar it returned as a parameter')
  wrapped.add(raw)
  const trusted = (channel: string, event: unknown): boolean => {
    if (isTrustedSender(senderFrame(event), isApp, slateWindow(sender(event)))) return true
    securityEvent.ipcUntrustedSender({ channel, origin: originOf(senderFrame(event)?.url) })
    return false
  }
  const fromApp = (c: Channel, h: Handler): void =>
    raw.handle(c, (event, ...args) => {
      const run = () => {
        if (!trusted(c, event)) throw new UntrustedSender()
        return h(event, ...args)
      }
      if (!SECRET.has(c)) return run()
      // The outermost layer: whatever refuses or runs the call, the secret bytes main received are zeroed
      // when it settles (Z-5).
      return (async () => {
        try {
          return await run()
        } finally {
          zeroSecret(...secretsIn(args))
        }
      })()
    })
  const guarded = guardHandlers(logHandlers({ handle: fromApp }, log), open, flushing, beforeChange)
  return {
    handle: guarded.handle,
    on: (channel, listener) => {
      const always = SENT_PRE_UNLOCK.has(channel)
      if (!SENT.has(channel) && !always) throw new Error(`IPC channel ${channel} is not a send channel in CHANNEL_POLICY (src/main/ipcGuard.ts)`)
      const gated: Listener = (event, ...args) => {
        if (!trusted(channel, event)) {
          // A refused sendSync would otherwise block that renderer for good (review M1).
          event.returnValue = null
          return
        }
        const gate = open()
        if (gate === 'self-test' ? SELF_TEST_CHANNELS.has(channel) : always || gate) listener(event, ...args)
      }
      raw.on(channel, gated)
      return () => void raw.removeListener(channel, gated)
    },
  }
}

const wrapped = new WeakSet<RawIpc>()


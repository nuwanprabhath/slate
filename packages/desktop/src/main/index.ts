import { app, BrowserWindow, clipboard, dialog, powerMonitor, protocol, session, systemPreferences } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { arch, homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeDocSource } from './mcp/docSource'
import { mcpSocketPath, prepareSocketDir, socketEnv } from './mcp/socketPath'
import { startMcpSocketServer, type McpSocketServer } from './mcp/socketServer'
import { readJsonCapped } from './vault/atomic'
import { destroyProof, parseHeader, proveSecret, rotationDueSince, type WrapProof } from './vault/header'
import { FipsModuleRequired, isProfileId, ProfileLatched, PROFILES, effectiveIdleMinutes, locksOnScreenLock, locksOnSleep, type ProfileId, type ProfilePolicy } from './vault/profile'
import { vaultNative } from './vault/native'
import { securityEvent, type LockTrigger, type SelftestPhase, type UnlockMethod } from './log/securityEvents'
import { RefusalCoalescer, THROTTLE_FILE, ThrottleGate } from './vault/unlockThrottle'
import { HeaderRefused } from './vault/profileFloor'
import { destroyKey } from './vault/native'
import {
  enableQuickUnlock,
  forgetQuickUnlock,
  openQuickUnlock,
  QUICK_UNLOCK_FALLBACK_MESSAGE,
  quickUnlockEnabled,
  quickUnlockKind,
  type QuickUnlockPlatform,
} from './vault/quickUnlock'
import type { KeyHandle } from '@slate/native'
import type { QuickUnlockInfo, UnlockResult, VaultSecret, VaultStatus } from '../shared/api'
import { CH } from '../shared/ipc'
import { secretBytes, type SecretBytes } from '../shared/secret'
import { registerPqIpc } from './pqIpc'
import { registerVaultSecretIpc } from './vaultIpc'
import { DEFAULT_SETTINGS } from '../shared/settings/schema'
import { BLOB_SCHEME, blobNameFromUrl } from './blobs'
import { createIpc } from './ipcGuard'
import { openExternalSafe } from './openExternal'
import { registerIpc, registerOneNoteIpc, registerSearchIpc, registerSyncIpc } from './ipc'
import { configureLogging, configureSecurityLog, registerDiagnosticsIpc } from './log/configure'
import { log } from './log/logger'
import { buildMenu, syncMenuChecks } from './menu'
import { launcherInfo } from './mcpLauncher'
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, devServerOrigin, isAppEntry } from './appProtocol'
import { handleAppProtocol, handleNoteProtocol } from './protocols'
import { installBoundaryGuards } from './hardening'
import { createUpdates } from './update'
import { createAuthService, type AuthService } from './onenote/auth'
import { converterPath, defaultConverterDirs } from './onenote/backup'
import { acquireLock } from './lock'
import { onSettingsWritten, readSettings, writeSettings } from './settings'
import { APP_NAME, defaultUserDataDir, migrateLegacyUserData } from './paths'
import { closeServices, openServices, services, servicesOpen } from './services'
import { activeThemeSpec, registerThemeIpc, windowBackground, type ThemeSource } from './theme/ipc'
import { registerChromeIpc } from './windowChromeIpc'
import { createWindow, isSlateWindow, loadPage, pinErrorPage } from './windows'
import { chromeOptions, titleBarColors, windowChromeFor } from '../shared/windowChrome/chrome'
import { IdleTimer } from './vault/idle'
import { runLock, shouldClearClipboard } from './vault/lockSequence'
import type { PreunlockContent } from './vault/preunlock'
import { checkPreunlock, lockScreenPrefs, savePreunlock } from './vault/preunlockSync'
import { startScreenLockMonitor, type ScreenLockMonitor } from './vault/screenLock'
import { createEncryptedDataDir } from './vault/testVault'
import { AdoptWithOldSecret, LOCAL_KEYS_FILE, PENDING_FILE, PREUNLOCK_FILE, PREV_FILE, UNLOCK_FAILED_MESSAGE, UnlockFailed, unlockVault, VAULT_FILE, type UnlockSecret } from './vault/unlock'
import { initialVaultState, KEY_FILE_MISSING_MESSAGE, notesOpen, VaultStateMachine } from './vault/vaultState'
import { finishMigrationAtUnlock, Migration, MIGRATION_FILE } from './vault/migration'
import { removeStrayDatabases } from './db/migrateToEncrypted'
import { checkPassword } from './vault/password'
import { recoveryFileText, recoverySaveDialog, refuseRecoveryPath } from './vault/recoveryFile'
import { checkRemoteVault } from './vault/vaultCheck'
import { VaultBusy } from './vault/busy'
import { nextCompletedSync, startPqUpgrade } from './vault/pqUpgrade'
import { env, envSnapshot, scrubProcessTestHooks } from './testHooks'
import { appSecretStorage } from './secretStorage'
import { installMemoryProbes } from './memoryProbes'
import { launchCryptoModule } from './native/launch'
import { gateNotesOnSelfTest } from './db/dbModule'
import { SelfTestFailed } from './ipcGuard'
import { isKatId, runPost, type KatId, type PostResult } from './vault/selftest/post'
import { startRequiresFips } from './vault/selftest/profilePeek'
import { diagnosticReport } from './vault/selftest/report'
import { databaseFault, failClosed, FaultSupervisor, startupSelfTest, watchModule } from './vault/selftest/supervisor'
import type { SelfTestSummary } from '../shared/api'
import { createSandboxMonitor } from './rendererSandbox'
import { applyTlsPolicy } from './tlsPolicy'

scrubProcessTestHooks(app.isPackaged)
applyTlsPolicy()
app.setName(APP_NAME)
const userData = defaultUserDataDir()
if (!env('SLATE_USER_DATA')) migrateLegacyUserData(userData)
app.setPath('userData', userData)
const isE2E = env('SLATE_E2E') === '1'
installMemoryProbes(isE2E)
// §15 N4: decrypted pages and images must not reach Chromium's HTTP disk cache, encrypted or not.
app.commandLine.appendSwitch('disk-cache-size', '1')
// Weak KDF parameters are accepted only from the e2e hook's own test vault.
const testPassword = isE2E ? env('SLATE_TEST_ENCRYPT_PASSWORD') : undefined
// The wizard makes a cheap vault in e2e runs; each derivation would otherwise take a second.
const weakKdf = isE2E && env('SLATE_TEST_WEAK_KDF') === '1'
const kdfOpts = { allowWeakForTests: testPassword !== undefined || weakKdf }
// The e2e hook's test vault in the fips-140-3 profile (C5); standard otherwise.
const testProfileVar = isE2E ? env('SLATE_TEST_PROFILE') : undefined
const testProfile: ProfileId = isProfileId(testProfileVar) ? testProfileVar : 'standard'
const testIdleMs = isE2E ? Number(env('SLATE_TEST_IDLE_MS')) || 0 : 0

// One process owns the database (per data folder, since the lock follows userData): a second launch hands over and exits.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!isE2E) win.show()
  win.focus()
})

protocol.registerSchemesAsPrivileged([
  { scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES },
])

// Relative to out/main/index.js, which sits two levels below the package root both in dev and inside
// a packaged app, so `resources/` only has to be included in the package files.
const iconPath = join(__dirname, '../../resources/icon.png')

void app.whenReady().then(async () => {
  // Before any window loads: the built renderer is served from app://slate/, never from file:// (B-6).
  const rendererRoot = join(__dirname, '../renderer')
  handleAppProtocol(rendererRoot)
  // B-1/B-2/B-3: Slate's own page is the only page a window shows and the only IPC sender.
  const devServer = devServerOrigin(app.isPackaged, env('ELECTRON_RENDERER_URL'))
  // The app has one page: a window may show only the entry (any query), not another app:// file (review L-R1).
  const isApp = (url: string) => isAppEntry(url, devServer)
  installBoundaryGuards(isApp)
  if (!app.isPackaged) app.dock?.setIcon(iconPath)
  const dataDir = app.getPath('userData')
  // Tells the headless import CLI that this process has the database open.
  const releaseLock = acquireLock(dataDir)
  // S-1 (audit §4.2, C6): the only start state is `selftest`; nothing opens notes until the power-up self-test passed.
  const vault = new VaultStateMachine()
  // The e2e hook's test vault is made after the POST passed and before the data folder decides the state.
  let makingTestVault = false
  gateNotesOnSelfTest(() => (makingTestVault ? 'test-vault' : vault.state))
  const startedAt = new Date().toISOString()
  let lastSelfTest: SelfTestSummary = { passed: false, failed: [], ms: null }
  let selfTestFailure: { failed: readonly KatId[]; at: string; when: 'start-up' | 'later' } | null = null
  // S-7 (c): a module call that fails as a module fault reaches here before its caller sees the error. Faults seen
  // while a self-test runs wait for it to end (review C6).
  const faults = new FaultSupervisor(
    () => vault.state !== 'selftest' && vault.state !== 'selftest-failed',
    (kind) => {
      if (kind === 'error-state') {
        securityEvent.selftestFailed({ failed: ['POST-MODULE-STATUS'], fips: false, phase: 'module-error' })
        void failClosedNow(['POST-MODULE-STATUS'])
      } else void selfTestNow('module-error')
    },
  )
  const onModuleFault = (kind: 'error-state' | 'fault') => faults.report(kind)
  // Audit C2-C4: load @slate/native and its FIPS provider once; SQLCipher and every vault primitive run in it.
  // It starts gated (C6): no service runs until the power-up self-test below passed.
  const launched = launchCryptoModule(
    { packaged: app.isPackaged, resourcesPath: process.resourcesPath, userData: dataDir, mainDir: __dirname, platform: process.platform, arch: process.arch },
    (n) => watchModule(n, onModuleFault),
    (e) => {
      const kind = databaseFault(e, launched.native)
      if (kind) onModuleFault(kind)
    },
  )
  const cryptoNative = launched.native
  const cryptoModule = launched.status
  // S-4: a packaged build, a managed install, or a fips-140-3 vault (header or floor, unverified) needs the provider.
  const requireFips = app.isPackaged || (await startRequiresFips(process.resourcesPath, dataDir))
  // S-10: fault injection, only in an unpackaged e2e run (a packaged app never sees the variable: testHooks.ts).
  const corruptVar = isE2E && !app.isPackaged ? env('SLATE_TEST_SELFTEST_CORRUPT') : undefined
  const corrupt: KatId | null = isKatId(corruptVar) ? corruptVar : null
  const corruptOnDemand = corrupt !== null && env('SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND') === '1'
  const post = await startupSelfTest({
    native: cryptoNative,
    startProblem: cryptoNative ? cryptoModule.problem : null,
    requireFips: () => requireFips,
    vault,
    initialState: async () => {
      if (testPassword && !existsSync(join(dataDir, VAULT_FILE))) {
        makingTestVault = true
        try {
          destroyKey((await createEncryptedDataDir(dataDir, secretBytes(testPassword), kdfOpts, testProfile, 3)).mk)
        } finally {
          makingTestVault = false
        }
      }
      return initialVaultState({
        vault: existsSync(join(dataDir, VAULT_FILE)),
        localKeys: existsSync(join(dataDir, LOCAL_KEYS_FILE)),
        migration: existsSync(join(dataDir, MIGRATION_FILE)),
        plainDb: existsSync(join(dataDir, 'slate.db')),
      })
    },
    corrupt: corruptOnDemand ? null : corrupt,
    passed: (f) => securityEvent.selftestPassed(f),
    failed: (f) => securityEvent.selftestFailed({ ...f, phase: 'startup' }),
  })
  noteSelfTest(post, 'start-up')
  const failedAtStart = !post.ok
  if (failedAtStart && !isE2E) dialog.showErrorBox('Slate stopped', `A cryptographic self-test failed (${post.failed[0] ?? 'POST-MODULE-LOAD'}). Your notes were not opened.`)

  function noteSelfTest(r: PostResult, when: 'start-up' | 'later'): void {
    lastSelfTest = { passed: r.ok, failed: [...r.failed], ms: Math.round(r.ms) }
    cryptoModule.postMs = (cryptoModule.postMs ?? 0) + Math.round(r.ms)
    if (r.ok) return
    selfTestFailure ??= { failed: r.failed, at: new Date().toISOString(), when }
    cryptoModule.problem = r.failed[0] ?? cryptoModule.problem
    cryptoModule.errorState = true
    cryptoModule.approvedMode = false
  }
  // Live, not read once: "Encrypt my notes" and "Finish encrypting" turn it on without a restart.
  const encrypted = () => vault.state !== 'plaintext' && vault.state !== 'migrating' && !failedAtStart
  const preunlockPath = join(dataDir, PREUNLOCK_FILE)
  let prefs: PreunlockContent | null = encrypted() ? await lockScreenPrefs(preunlockPath) : null
  if (encrypted()) {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({})
  }
  const notes = () => notesOpen(vault.state) && servicesOpen()
  const openStore = () => (notes() ? services().store : null)
  // Deny by default (§6.3): every handler registered from here on checks the vault state.
  // The lock's flush step, when the state is already `locking` but the renderer's last edits must land.
  let flushing = false
  const inSelfTest = () => vault.state === 'selftest' || vault.state === 'selftest-failed'
  // S-7 (b): every vault-changing channel (VAULT_CHANGE_CHANNELS) runs the whole POST first, in the registrar.
  const beforeVaultChange = async () => {
    if (!(await selfTestNow('pre-change')).ok) throw new SelfTestFailed()
  }
  const ipc = createIpc(() => (inSelfTest() ? 'self-test' : notes()), () => flushing && servicesOpen(), undefined, isApp, isSlateWindow, beforeVaultChange)
  // Off until the notes are open: the setting lives in the (possibly encrypted) database.
  configureLogging({ debugLog: false })
  configureSecurityLog()
  registerDiagnosticsIpc(ipc, async () => {
    let vaultHeaderVersion: 1 | 2 | 3 | null = null
    try {
      vaultHeaderVersion = parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), kdfOpts).version
    } catch {
      // No vault (plaintext notes) or an unreadable header: null.
    }
    return { vaultHeaderVersion, transports: servicesOpen() ? services().store.transportObservations() : [] }
  })
  registerPqIpc(ipc)
  handleNoteProtocol(BLOB_SCHEME, notes, async (request) => {
    const name = blobNameFromUrl(request.url)
    if (!name) return new Response('Not found', { status: 404 })
    // An image added on another device arrives with its page; its bytes are fetched on first view.
    if ((await services().sync.ensureBlob(name)) === false) return new Response('Not found', { status: 404 })
    const found = services().blobs.readForUrl(request.url)
    if (!found) return new Response('Not found', { status: 404 })
    // no-store: decrypted image bytes must not land in Chromium's disk cache.
    return new Response(Buffer.from(found.bytes), { headers: { 'Content-Type': found.mime, 'Cache-Control': 'no-store' } })
  })
  registerIpc(
    ipc,
    () => services().store,
    () => services().blobs,
    (docId) => {
      services().sync.edited()
      services().search.docChanged(docId)
    },
    (docId) => services().search.docRemoved(docId),
  )
  registerSearchIpc(ipc, () => services().search)
  // out/main sits four levels under the repo root when running from a checkout.
  ipc.handle(CH.mcpLauncher, () =>
    launcherInfo({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: join(__dirname, '../../../..'), platform: process.platform }),
  )
  ipc.handle(CH.appVersion, () => app.getVersion())
  ipc.handle(CH.vaultModuleStatus, () => cryptoModule)
  // The self-test error screen's two buttons (S-6): Quit, and a redacted report with no path and no key.
  ipc.handle(CH.appQuit, () => app.quit())
  ipc.handle(CH.diagnosticsCopyReport, async () => {
    const failure = selfTestFailure ?? { failed: [], at: '', when: 'later' as const }
    let module = null
    try {
      module = cryptoNative?.status() ?? null
    } catch {
      module = null
    }
    await clipboard.writeText(
      diagnosticReport({ appVersion: app.getVersion(), platform: process.platform, arch: arch(), osRelease: release(), module, failed: failure.failed, failedAt: failure.at, startedAt, when: failure.when, home: homedir() }),
    )
  })
  // The OS keyring, through the async safeStorage API only (B-5).
  const secrets = appSecretStorage()
  const makeAuth = () =>
    createAuthService({
      clientId: env('SLATE_MS_CLIENT_ID') ?? (openStore() ? readSettings(services().store).msClientId : null) ?? null,
      cacheFile: join(dataDir, 'msal-cache.bin'),
      openBrowser: async (url) => {
        if (!(await openExternalSafe(url))) throw new Error('Refused to open a sign-in page that is not https')
      },
      fake: isE2E && env('SLATE_FAKE_AUTH') === '1',
      secrets,
    })
  // Saving a client id swaps the MSAL client underneath the service.
  let auth: AuthService | undefined
  const currentAuth: AuthService = {
    status: () => (auth ??= makeAuth()).status(),
    signIn: () => (auth ??= makeAuth()).signIn(),
    signOut: () => (auth ??= makeAuth()).signOut(),
    token: (scopes) => (auth ??= makeAuth()).token(scopes),
  }
  registerOneNoteIpc(ipc, currentAuth, () => services().importer, (id) => {
    writeSettings(services().store, { msClientId: id || null })
    auth = makeAuth()
  })
  registerSyncIpc(ipc, () => services().sync)
  const toWindows = (channel: string, payload: unknown) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))
  const intervalMs = Number(env('SLATE_SYNC_INTERVAL_MS'))
  const graphUrl = env('SLATE_GRAPH_URL') ?? 'https://graph.microsoft.com/v1.0'
  let currentDbFile = join(dataDir, 'slate.db')
  const startServices = (keyRing: Parameters<typeof openServices>[0], dbFile: string, sync = true) => {
    currentDbFile = dbFile
    const svc = openServices(keyRing, dbFile, {
      dataDir,
      emit: toWindows,
      checkVault: (remote, ring) => checkRemoteVault({ remote, dataDir, keyRing: ring, opts: kdfOpts }),
      // C9 (R-2): the rekey runner after each sync; the migration is made below, before any vault opens.
      afterSync: (outcome, ring) => migration.afterSync(ring, outcome),
      sync: {
        appVersion: app.getVersion(),
        auth: currentAuth,
        graphUrl,
        gitDir: join(dataDir, 'git-sync'),
        secrets,
        ...(env('SLATE_GITHUB_CLIENT_ID') ? { githubClientId: env('SLATE_GITHUB_CLIENT_ID') } : {}),
        ...(intervalMs > 0 ? { intervalMs } : {}),
        log: log.scoped('sync'),
      },
      importer: { auth: currentAuth, graphUrl, converter: converterPath(defaultConverterDirs()), log: log.scoped('import') },
      watchLog: log.scoped('watch'),
    })
    configureLogging(readSettings(svc.store))
    if (sync) svc.sync.start()
    // After the window is asked for, not before; a query arriving first waits behind it.
    setTimeout(() => notes() && svc.search.ensureBuilt(), 0)
    return svc
  }
  if (notesOpen(vault.state)) startServices(null, join(dataDir, 'slate.db'))

  const themeSource: ThemeSource = {
    open: () => (notes() ? { db: services().store, themes: services().themes } : null),
    preunlock: () => prefs,
  }
  // Updates are optional: whatever goes wrong setting them up must not stop the window opening.
  let updates: ReturnType<typeof createUpdates> | undefined
  try {
    // After a failed self-test nothing runs but the error screen: no update checks either.
    if (!failedAtStart) updates = createUpdates(openStore, isE2E, ipc)
  } catch (e) {
    log.error('app', 'update checks are off', { error: e instanceof Error ? e.message : String(e) })
  }
  registerThemeIpc(ipc, themeSource, isE2E)
  // Read once: a window keeps the chrome it opened with, so changing the setting needs a restart.
  const chrome = windowChromeFor(process.platform, prefs ? prefs.systemTitleBar : servicesOpen() ? readSettings(services().store).systemTitleBar : DEFAULT_SETTINGS.systemTitleBar)
  registerChromeIpc(ipc, chrome)

  // ---- Vault lifecycle (§6.4–6.7) ----
  let failures = 0
  let passwordChangedElsewhere = false
  let preunlockTampered = false
  let copied: { at: number; text: string } | null = null
  const liveHandles = (): number => {
    try {
      return vaultNative().status().liveHandles
    } catch {
      return 0
    }
  }
  // One owner of the vault's profile: the open key ring. Every path that opens a vault (unlock, quick unlock,
  // wizard, join, rejoin, finish-migration) ends with services open, so none can forget to set a copy.
  const throttleGate = new ThrottleGate(join(dataDir, THROTTLE_FILE), undefined, (e) => log.warn('app', 'unlock throttle not written', { error: e instanceof Error ? e.name : 'unknown' }))
  const throttledRefusals = new RefusalCoalescer((f) => securityEvent.unlockThrottled(f))
  const sessionPolicy = (): ProfilePolicy => PROFILES[servicesOpen() ? (services().keyRing?.schedule.profile ?? 'standard') : 'standard']
  const idle = new IdleTimer(() => void lock('idle'))
  let screenLock: ScreenLockMonitor = { detected: true, stop: () => {} }
  const rebuildMenu = () =>
    buildMenu({
      store: openStore,
      // Review C6: after a failed self-test the menu item does nothing; nothing runs but the error screen.
      onCheckForUpdates: () => void (vault.state === 'selftest-failed' ? undefined : updates?.check({ manual: true })), ...(vault.state === 'unlocked' ? { onLock: () => void lock('manual') } : {}) })
  // AC-11: a fips-140-3 vault never idles longer than its profile allows, whatever the stored setting says.
  const idleMs = () => (testIdleMs > 0 ? testIdleMs : effectiveIdleMinutes(prefs?.idleMinutes ?? DEFAULT_SETTINGS.idleMinutes, sessionPolicy()) * 60_000)
  const errorPage = (failed: readonly KatId[]) => ({ selfTestFailed: failed[0] ?? 'POST-MODULE-LOAD' })
  // Review C6: from `selftest-failed` on, every window any code opens or reloads is the error screen.
  pinErrorPage(() => (vault.state === 'selftest-failed' ? errorPage(selfTestFailure?.failed ?? []) : null))
  const openWindow = (lockScreen: boolean | { selfTestFailed: string } = vault.state === 'selftest-failed' ? errorPage(selfTestFailure?.failed ?? []) : vault.state === 'locked') =>
    trackInput(
      createWindow(
        { backgroundColor: windowBackground(themeSource), chrome: chromeOptions(chrome, titleBarColors(activeThemeSpec(themeSource))), iconPath, preloadPath: join(__dirname, '../preload/index.js'), isE2E },
        lockScreen,
      ),
    )

  function trackInput(win: BrowserWindow): BrowserWindow {
    win.webContents.on('before-input-event', (event, input) => {
      if (vault.state !== 'unlocked') return
      idle.touch()
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (input.type === 'keyDown' && mod && input.shift && !input.alt && input.key.toLowerCase() === 'l') {
        event.preventDefault()
        void lock('manual')
      }
    })
    return win
  }

  async function unlock(secret: UnlockSecret): Promise<UnlockResult> {
    // The lock screen is up while the lock still closes things behind it.
    await locking?.catch(() => {})
    if (vault.state !== 'locked') {
      // unlockVault would own a quick-unlock MK handle; it never gets there, so it goes here.
      if ('mk' in secret) destroyKey(secret.mk)
      return { ok: false, message: UNLOCK_FAILED_MESSAGE }
    }
    const method: UnlockMethod = 'mk' in secret ? 'quick' : 'password' in secret ? 'password' : 'recovery'
    // No await between the state check above and this transition: a concurrent unlock must lose here cleanly.
    vault.to('unlocking')
    const attemptPolicy = PROFILES[(await vaultProfile()) ?? 'standard']
    // AC-7: only a typed password is throttled; the recovery key is the administrator release, quick unlock is off in fips-140-3.
    if (method === 'password') {
      const decision = await throttleGate.check(attemptPolicy)
      if (decision.allowed) throttledRefusals.ended()
      else {
        throttledRefusals.refused(decision.retryAt)
        vault.to('locked')
        return { ok: false, message: `Too many wrong passwords. Try again at ${new Date(decision.retryAt).toLocaleTimeString()}, or unlock with your recovery key.`, failures }
      }
    }
    let opened: Awaited<ReturnType<typeof unlockVault>> | undefined
    try {
      opened = await unlockVault(dataDir, secret, kdfOpts)
      // A migration that stopped after the switch (§7.4): only the clean-up is left, best effort.
      const clean = await finishMigrationAtUnlock(dataDir, log.scoped('app'))
      // The notes' services open first (sync not yet started), so the remote can be read before anything is followed.
      const first = startServices(opened.keyRing, opened.dbFile, false)
      // C9 criterion 3: another device changed the vault's keys and this secret opens the new header too: follow it
      // now, re-encrypting the notes under the new keys. Review C9 M4: this device's own key change cut short in its
      // remote write is followed only if the remote holds it. A secret that does not open the new header leaves the old
      // keys in use; sync then asks for the new password (keys-changed).
      let followed = false
      if (opened.adopt && !('mk' in secret) && (await migration.mayAdopt(opened.adopt, opened.keyRing))) {
        try {
          opened.keyRing = await migration.rejoin(opened.keyRing, secret, opened.adopt)
          opened.dbFile = currentDbFile
          followed = true
        } catch (e) {
          if (!(e instanceof UnlockFailed)) throw e
        }
      }
      const svc = services()
      // A follow (or a follow that failed before its swap) reopened the services, and their sync, itself.
      if (!followed && clean && svc === first) svc.sync.start()
      await migration.resumeRekeyAtUnlock(opened.keyRing)
      const settings = readSettings(svc.store)
      preunlockTampered = (await checkPreunlock(preunlockPath, settings, opened.keyRing)).tampered
      if (preunlockTampered) securityEvent.preunlockTampered()
      passwordChangedElsewhere = opened.passwordChanged
      prefs = await lockScreenPrefs(preunlockPath)
    } catch (e) {
      // Never the secret, and nothing about why: every failure reads as a wrong password.
      securityEvent.unlockFailed({ method, failures: failures + 1 })
      if (servicesOpen()) closeServices()
      opened?.keyRing.close()
      // Recorded and written before the vault is `locked` again, so the next attempt sees it (three guesses, not four).
      const countsAsGuess = method === 'password' && existsSync(join(dataDir, LOCAL_KEYS_FILE)) && !(e instanceof FipsModuleRequired || e instanceof ProfileLatched || e instanceof HeaderRefused)
      if (countsAsGuess) await throttleGate.recordFailure(attemptPolicy)
      vault.to('locked')
      failures++
      // Not about the secret: the file that holds this computer's database key is gone.
      if (!existsSync(join(dataDir, LOCAL_KEYS_FILE))) return { ok: false, message: KEY_FILE_MISSING_MESSAGE, failures }
      // Not about the secret either, and decided before any key existed: the build, the session or the header.
      if (e instanceof FipsModuleRequired || e instanceof ProfileLatched || e instanceof HeaderRefused || e instanceof AdoptWithOldSecret) return { ok: false, message: e.message, failures }
      return { ok: false, message: UNLOCK_FAILED_MESSAGE, failures }
    }
    failures = 0
    securityEvent.unlockSucceeded({ method, headerRevision: opened.headerRevision })
    // R-4: a fips-140-3 vault's master key past its two-year cryptoperiod is logged at every unlock until rotated.
    const due = rotationDueSince(parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), kdfOpts))
    if (due !== null) securityEvent.keyRotationDue({ dueSince: due })
    // Any unlock ends a lockout (the recovery key is AC-7's release): what was held back is recorded now.
    throttledRefusals.ended()
    if ((await throttleGate.succeed(sessionPolicy(), opened.keyRing.get('prefs'))).tampered) securityEvent.preunlockTampered()
    vault.to('unlocked')
    // PQ-B3 (D-9): the v2 → v3 header upgrade, in the background once every device can read v3.
    const ring = opened.keyRing
    void startPqUpgrade({
      dataDir,
      kdfOpts,
      keyRing: ring,
      remote: () => (servicesOpen() ? services().sync.vaultRemote() : null),
      devices: () => services().sync.deviceRecords(),
      syncedBefore: async () => servicesOpen() && (await services().sync.hasSyncedBefore()),
      selfTest: async () => (await selfTestNow('pre-change')).ok,
      exclusive: (work) => busy.run(work).finally(() => quitAfterMigration && app.quit()),
      active: () => vault.state === 'unlocked' && servicesOpen() && services().keyRing === ring,
      nextSync: () => nextCompletedSync(async () => (servicesOpen() ? (await services().sync.status()).lastSyncedAt : undefined), () => vault.state === 'unlocked'),
    })
    if (quickUnlockFailed && !('mk' in secret)) offerQuickUnlock = true
    quickUnlockFailed = false
    void startMcp()
    idle.start(idleMs())
    rebuildMenu()
    // Z-6 (C7): the notes open in a new window and the lock window goes, so the renderer process that held
    // the typed password exits (§15 N6 in reverse; T-ZERO-05). Destroyed on the next task, after this
    // handler's reply has gone to it.
    const lockWindows = BrowserWindow.getAllWindows()
    openWindow(false)
    setTimeout(() => {
      for (const w of lockWindows) if (!w.isDestroyed()) w.destroy()
    }, 0)
    return { ok: true }
  }

  let locking: Promise<void> | null = null
  let quitting: Promise<void> | null = null
  function lock(trigger: LockTrigger): Promise<void> {
    if (vault.state !== 'unlocked' || quitting) return Promise.resolve()
    locking = runLockSequence(trigger)
      .catch((e: unknown) => {
        // A self-test that failed while this lock ran already closed everything (failClosed); its last move
        // (`locked`) is then refused, which is expected, not an error of the lock.
        if (vault.state !== 'selftest-failed') throw e
      })
      .finally(() => {
        locking = null
      })
    return locking
  }

  async function runLockSequence(trigger: LockTrigger): Promise<void> {
    idle.stop()
    const svc = services()
    const handlesBefore = liveHandles()
    await runLock(
      vault,
      {
        flushRenderer: () => flushWindows(),
        allowWrites: (on) => {
          flushing = on
        },
        stopEvents: () => svc.muteEvents(),
        closeMcp: () => stopMcp(),
        stopSync: () => svc.stopSync(),
        closeWatch: () => svc.closeWatch(),
        closeDatabases: () => svc.closeDatabases(),
        // Review C9 M3: a prepared key change's new master key goes with the ring, so running it needs the password again.
        closeKeys: () => {
          migration.discard()
          svc.keyRing?.close()
        },
        showLockWindow: () => {
          // Review C6: after a failed self-test the error screen stays the only window.
          if (vault.state === 'selftest-failed') return
          // §15 N6: a fresh renderer process for the lock screen, opened before the old window goes.
          const old = BrowserWindow.getAllWindows()
          openWindow(true)
          for (const w of old) w.destroy()
        },
        clearClipboard: async () => {
          if (shouldClearClipboard(copied, await clipboard.readText(), Date.now())) await clipboard.clear()
          copied = null
        },
      },
      { onError: (step, e) => log.error('app', 'lock step failed', { step, error: e instanceof Error ? e.message : String(e) }) },
    )
    securityEvent.locked({ trigger, destroyedHandles: Math.max(0, handlesBefore - liveHandles()) })
    rebuildMenu()
  }

  let flushSeq = 0
  function flushWindows(): Promise<void> {
    const wins = BrowserWindow.getAllWindows()
    return Promise.all(
      wins.map(
        (w) =>
          new Promise<void>((resolve) => {
            const id = ++flushSeq
            const off = ipc.on(CH.vaultFlushed, (_e, got: number) => {
              if (got !== id) return
              off()
              resolve()
            })
            w.webContents.send(CH.vaultFlush, id)
          }),
      ),
    ).then(() => {})
  }

  // ---- AI access through the app (§9): a socket only while the notes are unlocked ----
  let mcp: McpSocketServer | null = null
  const mcpPath = mcpSocketPath(dataDir, socketEnv({ platform: process.platform, env: envSnapshot(), tmpdir: tmpdir(), uid: process.getuid?.() ?? 0 }))
  async function startMcp(): Promise<void> {
    if (!encrypted() || mcp || process.platform === 'win32') return
    try {
      prepareSocketDir(mcpPath, dataDir, process.getuid?.() ?? 0)
      // Written in this process, so externalWatch never sees them: tell the windows here.
      const source = storeDocSource(
        () => services().store,
        (docId, update) => {
          services().sync.edited()
          services().search.docChanged(docId)
          if (notes()) toWindows(CH.externalUpdates, [{ docId, updates: [update] }])
        },
      )
      mcp = await startMcpSocketServer(mcpPath, source)
      // A lock that raced the start must not leave the socket open.
      if (!notes()) await stopMcp()
    } catch (e) {
      log.error('app', 'AI access socket failed to start', { error: e instanceof Error ? e.message : String(e) })
    }
  }
  async function stopMcp(): Promise<void> {
    const server = mcp
    mcp = null
    await server?.close()
  }

  // ---- Quick unlock (§8) ----
  const quickPlatform: QuickUnlockPlatform = { platform: process.platform, secrets, systemPreferences }
  let quickUnlockFailed = false
  let offerQuickUnlock = false
  const quickKind = async () => (quickUnlockEnabled(dataDir) ? quickUnlockKind(quickPlatform) : null)
  const setQuickUnlockSetting = (on: boolean) => {
    if (notes()) writeSettings(services().store, { quickUnlock: on })
  }
  ipc.handle(CH.vaultQuickUnlock, async (): Promise<UnlockResult> => {
    const fallback = (): UnlockResult => {
      quickUnlockFailed = true
      return { ok: false, message: QUICK_UNLOCK_FALLBACK_MESSAGE }
    }
    await locking?.catch(() => {})
    if (vault.state !== 'locked' || !(await quickKind())) return fallback()
    let mk: KeyHandle
    try {
      mk = await openQuickUnlock(dataDir, quickPlatform)
    } catch {
      securityEvent.unlockFailed({ method: 'quick', failures: failures + 1 })
      return fallback()
    }
    // unlock() owns the handle from here: it ends in the key ring or is destroyed.
    const result = await unlock({ mk })
    return result.ok ? result : fallback()
  })
  ipc.handle(CH.vaultQuickUnlockInfo, async (): Promise<QuickUnlockInfo> => {
    const info = { kind: await quickUnlockKind(quickPlatform), enabled: quickUnlockEnabled(dataDir), offerReenable: offerQuickUnlock }
    offerQuickUnlock = false
    return info
  })
  /** §8: the password once, through the same unwrap as an unlock; MK then moves from its wrap to QU's. */
  async function enableQuickUnlockWith(password: SecretBytes): Promise<UnlockResult> {
    let proof: WrapProof
    try {
      proof = await proveSecret(parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), kdfOpts), { password }, kdfOpts)
    } catch {
      return { ok: false, message: UNLOCK_FAILED_MESSAGE }
    }
    try {
      await enableQuickUnlock(dataDir, proof, quickPlatform, services().keyRing!.schedule)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Quick unlock could not be set up' }
    } finally {
      destroyProof(proof)
    }
    setQuickUnlockSetting(true)
    return { ok: true }
  }
  ipc.handle(CH.vaultQuickUnlockDisable, async () => {
    await forgetQuickUnlock(dataDir)
    setQuickUnlockSetting(false)
  })

  /** The profile vault.json names, for display only (the header is verified at unlock); v1 has none and is standard. */
  const vaultProfile = async (): Promise<ProfileId | null> => {
    if (!existsSync(join(dataDir, VAULT_FILE))) return null
    try {
      const p = ((await readJsonCapped(join(dataDir, VAULT_FILE))) as { profile?: unknown }).profile
      return isProfileId(p) ? p : 'standard'
    } catch {
      return null
    }
  }
  const headerRevision = async (): Promise<number> => {
    try {
      const r = ((await readJsonCapped(join(dataDir, VAULT_FILE))) as { revision?: unknown }).revision
      return typeof r === 'number' ? r : 0
    } catch {
      return 0
    }
  }
  // POAM-16: probed at each status call, so the lock screen's own renderer is live when it asks.
  const rendererSandbox = createSandboxMonitor({
    platform: process.platform,
    hasNoSandboxSwitch: () => app.commandLine.hasSwitch('no-sandbox'),
    readStatus: (path) => readFileSync(path, 'utf8'),
    rendererPids: () => BrowserWindow.getAllWindows().flatMap((w) => (w.isDestroyed() ? [] : [w.webContents.getOSProcessId()])),
    onUnsandboxed: (reason) => securityEvent.rendererUnsandboxed({ reason }),
  })
  const status = async (): Promise<VaultStatus> => {
    const quickUnlock = vault.state === 'locked' || vault.state === 'locking' ? await quickKind() : null
    // S-2: after a failed self-test vault.json is not read at all.
    const profile = inSelfTest() ? null : await vaultProfile()
    const s: VaultStatus = { state: vault.state, screenLockDetected: screenLock.detected, passwordChangedElsewhere, preunlockTampered, quickUnlock, profile, selfTest: lastSelfTest, rendererUnsandboxed: !rendererSandbox.check().sandboxed }
    passwordChangedElsewhere = false
    preunlockTampered = false
    return s
  }
  ipc.handle(CH.vaultStatus, () => status())

  // ---- Self-tests after start-up (S-7, S-8) ----
  /** The whole POST again (on demand, before a vault change, or after a module fault); a failure fails closed. */
  async function selfTestNow(phase: Exclude<SelftestPhase, 'startup'>): Promise<PostResult> {
    // The failure is handled inside the counted run, so the faults its own refusals reported (postEnd's SCC_12)
    // find the state already failed and are dropped: the error screen names the check that failed.
    return faults.during(async () => {
      const r = await runPost({ native: cryptoNative, requireFips: requireFips || (cryptoNative?.status().approvedKeysOnly ?? false), corrupt: corruptOnDemand ? corrupt : null })
      noteSelfTest(r, 'later')
      const fips = r.module?.fipsActive ?? false
      if (r.ok) securityEvent.selftestPassed({ ran: r.ran.length, ms: Math.round(r.ms), fips })
      else {
        securityEvent.selftestFailed({ failed: r.failed, fips, phase })
        await failClosedNow(r.failed)
      }
      return r
    })
  }
  async function failClosedNow(failed: readonly KatId[]): Promise<void> {
    selfTestFailure ??= { failed, at: new Date().toISOString(), when: 'later' }
    await failClosed(
      cryptoNative,
      vault,
      {
        // No renderer flush (S-8): writing through a faulty module is worse than losing the last edits.
        replaceWindowsWithErrorScreen: (f) => {
          const old = BrowserWindow.getAllWindows()
          openWindow(errorPage(f))
          for (const w of old) w.destroy()
        },
        stopServices: async () => {
          // Each part on its own (review C6): a fault right after start-up handed over reaches here before some of
          // these are declared, and the services must still stop.
          const quietly = async (run: () => unknown) => {
            try {
              await run()
            } catch {
              // Not set up yet, or already stopped.
            }
          }
          await quietly(() => idle.stop())
          await quietly(() => screenLock.stop())
          await quietly(() => stopMcp())
          if (!servicesOpen()) return
          const svc = services()
          await quietly(() => svc.muteEvents())
          await quietly(() => svc.closeWatch())
          await quietly(() => svc.stopSync())
        },
        stopUpdates: () => updates?.stop(),
        closeDatabases: () => {
          if (servicesOpen()) services().closeDatabases()
        },
        closeKeyRing: () => {
          const ring = servicesOpen() ? services().keyRing : null
          closeServices()
          ring?.close()
          // Review C9 M3 (last, so the ring closes even if the self-test failed before the migration was made).
          migration.discard()
        },
      },
      failed,
    )
    rebuildMenu()
  }
  ipc.handle(CH.vaultSelfTest, async (): Promise<SelfTestSummary> => {
    const r = await selfTestNow('on-demand')
    return { passed: r.ok, failed: [...r.failed], ms: Math.round(r.ms) }
  })
  // ---- Encrypt my notes, joining, header changes (§7, §10) ----
  const migration = new Migration({
    dataDir,
    kdfOpts,
    ...(weakKdf ? { kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 } } : {}),
    remote: () => (servicesOpen() ? services().sync.vaultRemote() : null),
    syncNow: async () => {
      await services().sync.now()
    },
    pauseSync: () => services().sync.pause(),
    resumeSync: () => servicesOpen() && services().sync.resume(),
    closeServices: async () => {
      if (!servicesOpen()) return
      const svc = services()
      // While unlocking (following another device's key change, C9) no window shows notes, and the lock window waits on
      // this very unlock: there is nothing to flush and no one to answer.
      if (vault.state !== 'unlocking') await flushWindows()
      svc.muteEvents()
      await svc.stopSync()
      svc.closeWatch()
      svc.closeDatabases()
    },
    reopenPlaintext: () => {
      if (!servicesOpen()) startServices(null, join(dataDir, 'slate.db'))
    },
    // A rejoin whose close failed part-way asks to reopen services that are still open.
    openServices: (keyRing, dbFile) => (servicesOpen() && services().keyRing === keyRing ? services() : startServices(keyRing, dbFile)),
    progress: (phase) => toWindows(CH.vaultProgress, { phase }),
    // D-7 (C9): the device records on the remote, which every rekey checks first.
    devices: () => services().sync.deviceRecords(),
    supersede: (id) => services().sync.supersedeCurrent(id),
    syncedBefore: async () => servicesOpen() && (await services().sync.hasSyncedBefore()),
    clearSuperseded: async () => {
      if (servicesOpen()) await services().sync.clearSuperseded()
    },
    notice: (message) => toWindows(CH.syncNotice, message),
  })
  // Quitting mid-migration waits for it (§7.1: "quitting deferred to a safe point").
  // Every vault-changing channel is refused while one runs (`busy.guard`).
  const busy = new VaultBusy()
  let quitAfterMigration = false
  const failure = (e: unknown): UnlockResult => ({ ok: false, message: e instanceof Error ? e.message : String(e) })
  const reloadWindows = () => BrowserWindow.getAllWindows().forEach((w) => loadPage(w, false))

  /** Runs a local migration; on success the vault is unlocked, on failure an unfinished one is `migrating`. */
  function migrate<T>(work: () => Promise<T>, done: (result: T) => boolean): Promise<T> {
    return busy.run(() => migrateNow(work, done)).finally(() => {
      if (quitAfterMigration) app.quit()
    })
  }

  async function migrateNow<T>(work: () => Promise<T>, done: (result: T) => boolean): Promise<T> {
    try {
      const result = await work()
      if (done(result)) {
        if (vault.state === 'plaintext') vault.to('migrating')
        vault.to('unlocked')
        await session.defaultSession.clearCache()
        prefs = await lockScreenPrefs(preunlockPath)
        armLockTriggers()
        void startMcp()
        idle.start(idleMs())
        rebuildMenu()
        reloadWindows()
      }
      return result
    } catch (e) {
      if (vault.state === 'plaintext' && existsSync(join(dataDir, VAULT_FILE))) vault.to('migrating')
      throw e
    }
  }

  /** A rejoin that failed after closing the services and could not reopen them: lock, with the old keys closed. */
  async function lockAfterFailedRejoin(oldRing: { close(): void }): Promise<void> {
    idle.stop()
    await stopMcp().catch(() => {})
    vault.to('locking')
    oldRing.close()
    if (servicesOpen()) closeServices()
    vault.to('locked')
    const old = BrowserWindow.getAllWindows()
    openWindow(true)
    for (const w of old) w.destroy()
    rebuildMenu()
  }

  ipc.handle(CH.vaultDiscard, busy.guard(() => migration.discard()))
  ipc.handle(CH.vaultSaveRecovery, async (e, key: unknown) => {
    const text = recoveryFileText(typeof key === 'string' ? key : '')
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = recoverySaveDialog(app.getPath('documents'))
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return { saved: false }
    const refused = refuseRecoveryPath(picked.filePath, dataDir)
    if (refused) return { saved: false, message: refused }
    await writeFile(picked.filePath, text, { mode: 0o600 })
    return { saved: true }
  })
  ipc.handle(CH.vaultEncrypt, () => {
    if (vault.state !== 'plaintext') throw new Error('Your notes are already encrypted')
    return migrate(() => migration.run(), (r) => r.kind === 'done')
  })
  ipc.handle(
    CH.vaultCancelMigration,
    busy.guard(() => {
      if (vault.state !== 'migrating') return
      migration.discard()
      for (const f of [VAULT_FILE, PENDING_FILE, PREV_FILE, PREUNLOCK_FILE, MIGRATION_FILE]) rmSync(join(dataDir, f), { force: true })
      removeStrayDatabases(dataDir)
      vault.to('plaintext')
    }),
  )
  ipc.handle(CH.vaultEncryptRemote, async (): Promise<UnlockResult> => {
    try {
      await busy.run(() => migration.encryptRemote(services().keyRing!, currentDbFile))
      reloadWindows()
      return { ok: true }
    } catch (e) {
      return failure(e)
    }
  })
  /** §7.3 / §7.5: adopt the remote's vault on a plaintext device, or rejoin from an encrypted one. */
  async function joinWith(secret: VaultSecret): Promise<void> {
    if (vault.state === 'plaintext' || vault.state === 'migrating') {
      await migrate(() => migration.join(secret), () => true)
      return
    }
    const oldRing = services().keyRing!
    try {
      await busy.run(() => migration.rejoin(oldRing, secret))
    } catch (e) {
      // Before its swap a rejoin reopens with the old ring; after it, nothing is open to unlock into.
      if (!servicesOpen()) await lockAfterFailedRejoin(oldRing)
      throw e
    }
    // C9 (review H1): a key change this device started and then followed carries on with its re-push and clean-up.
    await migration.resumeRekeyAtUnlock(services().keyRing!)
    // C9: new keys reseal the throttle record; following a conversion raises the profile, and the session policy.
    await throttleGate.succeed(sessionPolicy(), services().keyRing!.get('prefs'))
    armLockTriggers()
    idle.start(idleMs())
    reloadWindows()
  }
  // Z-5 (C7): the channels that receive a typed secret, each zeroing it on every exit (vaultIpc.ts).
  registerVaultSecretIpc(ipc, {
    state: () => vault.state,
    busy,
    unlock: (secret) => unlock(secret),
    enableQuickUnlock: enableQuickUnlockWith,
    checkPassword: async (pw, profile) => checkPassword(pw, [], profile ?? (await vaultProfile()) ?? 'standard'),
    prepare: (pw, profile) => migration.prepare(pw, profile),
    confirmRecovery: (key) => migration.confirmRecovery(key),
    finishMigration: (pw) => migrate(() => migration.resume(pw), () => true),
    join: joinWith,
    changePassword: async (current, next) => {
      await migration.changePassword(services().keyRing!, current, next)
      securityEvent.passwordChanged({ revision: await headerRevision() })
    },
    newRecoveryKey: async (pw) => {
      const key = await migration.newRecoveryKey(services().keyRing!, pw)
      securityEvent.recoveryRotated({ revision: await headerRevision() })
      return key
    },
    prepareRekey: async (kind, pw, next) => (await busy.run(() => migration.prepareRekey(services().keyRing!, kind, pw, next))).recoveryKey,
  })
  // ---- C9: key rotation, format upgrade, FIPS conversion (audit §4.7) ----
  ipc.handle(CH.vaultKeysInfo, () => migration.keysInfo(services().keyRing!))
  ipc.handle(CH.vaultRekeyRun, async (): Promise<UnlockResult> => {
    const oldRing = services().keyRing!
    try {
      await busy.run(() => migration.runRekey(oldRing))
    } catch (e) {
      // Before its swap the notes reopened under the old keys; after it, nothing is open to unlock into.
      if (!servicesOpen()) await lockAfterFailedRejoin(oldRing)
      return failure(e)
    }
    // The throttle record is sealed under K_prefs, which the new keys replaced: sealed again, never read as tampering.
    await throttleGate.succeed(sessionPolicy(), services().keyRing!.get('prefs'))
    // A raised profile (R-3) changes the session policy: the idle limit and lock triggers follow the new ring.
    armLockTriggers()
    idle.start(idleMs())
    reloadWindows()
    return { ok: true }
  })
  ipc.handle(CH.vaultReplaceHistory, async (): Promise<UnlockResult> => {
    try {
      await busy.run(() => migration.replaceHistory(services().keyRing!, currentDbFile))
      reloadWindows()
      return { ok: true }
    } catch (e) {
      return failure(e)
    }
  })
  ipc.on(CH.vaultActivity, () => {
    if (vault.state === 'unlocked') idle.touch()
  })
  // Locking needs no permission: the worst a page can do with it is lock the vault.
  ipc.on(CH.vaultLock, () => void lock('manual'))
  ipc.on(CH.vaultCopied, () => {
    // After the copy lands on the clipboard; a lock clears it only if it still holds this.
    setTimeout(() => {
      void clipboard.readText().then((text) => {
        copied = { at: Date.now(), text }
      })
    }, 50)
  })
  onSettingsWritten((settings) => {
    const keyRing = servicesOpen() ? services().keyRing : null
    if (!keyRing || vault.state !== 'unlocked') return
    void savePreunlock(preunlockPath, settings, keyRing).then(async () => {
      prefs = await lockScreenPrefs(preunlockPath)
      idle.start(idleMs())
    })
  })
  let lockTriggersArmed = false
  function armLockTriggers(): void {
    if (lockTriggersArmed) return
    lockTriggersArmed = true
    powerMonitor.on('suspend', () => {
      if (locksOnSleep(sessionPolicy(), prefs?.lockOnSleep)) void lock('sleep')
    })
    powerMonitor.on('lock-screen', () => {
      if (locksOnScreenLock(sessionPolicy(), prefs?.lockOnScreenLock)) void lock('screen')
    })
    screenLock = startScreenLockMonitor(() => {
      if (locksOnScreenLock(sessionPolicy(), prefs?.lockOnScreenLock)) void lock('screen')
    })
  }
  if (encrypted()) armLockTriggers()

  rebuildMenu()
  syncMenuChecks()
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  app.on('window-all-closed', () => {
    // S-9: closing the self-test error screen is quitting, on every platform.
    if (vault.state === 'selftest-failed') return void app.quit()
    // The lock replaces the window (§15 N6); that close is not the user quitting.
    if (vault.state === 'locking') return
    if (process.platform !== 'darwin') app.quit()
  })
  // One orderly shutdown, entered once: a lock in progress finishes, the socket's last request
  // finishes, then every handle closes before any window does. Quitting while a lock was still
  // swapping windows and closing databases made Electron segfault (node::AsyncWrap::~AsyncWrap).
  // app.exit then closes the windows without another round of quit events.
  async function shutdown(): Promise<void> {
    await locking?.catch(() => {})
    await stopMcp().catch(() => {})
    idle.stop()
    screenLock.stop()
    updates?.stop()
    throttledRefusals.ended()
    const keyRing = servicesOpen() ? services().keyRing : null
    if (servicesOpen()) {
      await services().stopSync().catch(() => {})
      closeServices()
    }
    const handlesBefore = liveHandles()
    keyRing?.close()
    migration.discard()
    if (keyRing) securityEvent.locked({ trigger: 'quit', destroyedHandles: Math.max(0, handlesBefore - liveHandles()) })
    releaseLock()
  }
  app.on('before-quit', (event) => {
    event.preventDefault()
    if (busy.running) {
      quitAfterMigration = true
      return
    }
    quitting ??= shutdown()
      .catch((e) => log.error('app', 'shutdown failed', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => app.exit(0))
  })
})

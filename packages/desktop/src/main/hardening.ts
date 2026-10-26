import { app, session, type WebContents } from 'electron'
import { log } from './log/logger'
import { openExternalSafe } from './openExternal'

/**
 * Electron boundary rules (audit §4.4 B-1, B-3), installed before the first window and checked by
 * the window factory (`createWindow` in windows.ts refuses to run without them). The only file that
 * sets navigation, window-open and permission handlers (lint rule `slate/web-contents-guards-in-hardening`).
 */

/** What a guard needs from a webContents; tests pass a fake. */
export type GuardableWebContents = Pick<WebContents, 'on' | 'setWindowOpenHandler' | 'loadURL'>

/** A URL a window may hand to the user's browser (openExternalSafe still refuses all but https and mailto). */
const EXTERNAL = /^(?:https?:\/\/|mailto:)/i

/**
 * Only Slate's own page loads in a Slate window: a remote page would get the preload and the vault
 * IPC. Navigation away is cancelled, a new window is never opened (links go to the browser), and
 * `<webview>` is refused.
 */
export function guardWebContents(wc: GuardableWebContents, isApp: (url: string) => boolean, openExternal: (url: string) => Promise<unknown> = openExternalSafe): void {
  const toBrowser = (url: string) => {
    if (EXTERNAL.test(url)) void openExternal(url).catch(() => log.warn('app', 'could not open a link in the browser'))
  }
  const stayOnApp = (event: { preventDefault(): void }, url: string): boolean => {
    if (isApp(url)) return false
    event.preventDefault()
    log.warn('app', 'navigation away from Slate blocked')
    return true
  }
  // A link the page follows (a click, `location.href = …`) opens in the browser instead. For the
  // main frame will-frame-navigate fires first; will-navigate stays as the second line. about:blank
  // and about:srcdoc get past both (they commit without a request): the did-navigate / did-fail-load
  // backstop below brings the window back.
  wc.on('will-frame-navigate', (event) => {
    if (stayOnApp(event, event.url) && event.isMainFrame) toBrowser(event.url)
  })
  wc.on('will-navigate', (event, url) => {
    if (stayOnApp(event, url)) toBrowser(url)
  })
  wc.on('will-redirect', (event, url) => void stayOnApp(event, url))
  // Backstop (review M1): a main frame that still lands off Slate, or on an error page, goes back to
  // the last Slate page it showed. Its preload is refused by the IPC sender check meanwhile.
  let lastAppUrl: string | null = null
  const backHome = (url: string) => {
    if (isApp(url)) {
      lastAppUrl = url
      return
    }
    if (lastAppUrl === null) return
    log.warn('app', 'a Slate window left Slate; reloading it')
    void wc.loadURL(lastAppUrl).catch(() => log.warn('app', 'could not reload Slate after a blocked navigation'))
  }
  wc.on('did-navigate', (_event, url) => backHome(url))
  wc.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
    if (isMainFrame && !isApp(url)) backHome(url)
  })
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    toBrowser(url)
    return { action: 'deny' }
  })
}

let contentsGuarded = false
let permissionsSet = false

/** Where the guards are installed: Electron's app and default session; tests pass fakes. */
export interface BoundaryHost {
  app: Pick<typeof app, 'on'>
  session: Pick<Electron.Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'>
}

const electronHost = (): BoundaryHost => ({ app, session: session.defaultSession })

/** Guards every webContents the app ever creates (B-1), before the first window. */
export function installWebContentsGuards(isApp: (url: string) => boolean, host: Pick<BoundaryHost, 'app'> = electronHost()): void {
  host.app.on('web-contents-created', (_e, wc) => guardWebContents(wc, isApp))
  contentsGuarded = true
}

/** Slate's renderer needs none of camera, microphone, notifications, geolocation, HID, serial… (B-3). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/** Deny-by-default permission handlers over `allowed`; tests call them directly. */
export function permissionHandlers(allowed: ReadonlySet<string>) {
  return {
    request: (_wc: unknown, permission: string, callback: (granted: boolean) => void) => callback(allowed.has(permission)),
    check: (_wc: unknown, permission: string) => allowed.has(permission),
    device: () => false,
  }
}

/** Installs the permission policy on the default session (every Slate window uses it). */
export function installPermissionPolicy(allowed: ReadonlySet<string> = ALLOWED_PERMISSIONS, host: Pick<BoundaryHost, 'session'> = electronHost()): void {
  const h = permissionHandlers(allowed)
  const s = host.session
  s.setPermissionRequestHandler((wc, permission, callback) => h.request(wc, permission, callback))
  s.setPermissionCheckHandler((wc, permission) => h.check(wc, permission))
  s.setDevicePermissionHandler(() => h.device())
  permissionsSet = true
}

/** Both guards at once: what index.ts calls before the first window. */
export function installBoundaryGuards(isApp: (url: string) => boolean, host: BoundaryHost = electronHost()): void {
  installWebContentsGuards(isApp, host)
  installPermissionPolicy(ALLOWED_PERMISSIONS, host)
}

/** True once `installBoundaryGuards` has run; the window factory refuses to open a window before. */
export function boundaryGuardsInstalled(): boolean {
  return contentsGuarded && permissionsSet
}

import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { ChromeOptions } from '../shared/windowChrome/chrome'
import { appUrl, devServerOrigin, pageQuery, type PageKind } from './appProtocol'
import { boundaryGuardsInstalled } from './hardening'
import { env } from './testHooks'

/**
 * The window factory: the only `new BrowserWindow` (lint rule `slate/windows-from-the-factory`).
 * Every window gets the preload, the sandbox and context isolation from here, and the e2e
 * hidden-window rule.
 */
export interface WindowSpec {
  backgroundColor: string
  /** Title-bar options from src/shared/windowChrome; they cannot touch webPreferences. */
  chrome?: ChromeOptions
  iconPath: string
  preloadPath: string
  isE2E: boolean
}

export function windowOptions({ backgroundColor, chrome = {}, iconPath, preloadPath, isE2E }: WindowSpec): BrowserWindowConstructorOptions {
  const { webPreferences: _ignored, ...titleBar } = chrome as ChromeOptions & { webPreferences?: unknown }
  return {
    width: 1280,
    height: 860,
    show: false,
    title: 'Slate',
    backgroundColor,
    ...titleBar,
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !isE2E,
    },
  }
}

/** The webContents of every window this factory made. */
const made = new WeakSet<object>()

/** Whether `webContents` belongs to a window this factory made (ipcGuard trusts its preload before the page commits). */
export function isSlateWindow(webContents: unknown): boolean {
  return typeof webContents === 'object' && webContents !== null && made.has(webContents)
}

let errorPage: (() => { selfTestFailed: string } | null) | null = null

/**
 * Review C6 (S-6, S-9): index.ts pins the self-test error screen here. Once it answers a page, every window opened
 * or reloaded shows that page whatever its caller asked for, so a lock, a reload, a second instance or the dock
 * still in flight cannot replace the error screen.
 */
export function pinErrorPage(page: (() => { selfTestFailed: string } | null) | null): void {
  errorPage = page
}

export function pageFor(asked: PageKind): PageKind {
  return errorPage?.() ?? asked
}

/** Opens a window on the app page (or the lock screen, `?lock=1`, or the self-test error screen). */
export function createWindow(spec: WindowSpec, lockScreen: PageKind): BrowserWindow {
  // A window without the navigation and permission guards could be steered to a remote page that keeps the preload.
  if (!boundaryGuardsInstalled()) throw new Error('Call installBoundaryGuards (src/main/hardening.ts) before opening a window')
  const win = new BrowserWindow(windowOptions(spec))
  made.add(win.webContents)
  // E2E runs keep the window hidden so tests never pop windows onto the user's screen. CI shows it
  // on its virtual display (SLATE_E2E_SHOW): on X11 a window never shown gets almost no frames, and
  // typing there waited on them (500 ms a key, with the renderer idle).
  if (!spec.isE2E || env('SLATE_E2E_SHOW') === '1') win.once('ready-to-show', () => win.show())
  loadPage(win, lockScreen)
  return win
}

/** The lock screen is the same page with `?lock=1`, the self-test error screen with `?selftest-failed=<id>`; neither calls note IPC. */
export function loadPage(win: BrowserWindow, lockScreen: PageKind): void {
  const page = pageFor(lockScreen)
  const raw = env('ELECTRON_RENDERER_URL')
  const devUrl = devServerOrigin(app.isPackaged, raw) === null ? undefined : raw
  if (devUrl) void win.loadURL(devUrl + pageQuery(page))
  else void win.loadURL(appUrl(page))
}

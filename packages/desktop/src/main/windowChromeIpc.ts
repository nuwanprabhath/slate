import { BrowserWindow, Menu, type KeyboardEvent, type MenuItem, type WebContents } from 'electron'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'
import { isMenuPath, isObject } from '../shared/ipcValidators'
import type { ChromeColors, WindowChrome } from '../shared/windowChrome/chrome'
import { itemAtPath, serializeMenu, setChromeColors, toggleMaximize } from './windowChrome'

const isColors = (value: unknown): value is ChromeColors => isObject(value)

export function registerChromeIpc(ipc: IpcRegistrar, chrome: WindowChrome): void {
  ipc.on(CH.chromeKind, (e) => {
    e.returnValue = chrome
  })
  // A `send` has no reply to refuse with, so a malformed payload is dropped.
  ipc.on(CH.chromeSetColors, (e, colors: unknown) => {
    if (!isColors(colors)) return
    if (chrome === 'overlay') setChromeColors(process.platform, BrowserWindow.fromWebContents(e.sender), colors)
  })
  ipc.on(CH.chromeToggleMaximize, (e) => toggleMaximize(BrowserWindow.fromWebContents(e.sender)))
  ipc.handle(CH.chromeMenu, () => serializeMenu(Menu.getApplicationMenu()?.items ?? []))
  // Clicks the very item the native menu would, so a role (Copy, Quit, Toggle DevTools) behaves as it always did.
  ipc.on(CH.chromeInvokeMenu, (e, path: unknown) => {
    if (!isMenuPath(path)) return
    const item = itemAtPath<MenuItem>(Menu.getApplicationMenu()?.items ?? [], path)
    if (!item || !item.enabled || (item.submenu && item.submenu.items.length > 0)) return
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    // Electron types `click` as a bare Function; this is the signature it calls it with.
    const click = item.click as (event: KeyboardEvent, window?: BrowserWindow, contents?: WebContents) => void
    click({ triggeredByAccelerator: false }, win, e.sender)
  })
}

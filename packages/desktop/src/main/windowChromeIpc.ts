import { BrowserWindow, ipcMain, Menu, type KeyboardEvent, type MenuItem, type WebContents } from 'electron'
import { CH } from '../shared/ipc'
import type { ChromeColors, WindowChrome } from '../shared/windowChrome/chrome'
import { itemAtPath, serializeMenu, setChromeColors, toggleMaximize } from './windowChrome'

export function registerChromeIpc(chrome: WindowChrome): void {
  ipcMain.on(CH.chromeKind, (e) => {
    e.returnValue = chrome
  })
  ipcMain.on(CH.chromeSetColors, (e, colors: ChromeColors) => {
    if (chrome === 'overlay') setChromeColors(process.platform, BrowserWindow.fromWebContents(e.sender), colors)
  })
  ipcMain.on(CH.chromeToggleMaximize, (e) => toggleMaximize(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(CH.chromeMenu, () => serializeMenu(Menu.getApplicationMenu()?.items ?? []))
  // Clicks the very item the native menu would, so a role (Copy, Quit, Toggle DevTools) behaves as it always did.
  ipcMain.on(CH.chromeInvokeMenu, (e, path: number[]) => {
    const item = itemAtPath<MenuItem>(Menu.getApplicationMenu()?.items ?? [], path)
    if (!item || !item.enabled || (item.submenu && item.submenu.items.length > 0)) return
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    // Electron types `click` as a bare Function; this is the signature it calls it with.
    const click = item.click as (event: KeyboardEvent, window?: BrowserWindow, contents?: WebContents) => void
    click({ triggeredByAccelerator: false }, win, e.sender)
  })
}

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/api'
import { CH } from '../shared/ipc'
import { readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(CH.menu, command)
}

export function buildMenu(store: DocStore): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        // Keystrokes go to the page (the editor keymap handles them); the menu entries are for mouse use.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send({ cmd: 'undo' }) },
        { label: 'Redo', accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => send({ cmd: 'redo' }) },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste as Plain Text', accelerator: 'CmdOrCtrl+Shift+V', registerAccelerator: false, click: () => send({ cmd: 'paste-plain' }) },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'markdown-shortcuts',
          label: 'Markdown Shortcuts',
          type: 'checkbox',
          checked: readSettings(store).markdownShortcuts,
          click: (item) => send({ cmd: 'settings-changed', settings: writeSettings(store, { markdownShortcuts: item.checked }) }),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

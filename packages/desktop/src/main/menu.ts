import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/api'
import { CH } from '../shared/ipc'
import { readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(CH.menu, command)
}

/** "Check for Updates…" sits in the app menu on macOS and in Help elsewhere. */
export function buildMenu(store: DocStore, onCheckForUpdates: () => void): void {
  const isMac = process.platform === 'darwin'
  const checkUpdates: MenuItemConstructorOptions = { id: 'check-updates', label: 'Check for Updates…', click: onCheckForUpdates }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: 'appMenu' as const,
            submenu: [
              { role: 'about' as const },
              checkUpdates,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { id: 'import-onenote', label: 'Import from OneNote…', click: () => send({ cmd: 'show-import' }) },
        { id: 'import-onenote-backup', label: 'Import from OneNote backup…', click: () => send({ cmd: 'show-import-backup' }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
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
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send({ cmd: 'find' }) },
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
        { id: 'ai-activity', label: 'AI Activity…', click: () => send({ cmd: 'show-ai-activity' }) },
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
    {
      role: 'help',
      submenu: [
        { id: 'connect-agents', label: 'Connect AI agents…', click: () => send({ cmd: 'show-connect-agents' }) },
        ...(isMac ? [] : [checkUpdates]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

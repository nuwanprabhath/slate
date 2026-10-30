import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, Settings } from '../shared/api'
import { DEFAULT_SETTINGS } from '../shared/settings/schema'
import { CH } from '../shared/ipc'
import { DEFAULT_THEME_ID } from '../shared/theme/builtins'
import { onSettingsWritten, readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(CH.menu, command)
}

export interface MenuOptions {
  /** The open notes' store, or null while the vault is locked; read at build and at click time. */
  store: () => DocStore | null
  onCheckForUpdates: () => void
  /** Present for an unlocked encrypted vault: enables "Lock Slate". */
  onLock?: () => void
}

/**
 * "Check for Updates…" sits in the app menu on macOS and in Help elsewhere. Rebuilt whenever the
 * vault locks or unlocks, so items that need notes are disabled while locked (§6.3).
 */
export function buildMenu({ store: open, onCheckForUpdates, onLock }: MenuOptions): void {
  const isMac = process.platform === 'darwin'
  const notes = open() !== null
  const settings = (() => {
    const s = open()
    return s ? readSettings(s) : DEFAULT_SETTINGS
  })()
  const write = (patch: Partial<Settings>) => {
    const s = open()
    if (s) writeSettings(s, patch)
  }
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
              { id: 'settings', label: 'Settings…', accelerator: 'Cmd+,', enabled: notes, click: () => send({ cmd: 'show-settings' }) },
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
        { id: 'import-onenote', label: 'Import from OneNote…', enabled: notes, click: () => send({ cmd: 'show-import' }) },
        { id: 'import-onenote-backup', label: 'Import from OneNote backup…', enabled: notes, click: () => send({ cmd: 'show-import-backup' }) },
        { type: 'separator' },
        // The key is handled in before-input-event (main/index.ts), which also sees it in a hidden window.
        { id: 'lock', label: 'Lock Slate', accelerator: 'CmdOrCtrl+Shift+L', registerAccelerator: false, enabled: !!onLock, click: () => onLock?.() },
        { type: 'separator' },
        ...(isMac ? [] : [{ id: 'settings', label: 'Settings…', accelerator: 'Ctrl+,', enabled: notes, click: () => send({ cmd: 'show-settings' }) }, { type: 'separator' as const }]),
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
        { id: 'copy-markdown', label: 'Copy as Markdown', accelerator: 'CmdOrCtrl+Alt+Shift+C', registerAccelerator: false, click: () => send({ cmd: 'copy-markdown' }) },
        { role: 'paste' },
        { label: 'Paste as Plain Text', accelerator: 'CmdOrCtrl+Shift+V', registerAccelerator: false, click: () => send({ cmd: 'paste-plain' }) },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Insert Link…', accelerator: 'CmdOrCtrl+K', registerAccelerator: false, click: () => send({ cmd: 'link' }) },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send({ cmd: 'find' }) },
        { id: 'find-in-notes', label: 'Find in Notes…', accelerator: 'CmdOrCtrl+Shift+F', enabled: notes, click: () => send({ cmd: 'find-in-notes' }) },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'markdown-shortcuts',
          label: 'Markdown Shortcuts',
          type: 'checkbox',
          enabled: notes,
          checked: settings.markdownShortcuts,
          click: (item) => write({ markdownShortcuts: item.checked }),
        },
        {
          id: 'auto-bullets',
          label: 'Auto Bullets',
          type: 'checkbox',
          enabled: notes,
          checked: settings.autoBullets,
          click: (item) => write({ autoBullets: item.checked }),
        },
        { id: 'ai-activity', label: 'AI Activity…', enabled: notes, click: () => send({ cmd: 'show-ai-activity' }) },
        // The way back from a theme that makes the window hard to use.
        { id: 'reset-theme', label: 'Reset Theme', accelerator: 'CmdOrCtrl+Alt+Shift+T', enabled: notes, click: () => write({ themeId: DEFAULT_THEME_ID, followSystem: false }) },
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
        { id: 'connect-agents', label: 'Connect AI agents…', enabled: notes, click: () => send({ cmd: 'show-connect-agents' }) },
        ...(isMac ? [] : [checkUpdates]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Keeps the View menu's checkboxes in step with settings changed elsewhere (the Settings dialog). */
export function syncMenuChecks(): () => void {
  return onSettingsWritten((settings) => {
    const menu = Menu.getApplicationMenu()
    const markdown = menu?.getMenuItemById('markdown-shortcuts')
    const bullets = menu?.getMenuItemById('auto-bullets')
    if (markdown) markdown.checked = settings.markdownShortcuts
    if (bullets) bullets.checked = settings.autoBullets
  })
}

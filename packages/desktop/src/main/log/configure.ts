import { app, clipboard, ipcMain, shell } from 'electron'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../../shared/ipc'
import type { DiagnosticsStatus, RendererErrorReport, Settings } from '../../shared/api'
import { logHandlers } from './ipcLog'
import { log } from './logger'

/**
 * Points the logger at this installation's log folder. Separate from `logger.ts` so that module
 * stays free of Electron and its tests run in plain Node.
 */
export function configureLogging(settings: Pick<Settings, 'debugLog'>): void {
  const wasOn = log.enabled
  log.configure({ enabled: settings.debugLog, dir: join(app.getPath('userData'), 'logs'), maxSizeMb: 20, home: homedir() })
  // Each start with the log on, and the moment it is switched on, says which build wrote it.
  if (log.enabled && !wasOn) {
    log.info('app', 'diagnostic log on', { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron })
  }
}

/** Makes every `ipcMain.handle` handler registered after this log its rejections. Call once, before registering. */
export function logIpcRejections(): void {
  const wrapped = logHandlers({ handle: ipcMain.handle.bind(ipcMain) }, log)
  ipcMain.handle = wrapped.handle as typeof ipcMain.handle
}

function status(): DiagnosticsStatus {
  let bytes = 0
  try { bytes = statSync(log.file).size } catch { /* not written yet */ }
  return { enabled: log.enabled, file: join(app.getPath('userData'), 'logs', 'slate.log'), bytes }
}

/** A renderer report is reduced again here: names and stack frames only, never a message. */
function rendererError(report: RendererErrorReport): void {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
  const frames = Array.isArray(report.frames) ? report.frames.slice(0, 12).map((f) => text(f, 300)) : []
  log.error('renderer', report.kind === 'unhandledrejection' ? 'unhandled rejection' : 'uncaught error', { name: text(report.name, 80), frames })
}

export function registerDiagnosticsIpc(): void {
  ipcMain.handle(CH.diagnosticsStatus, () => status())
  ipcMain.handle(CH.diagnosticsRead, () => log.read())
  ipcMain.handle(CH.diagnosticsCopy, () => {
    const text = log.read()
    clipboard.writeText(text)
    return text.length
  })
  ipcMain.handle(CH.diagnosticsClear, () => log.clear())
  ipcMain.handle(CH.diagnosticsOpenFolder, () => {
    // Showing the file selects it; before anything is written there is only the user-data folder.
    const file = status().file
    try { statSync(file); shell.showItemInFolder(file) } catch { void shell.openPath(app.getPath('userData')) }
  })
  ipcMain.handle(CH.diagnosticsRendererError, (_e, report: RendererErrorReport) => rendererError(report))
}

import { app, clipboard } from 'electron'
import { openLocalPath, revealInFolder } from '../openExternal'
import type { IpcRegistrar } from '../ipcGuard'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../../shared/ipc'
import type { DiagnosticsStatus, RendererErrorReport, Settings } from '../../shared/api'
import { log, securityLog } from './logger'

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

/**
 * The security log (audit AU-2): on from the first line of main, whatever the diagnostic switch says. 2 MB across
 * a few archives, kept 90 days, in a folder of its own inside the data folder.
 */
export function configureSecurityLog(): void {
  securityLog.configure({ enabled: true, dir: join(app.getPath('userData'), 'security-log'), maxSizeMb: 2, retentionDays: 90, home: homedir() })
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

export function registerDiagnosticsIpc(ipc: IpcRegistrar): void {
  ipc.handle(CH.diagnosticsStatus, () => status())
  ipc.handle(CH.diagnosticsRead, () => log.read())
  ipc.handle(CH.diagnosticsCopy, async () => {
    const text = log.read()
    await clipboard.writeText(text)
    return text.length
  })
  ipc.handle(CH.diagnosticsClear, () => log.clear())
  ipc.handle(CH.diagnosticsOpenFolder, () => {
    // Showing the file selects it; before anything is written there is only the user-data folder.
    const file = status().file
    try { statSync(file); revealInFolder(file) } catch { void openLocalPath(app.getPath('userData')) }
  })
  ipc.handle(CH.diagnosticsRendererError, (_e, report: RendererErrorReport) => rendererError(report))
}

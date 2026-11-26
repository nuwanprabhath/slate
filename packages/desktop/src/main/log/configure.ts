import { app, clipboard } from 'electron'
import { openLocalPath, revealInFolder } from '../openExternal'
import type { IpcRegistrar } from '../ipcGuard'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CH } from '../../shared/ipc'
import type { DiagnosticsStatus, RendererErrorReport, Settings } from '../../shared/api'
import { isRendererErrorReport, refuse } from '../../shared/ipcValidators'
import { log, securityLog } from './logger'
import { logPqState, type PqDiagnostics } from './pqState'

/**
 * Points the logger at this installation's log folder. Separate from `logger.ts` so that module
 * stays free of Electron and its tests run in plain Node. Switching the log off in strict mode
 * deletes it (GDPR-13); otherwise its files are kept and still pruned by age.
 */
export function configureLogging(settings: Pick<Settings, 'debugLog'> & Partial<Pick<Settings, 'gdprStrictMode'>>): void {
  const wasOn = log.enabled
  log.configure({ enabled: settings.debugLog, dir: join(app.getPath('userData'), 'logs'), maxSizeMb: 20, home: homedir() })
  if (wasOn && !log.enabled && settings.gdprStrictMode === true) log.purgeAll()
  // Each start with the log on, and the moment it is switched on, says which build wrote it.
  if (log.enabled && !wasOn) {
    log.info('app', 'diagnostic log on', { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron })
  }
}

/**
 * The security log (audit AU-2): on from the first line of main, whatever the diagnostic switch says. 2 MB across
 * a few archives, kept 90 days until the notes open and `applySecurityLogRetention` knows the profile.
 */
export function configureSecurityLog(retentionDays = 90): void {
  securityLog.configure({ enabled: true, dir: join(app.getPath('userData'), 'security-log'), maxSizeMb: 2, retentionDays, home: homedir() })
}

/**
 * GDPR-08: the security log's retention for the open notes. fips-140-3 keeps 90 days (the AU-2 record); otherwise
 * strict mode keeps 30, which is long enough to look back over a month of unlocks, and the rest 90.
 */
export function applySecurityLogRetention(profile: 'standard' | 'fips-140-3' | null, strict: boolean): void {
  configureSecurityLog(profile !== 'fips-140-3' && strict ? 30 : 90)
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

/** `pqState` supplies the post-quantum fields; reading or copying the log first adds one line with them (PQ-D3). */
export function registerDiagnosticsIpc(ipc: IpcRegistrar, pqState: () => Promise<PqDiagnostics>): void {
  const withPqState = async (): Promise<string> => {
    if (log.enabled) {
      try {
        logPqState(log.scoped('app'), await pqState())
      } catch {
        // The log never breaks the app: without the line the export is still the log.
      }
    }
    return log.read()
  }
  ipc.handle(CH.diagnosticsStatus, () => status())
  ipc.handle(CH.diagnosticsRead, () => withPqState())
  ipc.handle(CH.diagnosticsCopy, async () => {
    const text = await withPqState()
    await clipboard.writeText(text)
    return text.length
  })
  ipc.handle(CH.diagnosticsClear, () => log.clear())
  ipc.handle(CH.diagnosticsOpenFolder, () => {
    // Showing the file selects it; before anything is written there is only the user-data folder.
    const file = status().file
    try { statSync(file); revealInFolder(file) } catch { void openLocalPath(app.getPath('userData')) }
  })
  ipc.handle(CH.diagnosticsRendererError, (_e, report: unknown) => {
    if (!isRendererErrorReport(report)) refuse(CH.diagnosticsRendererError)
    rendererError(report)
  })
}

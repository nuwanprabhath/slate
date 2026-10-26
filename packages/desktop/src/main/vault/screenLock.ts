import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/** `GetSessionByPID`'s reply, `(objectpath '/org/freedesktop/login1/session/_32',)`. */
export function parseSessionPath(output: string): string | null {
  return /objectpath '([^']+)'/.exec(output)?.[1] ?? null
}

/**
 * One `gdbus monitor` line → true (locked), false (unlocked) or null (not ours). logind's
 * `LockedHint` counts only on our own session; the screensavers' `ActiveChanged` is per user session.
 */
export function parseMonitorLine(line: string, sessionPath: string | null): boolean | null {
  const hint = /^(\S+): org\.freedesktop\.DBus\.Properties\.PropertiesChanged .*'LockedHint': <(true|false)>/.exec(line)
  if (hint) return hint[1] === sessionPath ? hint[2] === 'true' : null
  const saver = /org\.(?:gnome|freedesktop)\.ScreenSaver\.ActiveChanged \((true|false),\)/.exec(line)
  return saver ? saver[1] === 'true' : null
}

export interface ScreenLockMonitor {
  /** False when nothing could watch for the screen lock (Linux without `gdbus`). */
  detected: boolean
  stop(): void
}

/** macOS and Windows use powerMonitor's `lock-screen`; Linux watches D-Bus (§15 N7). */
export function startScreenLockMonitor(onLock: () => void, platform: string = process.platform): ScreenLockMonitor {
  if (platform !== 'linux') return { detected: true, stop: () => {} }
  if (spawnSync('gdbus', ['help'], { stdio: 'ignore' }).error) return { detected: false, stop: () => {} }
  const children: ChildProcess[] = []
  let stopped = false
  const watch = (args: string[], session: string | null) => {
    if (stopped) return
    const child = spawn('gdbus', ['monitor', ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.on('error', () => {})
    children.push(child)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (parseMonitorLine(line, session) === true) onLock()
    })
  }
  execFile(
    'gdbus',
    ['call', '--system', '--dest', 'org.freedesktop.login1', '--object-path', '/org/freedesktop/login1', '--method', 'org.freedesktop.login1.Manager.GetSessionByPID', String(process.pid)],
    (err, stdout) => {
      const session = err ? null : parseSessionPath(stdout)
      if (session) watch(['--system', '--dest', 'org.freedesktop.login1', '--object-path', session], session)
    },
  )
  watch(['--session', '--dest', 'org.gnome.ScreenSaver'], null)
  watch(['--session', '--dest', 'org.freedesktop.ScreenSaver'], null)
  return {
    detected: true,
    stop: () => {
      stopped = true
      for (const c of children) c.kill()
    },
  }
}

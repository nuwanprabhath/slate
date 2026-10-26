import { describe, expect, it } from 'vitest'
import { parseMonitorLine, parseSessionPath } from './screenLock'

describe('Linux screen-lock monitor (§15 N7)', () => {
  const session = '/org/freedesktop/login1/session/_32'

  it('reads our session path from GetSessionByPID', () => {
    expect(parseSessionPath(`(objectpath '${session}',)\n`)).toBe(session)
    expect(parseSessionPath('Error: GDBus.Error:org.freedesktop.login1.NoSessionForPID')).toBeNull()
  })

  it("sees logind's LockedHint on our session only", () => {
    const line = (path: string, v: string) =>
      `${path}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <${v}>}, @as [])`
    expect(parseMonitorLine(line(session, 'true'), session)).toBe(true)
    expect(parseMonitorLine(line(session, 'false'), session)).toBe(false)
    expect(parseMonitorLine(line('/org/freedesktop/login1/session/_7', 'true'), session)).toBeNull()
  })

  it('sees the session-bus screensaver signals', () => {
    expect(parseMonitorLine('/org/gnome/ScreenSaver: org.gnome.ScreenSaver.ActiveChanged (true,)', null)).toBe(true)
    expect(parseMonitorLine('/org/freedesktop/ScreenSaver: org.freedesktop.ScreenSaver.ActiveChanged (false,)', null)).toBe(false)
    expect(parseMonitorLine('/org/gnome/Shell: org.gnome.Shell.Something (true,)', null)).toBeNull()
  })
})

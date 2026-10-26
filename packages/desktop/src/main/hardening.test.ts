import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { APP_ENTRY, isAppUrl } from './appProtocol'
import { ALLOWED_PERMISSIONS, boundaryGuardsInstalled, guardWebContents, installBoundaryGuards, permissionHandlers, type BoundaryHost, type GuardableWebContents } from './hardening'

/** A webContents stand-in: records the window-open handler and lets a test emit navigation events. */
function fakeContents() {
  const emitter = new EventEmitter()
  let openHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null = null
  const loads: string[] = []
  const wc = {
    on: (event: string, listener: (...args: unknown[]) => void) => void emitter.on(event, listener),
    setWindowOpenHandler: (h: (details: { url: string }) => { action: 'allow' | 'deny' }) => void (openHandler = h),
    loadURL: async (url: string) => void loads.push(url),
  } as unknown as GuardableWebContents
  /** Emits `event` with a cancellable event object; resolves whether a listener cancelled it. */
  const emit = (event: string, url = '', isMainFrame = false): boolean => {
    let prevented = false
    emitter.emit(event, { url, isMainFrame, preventDefault: () => void (prevented = true) }, url)
    return prevented
  }
  /** A main-frame commit (`did-navigate`) or failed load (`did-fail-load`) at `url`. */
  const landed = (url: string) => emitter.emit('did-navigate', {}, url)
  const failed = (url: string, isMainFrame = true) => emitter.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, isMainFrame)
  return { wc, emit, landed, failed, loads, open: (url: string) => openHandler!({ url }) }
}

describe('guardWebContents (B-1)', () => {
  const setup = () => {
    const opened: unknown[] = []
    const c = fakeContents()
    guardWebContents(c.wc, (u) => isAppUrl(u), async (u) => void opened.push(u))
    return { ...c, opened }
  }

  it('cancels navigation and redirects to anything but Slate itself', () => {
    const { emit } = setup()
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      for (const url of ['https://example.invalid/', 'file:///tmp/other.html', 'javascript:alert(1)', 'app://evil/']) expect(emit(event, url), `${event} ${url}`).toBe(true)
      expect(emit(event, APP_ENTRY), event).toBe(false)
      expect(emit(event, `${APP_ENTRY}?lock=1`), event).toBe(false)
    }
  })

  it('hands a blocked navigation to a web or mail link to the external opener (red team R1)', async () => {
    const { emit, opened } = setup()
    emit('will-navigate', 'https://example.invalid/page')
    emit('will-navigate', 'file:///etc/passwd')
    emit('will-redirect', 'https://example.invalid/redirected')
    emit('will-navigate', APP_ENTRY)
    await Promise.resolve()
    expect(opened).toEqual(['https://example.invalid/page'])
  })

  it('never opens a window: https and mailto go to the external opener, everything else nowhere', async () => {
    const { open, opened } = setup()
    for (const url of ['https://example.invalid/', 'mailto:a@b.c', 'http://example.invalid/', 'file:///etc/passwd', APP_ENTRY, 'javascript:1']) expect(open(url)).toEqual({ action: 'deny' })
    await Promise.resolve()
    // The opener itself refuses what openExternalSafe refuses; here it saw only what the guard passed on.
    expect(opened).toEqual(['https://example.invalid/', 'mailto:a@b.c', 'http://example.invalid/'])
  })

  it('review M1: a main-frame navigation off Slate is cancelled there too, and a URL to the web goes to the browser', async () => {
    const { emit, opened } = setup()
    for (const url of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'https://example.invalid/m']) expect(emit('will-frame-navigate', url, true), url).toBe(true)
    expect(emit('will-frame-navigate', APP_ENTRY, true)).toBe(false)
    await Promise.resolve()
    expect(opened).toEqual(['https://example.invalid/m'])
  })

  it('review M1: a main frame that still lands off Slate (about:blank, an error page) is sent back to the last Slate page', () => {
    const c = fakeContents()
    guardWebContents(c.wc, (u) => isAppUrl(u), async () => {})
    c.landed(`${APP_ENTRY}?lock=1`)
    c.landed('about:blank')
    c.failed('about:srcdoc')
    c.failed('https://example.invalid/', false)
    c.landed(APP_ENTRY)
    expect(c.loads).toEqual([`${APP_ENTRY}?lock=1`, `${APP_ENTRY}?lock=1`])
  })

  it('cancels every <webview>', () => {
    expect(setup().emit('will-attach-webview')).toBe(true)
  })
})

describe('permissionHandlers (B-3)', () => {
  const h = permissionHandlers(ALLOWED_PERMISSIONS)

  it('denies camera, microphone, notifications, geolocation and devices; allows only the sanitized clipboard write', () => {
    const asked = (permission: string) => {
      let answer: boolean | null = null
      h.request(null, permission, (granted) => void (answer = granted))
      return answer
    }
    for (const p of ['media', 'notifications', 'geolocation', 'midiSysex', 'clipboard-read', 'openExternal', 'hid', 'serial', 'usb', 'display-capture']) {
      expect(asked(p), p).toBe(false)
      expect(h.check(null, p), p).toBe(false)
    }
    expect(asked('clipboard-sanitized-write')).toBe(true)
    expect(h.check(null, 'clipboard-sanitized-write')).toBe(true)
    expect(h.device()).toBe(false)
    expect([...ALLOWED_PERMISSIONS]).toEqual(['clipboard-sanitized-write'])
  })
})

describe('installBoundaryGuards wiring (review L4)', () => {
  it('guards every webContents the app creates and sets all three permission handlers on the session', () => {
    const appListeners = new Map<string, (...args: unknown[]) => void>()
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const host: BoundaryHost = {
      app: { on: (event: string, listener: (...args: unknown[]) => void) => void appListeners.set(event, listener) },
      session: {
        setPermissionRequestHandler: (h: (...args: unknown[]) => unknown) => void (handlers.request = h),
        setPermissionCheckHandler: (h: (...args: unknown[]) => unknown) => void (handlers.check = h),
        setDevicePermissionHandler: (h: (...args: unknown[]) => unknown) => void (handlers.device = h),
      },
    } as unknown as BoundaryHost
    expect(boundaryGuardsInstalled()).toBe(false)
    installBoundaryGuards((u) => isAppUrl(u), host)
    expect(boundaryGuardsInstalled()).toBe(true)

    const c = fakeContents()
    appListeners.get('web-contents-created')!({}, c.wc)
    expect(c.emit('will-navigate', 'https://example.invalid/')).toBe(true)
    expect(c.open('https://example.invalid/')).toEqual({ action: 'deny' })

    let granted: boolean | null = null
    handlers.request!(null, 'media', (g: boolean) => void (granted = g))
    expect(granted).toBe(false)
    expect(handlers.check!(null, 'media', 'app://slate', {})).toBe(false)
    expect(handlers.check!(null, 'clipboard-sanitized-write', 'app://slate', {})).toBe(true)
    expect(handlers.device!({})).toBe(false)
  })
})

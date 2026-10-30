import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWindow, pageFor, pinErrorPage, windowOptions } from './windows'

describe('the window factory', () => {
  const base = { backgroundColor: '#000', iconPath: '/i.png', preloadPath: '/p.js', isE2E: false }

  it('refuses to open a window before the navigation, window-open and permission guards are installed (B-1, B-3)', () => {
    expect(() => createWindow(base, false)).toThrow(/installBoundaryGuards/)
  })

  it('every window is sandboxed and isolated, with no Node in the renderer', () => {
    const prefs = windowOptions(base).webPreferences!
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBeUndefined()
    expect(prefs.webSecurity).toBeUndefined()
    expect(prefs.preload).toBe('/p.js')
  })

  it("has Chromium's spell checker, which the session runs only while the setting is on (spellcheck.ts)", () => {
    expect(windowOptions(base).webPreferences!.spellcheck).toBe(true)
  })

  it('title-bar options cannot replace the preferences (red team 8a)', () => {
    const chrome = { titleBarStyle: 'hidden', webPreferences: { sandbox: false, nodeIntegration: true } } as never
    const prefs = windowOptions({ ...base, chrome }).webPreferences!
    expect(prefs.sandbox).toBe(true)
    expect(prefs.nodeIntegration).toBeUndefined()
  })

  it('review C6: once the self-test failed, every page any caller asks for is the error screen', () => {
    pinErrorPage(null)
    expect([pageFor(false), pageFor(true)]).toEqual([false, true])
    let failed: { selfTestFailed: string } | null = null
    pinErrorPage(() => failed)
    expect(pageFor(true)).toBe(true)
    failed = { selfTestFailed: 'POST-KBKDF' }
    // A lock in flight (the lock screen), a reload (the notes), a second instance or the dock (the default page).
    for (const asked of [true, false, { selfTestFailed: 'POST-OTHER' }] as const) expect(pageFor(asked)).toEqual({ selfTestFailed: 'POST-KBKDF' })
    pinErrorPage(null)
  })

  it('review C6: the factory and the page loader both go through pageFor, so no caller can skip it', () => {
    const src = readFileSync(join(__dirname, 'windows.ts'), 'utf8')
    expect(src).toMatch(/export function createWindow\([^)]*\)[^{]*\{[\s\S]*?loadPage\(win, lockScreen\)/)
    expect(src).toMatch(/export function loadPage\([^)]*\)[^{]*\{\n\s*const page = pageFor\(lockScreen\)/)
    expect(src.match(/\.loadURL\(/g)?.length).toBe(2)
    expect(src).not.toMatch(/\.loadURL\([^)]*lockScreen/)
  })

  it('starts hidden; e2e runs keep background throttling off', () => {
    expect(windowOptions(base).show).toBe(false)
    expect(windowOptions({ ...base, isE2E: true }).webPreferences!.backgroundThrottling).toBe(false)
  })
})

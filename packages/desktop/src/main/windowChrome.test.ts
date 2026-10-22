import { describe, expect, it, vi } from 'vitest'
import { TITLE_BAR_HEIGHT } from '../shared/windowChrome/chrome'
import { itemAtPath, serializeMenu, setChromeColors, toggleMaximize } from './windowChrome'

function fakeWindow() {
  return { setTitleBarOverlay: vi.fn(), isMaximized: vi.fn(() => false), maximize: vi.fn(), unmaximize: vi.fn() }
}

describe('setChromeColors', () => {
  it('colours the overlay on Linux', () => {
    const win = fakeWindow()
    setChromeColors('linux', win, { background: '#101010', symbol: '#eeeeee' })
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#101010', symbolColor: '#eeeeee', height: TITLE_BAR_HEIGHT })
  })

  it('is ignored on macOS, which has no overlay', () => {
    const win = fakeWindow()
    setChromeColors('darwin', win, { background: '#101010', symbol: '#eeeeee' })
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
  })

  it('drops colours that are not #rrggbb, and a window with the system bar throwing', () => {
    const win = fakeWindow()
    setChromeColors('linux', win, { background: 'url(x)', symbol: '#eeeeee' })
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
    win.setTitleBarOverlay.mockImplementation(() => {
      throw new Error('no overlay')
    })
    expect(() => setChromeColors('win32', win, { background: '#101010', symbol: '#eeeeee' })).not.toThrow()
  })
})

describe('toggleMaximize', () => {
  it('maximizes, then restores', () => {
    const win = fakeWindow()
    toggleMaximize(win)
    expect(win.maximize).toHaveBeenCalled()
    win.isMaximized.mockReturnValue(true)
    toggleMaximize(win)
    expect(win.unmaximize).toHaveBeenCalled()
  })
})

describe('the application menu for the in-app menu bar', () => {
  const items = [
    {
      label: 'File',
      visible: true,
      enabled: true,
      type: 'submenu',
      submenu: {
        items: [
          { label: 'Import from OneNote…', visible: true, enabled: true, type: 'normal', accelerator: null },
          { label: '', visible: true, enabled: true, type: 'separator' },
          { label: 'Hidden', visible: false, enabled: true, type: 'normal' },
          { label: 'Settings…', visible: true, enabled: true, type: 'normal', accelerator: 'Ctrl+,' },
        ],
      },
    },
    { label: 'View', visible: true, enabled: true, type: 'submenu', submenu: { items: [{ label: 'Auto Bullets', visible: true, enabled: true, type: 'checkbox', checked: true }] } },
  ]

  it('keeps visible items with their labels, accelerators and checks', () => {
    expect(serializeMenu(items)).toEqual([
      {
        kind: 'submenu',
        label: 'File',
        enabled: true,
        path: [0],
        submenu: [
          { kind: 'normal', label: 'Import from OneNote…', enabled: true, path: [0, 0] },
          { kind: 'separator', label: '', enabled: true, path: [0, 1] },
          { kind: 'normal', label: 'Settings…', enabled: true, accelerator: 'Ctrl+,', path: [0, 3] },
        ],
      },
      { kind: 'submenu', label: 'View', enabled: true, path: [1], submenu: [{ kind: 'checkbox', label: 'Auto Bullets', enabled: true, checked: true, path: [1, 0] }] },
    ])
  })

  it('finds an item by its path', () => {
    expect(itemAtPath(items, [0, 3])?.label).toBe('Settings…')
    expect(itemAtPath(items, [5])).toBeNull()
  })
})

/**
 * Main's side of the themed title bar (shared/windowChrome/chrome.ts). Written against the few
 * window and menu members it uses, so it runs without Electron in tests.
 */
import { isHexColor, TITLE_BAR_HEIGHT, type AppMenuNode, type ChromeColors } from '../shared/windowChrome/chrome'

interface OverlayWindow {
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void
}

interface MaximizableWindow {
  isMaximized(): boolean
  maximize(): void
  unmaximize(): void
}

interface MenuItemLike {
  label: string
  visible: boolean
  enabled: boolean
  type: string
  checked?: boolean
  accelerator?: string | null
  submenu?: { items: MenuItemLike[] } | null
}

/** Colours the window buttons Electron draws over the bar; macOS's traffic lights take no colour. */
export function setChromeColors(platform: string, win: OverlayWindow | null, colors: ChromeColors): void {
  if (platform === 'darwin' || !win || !isHexColor(colors.background) || !isHexColor(colors.symbol)) return
  try {
    win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT })
  } catch {
    // A window opened with the system title bar has no overlay to colour.
  }
}

export function toggleMaximize(win: MaximizableWindow | null): void {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

export function serializeMenu(items: MenuItemLike[], parent: number[] = []): AppMenuNode[] {
  const out: AppMenuNode[] = []
  items.forEach((item, i) => {
    if (!item.visible) return
    const path = [...parent, i]
    const sub = item.submenu?.items
    const kind: AppMenuNode['kind'] = sub ? 'submenu' : item.type === 'checkbox' || item.type === 'radio' || item.type === 'separator' ? item.type : 'normal'
    const node: AppMenuNode = { kind, label: item.label, enabled: item.enabled, path }
    if (item.accelerator) node.accelerator = item.accelerator
    if (kind === 'checkbox' || kind === 'radio') node.checked = item.checked === true
    if (sub) node.submenu = serializeMenu(sub, path)
    out.push(node)
  })
  return out
}

export function itemAtPath<T extends MenuItemLike>(items: T[], path: number[]): T | null {
  let list: MenuItemLike[] = items
  let item: MenuItemLike | undefined
  for (const [depth, i] of path.entries()) {
    item = list[i]
    if (!item) return null
    if (depth < path.length - 1) list = item.submenu?.items ?? []
  }
  return (item as T | undefined) ?? null
}

/**
 * The window's title bar. Slate draws its own (renderer/src/titleBar/) so it follows the theme:
 * macOS keeps its traffic lights inset over it, Linux and Windows get Electron's window buttons
 * drawn over its right end (`titleBarOverlay`), coloured from the theme. `systemTitleBar` falls
 * back to the OS bar.
 */
import { composite, parseColor, toHex8 } from '../theme/color'
import { DEFAULT_PALETTE, type PaletteToken, type ThemeSpec } from '../theme/spec'

export type WindowChrome = 'mac' | 'overlay' | 'system'

export const TITLE_BAR_HEIGHT = 36

export interface ChromeColors {
  /** `#rrggbb`: Electron's overlay takes no alpha. */
  background: string
  symbol: string
}

export interface ChromeOptions {
  titleBarStyle?: 'hiddenInset' | 'hidden'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
}

/** One visible item of the application menu, as the in-app menu bar draws it. */
export interface AppMenuNode {
  kind: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  label: string
  enabled: boolean
  accelerator?: string
  checked?: boolean
  /** Indices into the native menu's items, hidden ones included: what `invokeMenu` runs. */
  path: number[]
  submenu?: AppMenuNode[]
}

export function windowChromeFor(platform: string, systemTitleBar: boolean): WindowChrome {
  if (systemTitleBar) return 'system'
  return platform === 'darwin' ? 'mac' : 'overlay'
}

export function chromeOptions(chrome: WindowChrome, colors: ChromeColors): ChromeOptions {
  if (chrome === 'system') return {}
  // The buttons are about 16 px tall with their shadow.
  if (chrome === 'mac') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: Math.round((TITLE_BAR_HEIGHT - 16) / 2) } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT } }
}

/** The toolbar's colour, so the bar and the toolbar row read as one band; flattened onto the window colour since a token may be see-through (Glass). */
export function titleBarColors(spec: ThemeSpec): ChromeColors {
  const colour = (t: PaletteToken) => parseColor(spec.palette[t] ?? DEFAULT_PALETTE[t])!
  const bg = colour('bg')
  const opaque = { ...bg, a: 1 }
  const background = composite(colour('toolbar-bg'), opaque)
  const symbol = composite(colour('text'), background)
  return { background: toHex8(background).slice(0, 7), symbol: toHex8(symbol).slice(0, 7) }
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
}

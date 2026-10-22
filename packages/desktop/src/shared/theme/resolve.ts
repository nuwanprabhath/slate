import { builtinTheme, DEFAULT_THEME_ID, LIGHT_THEME_ID } from './builtins'
import type { ThemeSpec } from './spec'

/** A theme the user saved (main/theme/themeStore.ts). Its spec has been validated. */
export interface SavedTheme {
  id: string
  name: string
  /** What it was generated from, or null for a copy of another theme. */
  prompt: string | null
  createdAt: number
  spec: ThemeSpec
}

/** A theme Claude designed, validated in main; `note` says what validation changed, if anything. */
export interface ThemeGenerateResult {
  spec: ThemeSpec
  note: string | null
}

/**
 * Which theme to show. Safe mode (`SLATE_SAFE_THEME=1`) is Dark whatever is saved; following the
 * system is Light or Dark by the OS; an id that names nothing (a deleted theme) is Dark.
 */
export function resolveTheme(o: { themeId: string; saved: SavedTheme[]; followSystem: boolean; systemDark: boolean; safe: boolean }): { id: string; spec: ThemeSpec } {
  const dark = builtinTheme(DEFAULT_THEME_ID)!
  if (o.safe) return dark
  if (o.followSystem) return o.systemDark ? dark : builtinTheme(LIGHT_THEME_ID)!
  const saved = o.saved.find((t) => t.id === o.themeId)
  if (saved !== undefined) return { id: saved.id, spec: saved.spec }
  return builtinTheme(o.themeId) ?? dark
}

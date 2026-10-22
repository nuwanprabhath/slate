import type { Settings } from '../../../shared/api'
import { resolveTheme, type SavedTheme } from '../../../shared/theme/resolve'
import type { ThemeSpec } from '../../../shared/theme/spec'
import { applyTheme } from './applyTheme'

/**
 * Which theme this window shows: the saved choice (settings + saved themes + the OS scheme), or a
 * preview the Appearance section put up while the user decides on a generated theme. A preview
 * belongs to this window only and goes when the section closes.
 */

type Listener = () => void
const listeners = new Set<Listener>()

const initial = window.slate.themes.initial
let settings: Pick<Settings, 'themeId' | 'followSystem'> = initial.settings
let saved: SavedTheme[] = initial.saved
let systemDark = initial.systemDark
let preview: ThemeSpec | null = null

function activeTheme(): { id: string; spec: ThemeSpec } {
  return resolveTheme({ themeId: settings.themeId, saved, followSystem: settings.followSystem, systemDark, safe: initial.safeMode })
}

let active = activeTheme()

function refresh(): void {
  active = activeTheme()
  applyTheme(preview ?? active.spec)
  listeners.forEach((l) => l())
}

export const themeState = {
  activeId: (): string => active.id,
  saved: (): SavedTheme[] => saved,
  preview: (): ThemeSpec | null => preview,
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  setPreview(spec: ThemeSpec | null): void {
    preview = spec
    refresh()
  },
}

let started = false

/** Applies the theme before React's first render, then follows settings, saved themes and the OS. */
export function startTheme(): void {
  if (started) return
  started = true
  refresh()
  window.slate.settings.onChange((s) => {
    if (s.themeId === settings.themeId && s.followSystem === settings.followSystem) return
    settings = s
    refresh()
  })
  window.slate.themes.onChange((list) => {
    saved = list
    refresh()
  })
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      systemDark = e.matches
      refresh()
    })
  }
}

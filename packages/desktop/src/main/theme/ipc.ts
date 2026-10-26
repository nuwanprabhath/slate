import { env } from '../testHooks'
import { app, nativeTheme } from 'electron'
import type { IpcRegistrar } from '../ipcGuard'
import type { ThemesApi } from '../../shared/api'
import { CH } from '../../shared/ipc'
import { builtinTheme } from '../../shared/theme/builtins'
import { resolveTheme } from '../../shared/theme/resolve'
import type { ThemeSpec } from '../../shared/theme/spec'
import { DEFAULT_PALETTE } from '../../shared/theme/spec'
import { readSettings } from '../settings'
import type { DocStore } from '../store'
import type { PreunlockContent } from '../vault/preunlock'
import { ClaudeOneShot, findClaude } from './claudeOneShot'
import { fakeThemeRunner, ThemeGenerator } from './themeGenerator'
import type { ThemeStore } from './themeStore'

/** `SLATE_SAFE_THEME=1`: Dark for this run, whatever is saved; the way back from a broken theme. */
export const safeTheme = env('SLATE_SAFE_THEME') === '1'

function gpuCompositing(): boolean {
  const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
  return (status.gpu_compositing ?? 'enabled').startsWith('enabled')
}

/** Where theme IPC finds its data: the open notes, or before unlock only `preunlock.json`. */
export interface ThemeSource {
  open(): { db: DocStore; themes: ThemeStore } | null
  preunlock(): PreunlockContent | null
}

export function registerThemeIpc(ipc: IpcRegistrar, source: ThemeSource, isE2E: boolean): void {
  const fake = isE2E && env('SLATE_FAKE_CLAUDE_THEME') === '1'
  const generator = new ThemeGenerator({ runner: fake ? fakeThemeRunner() : new ClaudeOneShot() })
  const notes = () => {
    const open = source.open()
    if (!open) throw new Error('Slate is locked')
    return open
  }
  // Sync, once per window at preload, so the first paint already has the theme (no flash of Dark).
  ipc.on(CH.themesInitial, (e) => {
    const open = source.open()
    // The lock screen: preunlock's theme id; a saved (custom) theme is in the encrypted DB, so it falls back to Dark.
    const pre = source.preunlock()
    const { themeId, followSystem, motion, fontOverrides } = open
      ? readSettings(open.db)
      : { themeId: pre?.themeId ?? builtinTheme('builtin:dark')!.id, followSystem: false, motion: pre?.motion ?? 'auto', fontOverrides: {} }
    const initial: ThemesApi['initial'] = {
      settings: { themeId, followSystem, motion, fontOverrides },
      saved: open ? open.themes.list() : [],
      safeMode: safeTheme,
      gpuCompositing: gpuCompositing(),
      systemDark: nativeTheme.shouldUseDarkColors,
    }
    e.returnValue = initial
  })
  ipc.handle(CH.themesList, () => notes().themes.list())
  ipc.handle(CH.themesSave, (_e, spec: unknown, prompt?: string | null) => notes().themes.save(spec, prompt ?? null))
  ipc.handle(CH.themesRename, (_e, id: string, name: string) => notes().themes.rename(id, name))
  ipc.handle(CH.themesRemove, (_e, id: string) => notes().themes.remove(id))
  ipc.handle(CH.themesClaude, async () => fake || (await findClaude()) !== null)
  ipc.handle(CH.themesGenerate, (_e, request: string, current: ThemeSpec | null) => generator.generate({ request, current }))
  ipc.handle(CH.themesCancel, () => generator.cancel())
}

export function activeThemeSpec(source: ThemeSource): ThemeSpec {
  const open = source.open()
  if (!open) return resolveTheme({ themeId: source.preunlock()?.themeId ?? '', saved: [], followSystem: false, systemDark: nativeTheme.shouldUseDarkColors, safe: safeTheme }).spec
  const s = readSettings(open.db)
  return resolveTheme({ themeId: s.themeId, saved: open.themes.list(), followSystem: s.followSystem, systemDark: nativeTheme.shouldUseDarkColors, safe: safeTheme }).spec
}

/** The active theme's window colour, for the BrowserWindow's `backgroundColor` before the page paints. */
export function windowBackground(source: ThemeSource): string {
  const spec = activeThemeSpec(source)
  const bg = spec.palette.bg ?? builtinTheme('builtin:dark')!.spec.palette.bg ?? DEFAULT_PALETTE.bg
  // Electron wants #rrggbb or #aarrggbb; the window colour is always opaque.
  return bg.slice(0, 7)
}

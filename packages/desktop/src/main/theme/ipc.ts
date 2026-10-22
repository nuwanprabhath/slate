import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import type { ThemesApi } from '../../shared/api'
import { CH } from '../../shared/ipc'
import { builtinTheme } from '../../shared/theme/builtins'
import { resolveTheme } from '../../shared/theme/resolve'
import type { ThemeSpec } from '../../shared/theme/spec'
import { DEFAULT_PALETTE } from '../../shared/theme/spec'
import { readSettings } from '../settings'
import type { DocStore } from '../store'
import { ClaudeOneShot, findClaude } from './claudeOneShot'
import { fakeThemeRunner, ThemeGenerator } from './themeGenerator'
import { ThemeStore } from './themeStore'

/** `SLATE_SAFE_THEME=1`: Dark for this run, whatever is saved; the way back from a broken theme. */
export const safeTheme = process.env.SLATE_SAFE_THEME === '1'

function gpuCompositing(): boolean {
  const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
  return (status.gpu_compositing ?? 'enabled').startsWith('enabled')
}

export function registerThemeIpc(db: DocStore, isE2E: boolean): ThemeStore {
  const store = new ThemeStore(db)
  const fake = isE2E && process.env.SLATE_FAKE_CLAUDE_THEME === '1'
  const generator = new ThemeGenerator({ runner: fake ? fakeThemeRunner() : new ClaudeOneShot() })
  // Sync, once per window at preload, so the first paint already has the theme (no flash of Dark).
  ipcMain.on(CH.themesInitial, (e) => {
    const { themeId, followSystem, motion, fontOverrides } = readSettings(db)
    const initial: ThemesApi['initial'] = { settings: { themeId, followSystem, motion, fontOverrides }, saved: store.list(), safeMode: safeTheme, gpuCompositing: gpuCompositing(), systemDark: nativeTheme.shouldUseDarkColors }
    e.returnValue = initial
  })
  ipcMain.handle(CH.themesList, () => store.list())
  ipcMain.handle(CH.themesSave, (_e, spec: unknown, prompt?: string | null) => store.save(spec, prompt ?? null))
  ipcMain.handle(CH.themesRename, (_e, id: string, name: string) => store.rename(id, name))
  ipcMain.handle(CH.themesRemove, (_e, id: string) => store.remove(id))
  ipcMain.handle(CH.themesClaude, async () => fake || (await findClaude()) !== null)
  ipcMain.handle(CH.themesGenerate, (_e, request: string, current: ThemeSpec | null) => generator.generate({ request, current }))
  ipcMain.handle(CH.themesCancel, () => generator.cancel())
  store.onChange((saved) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.themesChanged, saved)))
  return store
}

/** The active theme's window colour, for the BrowserWindow's `backgroundColor` before the page paints. */
export function windowBackground(db: DocStore, store: ThemeStore): string {
  const s = readSettings(db)
  const { spec } = resolveTheme({ themeId: s.themeId, saved: store.list(), followSystem: s.followSystem, systemDark: nativeTheme.shouldUseDarkColors, safe: safeTheme })
  const bg = spec.palette.bg ?? builtinTheme('builtin:dark')!.spec.palette.bg ?? DEFAULT_PALETTE.bg
  // Electron wants #rrggbb or #aarrggbb; the window colour is always opaque.
  return bg.slice(0, 7)
}

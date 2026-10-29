import { BASE_THEME, type ThemeSpec } from './spec'

/**
 * The themes Slate ships. Each must come through `validateTheme` unchanged (theme.test.ts), so
 * nothing here relies on the validator fixing it. Colours are `#rrggbbaa`, as validation writes them.
 */
export interface BuiltinTheme { id: string; spec: ThemeSpec }

export const DEFAULT_THEME_ID = 'builtin:dark'
export const LIGHT_THEME_ID = 'builtin:light'

const theme = (spec: Partial<ThemeSpec> & Pick<ThemeSpec, 'name'>): ThemeSpec => ({ ...structuredClone(BASE_THEME), ...spec })

export const BUILTIN_THEMES: BuiltinTheme[] = [
  // Dark is the defaults themselves (spec.ts DEFAULT_PALETTE, app.css).
  { id: DEFAULT_THEME_ID, spec: theme({ name: 'Dark' }) },
  {
    id: LIGHT_THEME_ID,
    spec: theme({
      name: 'Light',
      palette: {
        'bg': '#ffffffff', 'page': '#ffffffff', 'panel': '#f4f4f5ff', 'panel-2': '#e9e9ebff',
        'toolbar-bg': '#f4f4f5ff', 'sidebar-bg': '#f4f4f5ff', 'popover': '#ffffffff', 'overlay': '#00000059',
        'box-border': '#d4d4d8ff', 'border': '#d4d4d8ff', 'text': '#1f1f1fff', 'muted': '#6b6b6bff',
        'accent': '#7c3aedff', 'accent-contrast': '#ffffffff', 'link': '#1a5fd0ff', 'selection': '#7c3aed40',
        'hover': '#ececeeff', 'selected': '#e2e2e6ff', 'danger': '#c62828ff', 'warning': '#8a6d00ff', 'control-bg': '#ffffffff', 'control-border': '#8a8a93ff',
        'find-match': '#ff9a3d66', 'find-current': '#ffa600cc', 'scrollbar-thumb': '#00000038',
        'code-keyword': '#8b3fc4ff', 'code-string': '#3d7a1fff', 'code-number': '#b5481fff', 'code-comment': '#6a707aff', 'code-title': '#1d5fc2ff',
      },
    }),
  },
  {
    id: 'builtin:glass',
    spec: theme({
      // The id predates the name: users who chose Glass keep it.
      name: 'Liquid Glass',
      material: 'glass',
      glass: { saturation: 1.6, highlight: 0.7, refraction: 0.45 },
      palette: {
        'bg': '#141a2bff', 'page': '#12182acc', 'panel': '#1e2538d9', 'panel-2': '#ffffff4d',
        'toolbar-bg': '#1a2134b3', 'sidebar-bg': '#1a2134b3', 'popover': '#1e2538f5', 'overlay': '#0000006b',
        'box-bg': '#ffffff08', 'box-border': '#ffffff2e', 'border': '#ffffff24',
        'text': '#eef1f8ff', 'muted': '#a9b2c8ff', 'accent': '#8fb4ffff', 'accent-contrast': '#0d1322ff',
        'link': '#9cc2ffff', 'selection': '#8fb4ff4d', 'hover': '#ffffff1a', 'selected': '#ffffff2b',
        'danger': '#ff8a80ff', 'warning': '#f2c94cff', 'control-bg': '#232a3dff', 'control-border': '#ffffff80',
      },
      effects: [{ kind: 'gradient-drift', color: 'accent', intensity: 0.8, speed: 0.15, density: 0.6 }],
    }),
  },
  {
    id: 'builtin:paper',
    spec: theme({
      name: 'Paper',
      texture: 'paper',
      font: 'serif',
      surfaces: { sidebar: { texture: 'paper' }, toolbar: { texture: 'paper' } },
      palette: {
        'bg': '#ece3cfff', 'page': '#f6efdfff', 'panel': '#eee5d1ff', 'panel-2': '#e3d8bfff',
        'toolbar-bg': '#efe6d2ff', 'sidebar-bg': '#e9dfc8ff', 'popover': '#f8f2e4ff', 'overlay': '#2b241838',
        'box-border': '#cbbd9eff', 'border': '#d2c4a5ff', 'text': '#2b2418ff', 'muted': '#6e604aff',
        'accent': '#8a4b1fff', 'accent-contrast': '#fff8ecff', 'link': '#1f4e8aff', 'selection': '#8a4b1f33',
        'hover': '#e2d6bbff', 'selected': '#d9cba9ff', 'danger': '#a8321eff', 'warning': '#7a5a00ff', 'control-bg': '#fbf6eaff', 'control-border': '#8f7d5aff',
        'find-match': '#e8a04a66', 'find-current': '#e8a04acc', 'scrollbar-thumb': '#2b241833',
        'code-keyword': '#7a2f8aff', 'code-string': '#3f6b1aff', 'code-number': '#9a3f12ff', 'code-comment': '#6e604aff', 'code-title': '#1f4e8aff',
      },
    }),
  },
  {
    id: 'builtin:solarized-light',
    spec: theme({
      name: 'Solarized Light',
      palette: {
        'bg': '#fdf6e3ff', 'page': '#fdf6e3ff', 'panel': '#eee8d5ff', 'panel-2': '#e4ddc8ff',
        'toolbar-bg': '#eee8d5ff', 'sidebar-bg': '#eee8d5ff', 'popover': '#fdf6e3ff', 'overlay': '#002b3640',
        'box-border': '#d6cfb8ff', 'border': '#d6cfb8ff', 'text': '#073642ff', 'muted': '#586e75ff',
        'accent': '#268bd2ff', 'accent-contrast': '#001b22ff', 'link': '#1a6aa5ff', 'selection': '#268bd240',
        'hover': '#e6dfcaff', 'selected': '#ddd6c1ff', 'danger': '#c0302dff', 'warning': '#8a6d00ff', 'control-bg': '#fdf6e3ff', 'control-border': '#768788ff',
        'find-match': '#b5890066', 'find-current': '#cb4b16aa', 'scrollbar-thumb': '#586e7540',
        'code-keyword': '#6c71c4ff', 'code-string': '#5b7300ff', 'code-number': '#b03b10ff', 'code-comment': '#657b83ff', 'code-title': '#1a6aa5ff',
      },
    }),
  },
  {
    id: 'builtin:nord',
    spec: theme({
      name: 'Nord',
      palette: {
        'bg': '#2e3440ff', 'page': '#2e3440ff', 'panel': '#3b4252ff', 'panel-2': '#434c5eff',
        'toolbar-bg': '#3b4252ff', 'sidebar-bg': '#3b4252ff', 'popover': '#434c5eff', 'overlay': '#0000006b',
        'box-border': '#4c566aff', 'border': '#4c566aff', 'text': '#eceff4ff', 'muted': '#aeb7c8ff',
        'accent': '#88c0d0ff', 'accent-contrast': '#2e3440ff', 'link': '#8fbcbbff', 'selection': '#88c0d04d',
        'hover': '#434c5eff', 'selected': '#4c566aff', 'danger': '#e08890ff', 'warning': '#ebcb8bff', 'control-bg': '#434c5eff', 'control-border': '#909cb3ff',
        'code-keyword': '#b48eadff', 'code-string': '#a3be8cff', 'code-number': '#d08770ff', 'code-comment': '#9aa5b8ff', 'code-title': '#88c0d0ff',
      },
    }),
  },
  {
    // An editorial look: warm ivory, hairline borders, a clay accent and a text serif.
    id: 'builtin:folio',
    spec: theme({
      name: 'Folio',
      texture: 'vellum',
      font: 'source-serif',
      uiFont: 'inter',
      surfaces: { sidebar: { gradient: { from: 'sidebar-bg', to: 'bg', angle: 180 } } },
      palette: {
        'bg': '#faf9f5ff', 'page': '#faf9f5ff', 'panel': '#f0eee6ff', 'panel-2': '#e8e6dcff',
        'toolbar-bg': '#faf9f5ff', 'sidebar-bg': '#f3f1eaff', 'popover': '#ffffffff', 'overlay': '#14141333',
        'box-border': '#e8e6dcff', 'border': '#e8e6dcff', 'text': '#141413ff', 'muted': '#5e5d59ff',
        // Clay a shade deeper than Folio Dark's, so it still reads at 3:1 on ivory.
        'accent': '#c15c39ff', 'accent-contrast': '#0a0a09ff', 'link': '#a8482bff', 'selection': '#d9775740',
        'hover': '#efede5ff', 'selected': '#e8e6dcff', 'danger': '#b3361fff', 'warning': '#8a6200ff', 'control-bg': '#faf9f5ff', 'control-border': '#8a877dff',
        'find-match': '#d9775759', 'find-current': '#d97757b3', 'scrollbar-thumb': '#14141326',
        'code-keyword': '#8a3f9eff', 'code-string': '#4f6b1fff', 'code-number': '#a8482bff', 'code-comment': '#6f6d66ff', 'code-title': '#2f5f8aff',
      },
    }),
  },
  {
    id: 'builtin:folio-dark',
    spec: theme({
      name: 'Folio Dark',
      texture: 'vellum',
      font: 'source-serif',
      uiFont: 'inter',
      surfaces: { sidebar: { gradient: { from: 'sidebar-bg', to: 'bg', angle: 180 } } },
      palette: {
        'bg': '#262624ff', 'page': '#262624ff', 'panel': '#30302eff', 'panel-2': '#3a3a37ff',
        'toolbar-bg': '#262624ff', 'sidebar-bg': '#1f1e1dff', 'popover': '#30302eff', 'overlay': '#00000066',
        'box-border': '#3e3e3aff', 'border': '#3e3e3aff', 'text': '#faf9f5ff', 'muted': '#a6a39aff',
        'accent': '#d97757ff', 'accent-contrast': '#141413ff', 'link': '#e8a085ff', 'selection': '#d977574d',
        'hover': '#34342fff', 'selected': '#3d3c37ff', 'danger': '#ec8a74ff', 'warning': '#d9ad55ff', 'control-bg': '#3a3a37ff', 'control-border': '#86837aff',
        'find-match': '#d9775766', 'find-current': '#d97757cc', 'scrollbar-thumb': '#faf9f533',
        'code-keyword': '#d0a1e0ff', 'code-string': '#b5cf86ff', 'code-number': '#eba183ff', 'code-comment': '#9a978dff', 'code-title': '#8fb8e0ff',
      },
    }),
  },
]

export function builtinTheme(id: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find((b) => b.id === id)
}

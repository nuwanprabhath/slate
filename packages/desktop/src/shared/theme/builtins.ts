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
        'hover': '#ececeeff', 'selected': '#e2e2e6ff', 'danger': '#c62828ff', 'warning': '#8a6d00ff', 'control-bg': '#ffffffff',
        'find-match': '#ff9a3d66', 'find-current': '#ffa600cc', 'scrollbar-thumb': '#00000038',
        'code-keyword': '#8b3fc4ff', 'code-string': '#3d7a1fff', 'code-number': '#b5481fff', 'code-comment': '#6a707aff', 'code-title': '#1d5fc2ff',
      },
    }),
  },
  {
    id: 'builtin:glass',
    spec: theme({
      name: 'Glass',
      material: 'glass',
      palette: {
        'bg': '#141a2bff', 'page': '#12182acc', 'panel': '#1e2538d9', 'panel-2': '#ffffff4d',
        'toolbar-bg': '#1a2134b3', 'sidebar-bg': '#1a2134b3', 'popover': '#1e2538f5', 'overlay': '#0000006b',
        'box-bg': '#ffffff08', 'box-border': '#ffffff2e', 'border': '#ffffff24',
        'text': '#eef1f8ff', 'muted': '#a9b2c8ff', 'accent': '#8fb4ffff', 'accent-contrast': '#0d1322ff',
        'link': '#9cc2ffff', 'selection': '#8fb4ff4d', 'hover': '#ffffff1a', 'selected': '#ffffff2b',
        'danger': '#ff8a80ff', 'warning': '#f2c94cff', 'control-bg': '#232a3dff',
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
      palette: {
        'bg': '#ece3cfff', 'page': '#f6efdfff', 'panel': '#eee5d1ff', 'panel-2': '#e3d8bfff',
        'toolbar-bg': '#efe6d2ff', 'sidebar-bg': '#e9dfc8ff', 'popover': '#f8f2e4ff', 'overlay': '#2b241838',
        'box-border': '#cbbd9eff', 'border': '#d2c4a5ff', 'text': '#2b2418ff', 'muted': '#6e604aff',
        'accent': '#8a4b1fff', 'accent-contrast': '#fff8ecff', 'link': '#1f4e8aff', 'selection': '#8a4b1f33',
        'hover': '#e2d6bbff', 'selected': '#d9cba9ff', 'danger': '#a8321eff', 'warning': '#7a5a00ff', 'control-bg': '#fbf6eaff',
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
        'hover': '#e6dfcaff', 'selected': '#ddd6c1ff', 'danger': '#c0302dff', 'warning': '#8a6d00ff', 'control-bg': '#fdf6e3ff',
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
        'hover': '#434c5eff', 'selected': '#4c566aff', 'danger': '#e08890ff', 'warning': '#ebcb8bff', 'control-bg': '#434c5eff',
        'code-keyword': '#b48eadff', 'code-string': '#a3be8cff', 'code-number': '#d08770ff', 'code-comment': '#9aa5b8ff', 'code-title': '#88c0d0ff',
      },
    }),
  },
]

export function builtinTheme(id: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find((b) => b.id === id)
}

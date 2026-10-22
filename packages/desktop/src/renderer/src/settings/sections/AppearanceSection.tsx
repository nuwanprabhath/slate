import { useEffect, useState, useSyncExternalStore } from 'react'
import { BUILTIN_THEMES } from '../../../../shared/theme/builtins'
import type { MotionSetting } from '../../../../shared/theme/motion'
import { ThemeDescribe } from '../../theme/ThemeDescribe'
import { ThemeGrid, type ThemeEntry } from '../../theme/ThemeGrid'
import { themeState } from '../../theme/themeState'
import { CheckboxSetting } from '../fields/CheckboxSetting'
import { SelectSetting } from '../fields/SelectSetting'
import type { SectionProps } from '../registry'

const MOTION_OPTIONS: ReadonlyArray<{ value: MotionSetting; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'full', label: 'On' },
  { value: 'reduced', label: 'Off' },
]

export function AppearanceSection({ settings, patch }: SectionProps) {
  useSyncExternalStore(themeState.subscribe, themeState.activeId)
  const saved = useSyncExternalStore(themeState.subscribe, themeState.saved)
  const [claude, setClaude] = useState(false)
  useEffect(() => {
    let live = true
    void window.slate.themes.claudeAvailable().then((ok) => live && setClaude(ok))
    return () => {
      live = false
    }
  }, [])
  const all: ThemeEntry[] = [...BUILTIN_THEMES.map((b) => ({ ...b, saved: false })), ...saved.map((t) => ({ id: t.id, spec: t.spec, saved: true }))]
  const choose = (themeId: string) => patch({ themeId, followSystem: false })
  return (
    <>
      <ThemeGrid
        all={all}
        activeId={settings.followSystem ? themeState.activeId() : settings.themeId}
        onChoose={choose}
        onDuplicate={(t) => void window.slate.themes.save({ ...t.spec, name: `${t.spec.name} copy` }).then((s) => choose(s.id))}
        onRename={(id, name) => void window.slate.themes.rename(id, name)}
        onDelete={(id) => {
          if (id === settings.themeId) patch({ themeId: 'builtin:dark' })
          void window.slate.themes.remove(id)
        }}
      />
      <SelectSetting
        testId="setting-motion"
        label={<strong>Animations</strong>}
        help="Automatic turns them off when your system asks for less motion, or when the graphics card is not doing the drawing."
        value={settings.motion}
        options={MOTION_OPTIONS}
        onChange={(motion) => patch({ motion })}
      />
      <CheckboxSetting
        testId="setting-follow-system"
        label="Follow system light/dark"
        help="Light or Dark, whichever your system is set to."
        checked={settings.followSystem}
        onChange={(followSystem) => patch({ followSystem })}
      />
      {claude && <ThemeDescribe onSaved={choose} />}
      <CheckboxSetting
        testId="setting-system-title-bar"
        label="Use the system title bar (restart to apply)"
        help="Your system's own title bar instead of Slate's themed one. Takes effect the next time Slate starts."
        checked={settings.systemTitleBar}
        onChange={(systemTitleBar) => patch({ systemTitleBar })}
      />
    </>
  )
}

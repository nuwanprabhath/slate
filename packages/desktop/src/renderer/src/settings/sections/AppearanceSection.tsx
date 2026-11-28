import { useEffect, useState, useSyncExternalStore } from 'react'
import { BUILTIN_THEMES } from '../../../../shared/theme/builtins'
import type { MotionSetting } from '../../../../shared/theme/motion'
import { askConsent } from '../../privacy/askConsent'
import { consentRequiredFeature } from '../../../../shared/privacy/consent'
import { ThemeDescribe } from '../../theme/ThemeDescribe'
import { ThemeGrid, type ThemeEntry } from '../../theme/ThemeGrid'
import { themeState } from '../../theme/themeState'
import type { FontOverride } from '../../../../shared/theme/fonts'
import { CheckboxSetting } from '../fields/CheckboxSetting'
import { FontCombo } from '../fields/FontCombo'
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
  // True while strict mode has no `claudeTheme` consent: the probe for the claude command (it runs the login
  // shell) waits for the person to ask for the feature.
  const [needsConsent, setNeedsConsent] = useState(false)
  const [note, setNote] = useState('')
  const probe = () =>
    window.slate.themes.claudeAvailable().then(
      (ok) => {
        setNeedsConsent(false)
        setClaude(ok)
        return ok
      },
      (e: unknown) => {
        if (consentRequiredFeature(e) === 'claudeTheme') setNeedsConsent(true)
        return false
      },
    )
  useEffect(() => {
    let live = true
    void window.slate.privacy.status().then((p) => {
      if (!live) return
      if (p.allowed.claudeTheme) void probe()
      else setNeedsConsent(true)
    })
    return () => {
      live = false
    }
  }, [])
  const describeWithClaude = () => {
    setNote('')
    void askConsent('claudeTheme').then(async (answer) => {
      if (answer !== 'granted') return
      if (!(await probe())) setNote('Slate did not find the claude command on this computer, so this is not available.')
    })
  }
  const all: ThemeEntry[] = [...BUILTIN_THEMES.map((b) => ({ ...b, saved: false })), ...saved.map((t) => ({ id: t.id, spec: t.spec, saved: true }))]
  const choose = (themeId: string) => patch({ themeId, followSystem: false })
  const activeId = settings.followSystem ? themeState.activeId() : settings.themeId
  const fonts = settings.fontOverrides[activeId] ?? {}
  const setFont = (key: keyof FontOverride, name: string | undefined) => {
    const next: FontOverride = { ...fonts, [key]: name }
    if (name === undefined) delete next[key]
    const fontOverrides = { ...settings.fontOverrides, [activeId]: next }
    if (next.note === undefined && next.ui === undefined) delete fontOverrides[activeId]
    patch({ fontOverrides })
  }
  return (
    <>
      <ThemeGrid
        all={all}
        activeId={activeId}
        onChoose={choose}
        onDuplicate={(t) => void window.slate.themes.save({ ...t.spec, name: `${t.spec.name} copy` }).then((s) => choose(s.id))}
        onRename={(id, name) => void window.slate.themes.rename(id, name)}
        onDelete={(id) => {
          if (id === settings.themeId) patch({ themeId: 'builtin:dark' })
          void window.slate.themes.remove(id)
        }}
      />
      <div className="theme-fonts">
        <span className="settings-help">Fonts for this theme. Text you gave a font of its own keeps it.</span>
        <FontCombo testId="setting-note-font" label="Note font" value={fonts.note} onChange={(name) => setFont('note', name)} />
        <FontCombo testId="setting-app-font" label="App font" value={fonts.ui} onChange={(name) => setFont('ui', name)} />
      </div>
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
      {!claude && needsConsent && (
        <div className="settings-field" data-testid="theme-describe-consent">
          <button type="button" className="btn" data-testid="theme-describe-ask" onClick={describeWithClaude}>
            Describe a theme with Claude…
          </button>
          <span className="settings-help">Sends your description and the current theme&rsquo;s colours to Anthropic, through your own claude sign-in. Slate asks first.</span>
        </div>
      )}
      {note && <p className="settings-help" role="status" data-testid="theme-describe-note">{note}</p>}
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

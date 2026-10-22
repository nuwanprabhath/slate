import { useEffect, useState } from 'react'
import type { MotionSetting } from '../../../shared/theme/motion'
import { resolveMotion } from '../../../shared/theme/motion'
import { ThemeEffects } from './ThemeEffects'
import { startTheme } from './themeState'
import './themes.css'

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * Mounted once, beside the app: keeps the theme applied (themeState.ts), sets `<html data-motion>`
 * from the Animations setting, the OS and the GPU probe, and draws the theme's effects.
 */
export function ThemeLayer() {
  const { initial } = window.slate.themes
  const [setting, setSetting] = useState<MotionSetting>(initial.settings.motion)
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(REDUCED).matches)
  useEffect(() => {
    startTheme()
    const off = window.slate.settings.onChange((s) => setSetting(s.motion))
    const query = typeof matchMedia === 'function' ? matchMedia(REDUCED) : null
    const read = () => setSystemReduced(query?.matches ?? false)
    query?.addEventListener('change', read)
    return () => {
      off()
      query?.removeEventListener('change', read)
    }
  }, [])
  const motion = resolveMotion(setting, systemReduced, initial.gpuCompositing)
  useEffect(() => {
    document.documentElement.dataset.motion = motion
  }, [motion])
  return <ThemeEffects animated={motion === 'full'} lowPower={!initial.gpuCompositing} />
}

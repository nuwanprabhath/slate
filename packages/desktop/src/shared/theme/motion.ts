/** The Animations setting: `auto` follows the OS and the GPU. */
export type MotionSetting = 'auto' | 'full' | 'reduced'
/** What the window shows: `reduced` has no animation at all (`:root[data-motion="reduced"]`). */
export type Motion = 'full' | 'reduced'

/** The setting, the system's reduced-motion preference and the GPU probe, reduced to the motion in effect. */
export function resolveMotion(setting: MotionSetting, systemReduced: boolean, gpuCompositing: boolean): Motion {
  if (setting !== 'auto') return setting
  return systemReduced || !gpuCompositing ? 'reduced' : 'full'
}

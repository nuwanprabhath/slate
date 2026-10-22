import { useEffect, useRef, useSyncExternalStore } from 'react'
import { parseColor, saturate, toHex8 } from '../../../shared/theme/color'
import { EFFECTS } from '../../../shared/theme/effects'
import { appliedTheme } from './applyTheme'

const FPS = 30
const MAX_DPR = 1.5
/**
 * Without GPU compositing every animation frame is composited on the CPU, which Apiary measured
 * slowing hovering and typing; there effects move at half the rate and draw at 1×.
 */
const LOW_POWER_FPS = 15
const LOW_POWER_DPR = 1
/** A window left in the background this long stops animating until it is focused again. */
const BLUR_PAUSE_MS = 30_000
/** No new frame until this long after the last key. */
const TYPING_HOLD_MS = 800
/**
 * Glass blurs what shows through it by drawing the canvas at a fraction of the window's resolution
 * and letting it scale up, not with `backdrop-filter`: a live backdrop filter re-runs on every
 * change underneath, and Apiary measured it making hovering lag badly without a GPU.
 */
const GLASS_SCALE = 1 / 8
const GLASS_SATURATION = 1.4

/**
 * One canvas behind the whole UI; the drawing is `shared/theme/effects`, this decides *when*: at
 * most 30 fps (15 without GPU compositing), never while hidden, not after 30 s in the background,
 * one still frame under reduced motion, and no canvas at all for a theme without effects. It never
 * runs on the keystroke path: it only draws from requestAnimationFrame.
 */
export function ThemeEffects({ animated, lowPower }: { animated: boolean; lowPower: boolean }) {
  const spec = useSyncExternalStore(appliedTheme.subscribe, appliedTheme.get)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const effects = spec?.effects ?? []
  const glass = spec?.material === 'glass'
  const signature = JSON.stringify([effects, spec?.palette, glass])

  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx || effects.length === 0) return
    const css = getComputedStyle(document.documentElement)
    const colors = effects.map((e) => {
      const value = css.getPropertyValue(`--${e.color ?? 'accent'}`).trim() || '#ffffff'
      const parsed = glass ? parseColor(value) : null
      return parsed ? toHex8(saturate(parsed, GLASS_SATURATION)) : value
    })
    const size = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, lowPower ? LOW_POWER_DPR : MAX_DPR)
      const scale = glass ? GLASS_SCALE : dpr
      c.width = Math.max(1, Math.round(window.innerWidth * scale))
      c.height = Math.max(1, Math.round(window.innerHeight * scale))
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }
    let frames = 0
    const draw = (t: number, still: boolean): void => {
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)
      effects.forEach((e, i) => EFFECTS[e.kind].draw(ctx, { t, w, h, still }, { intensity: e.intensity, speed: e.speed, density: e.density, color: colors[i]! }))
      // Counted for the tests, which check that "Animations: Off" really means no new frames.
      c.dataset.frames = String((frames += 1))
    }
    let raf: number | null = null
    let last = 0
    let blurredAt: number | null = document.hasFocus() ? null : performance.now()
    let typedAt = -Infinity
    const onKey = (): void => { typedAt = performance.now() }
    const interval = 1000 / (lowPower ? LOW_POWER_FPS : FPS)
    // The next frame is asked for by a timer, not by requesting animation frames back to back: a
    // pending rAF makes Chromium run a main-frame update every vsync, which cost Glass about 5 ms
    // of p95 keystroke time (perf.spec.ts) even on the frames it skipped.
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (delay: number): void => {
      timer = setTimeout(() => {
        timer = null
        raf = requestAnimationFrame(tick)
      }, Math.max(0, delay))
    }
    const tick = (now: number): void => {
      raf = null
      if (document.hidden) return
      if (blurredAt !== null && now - blurredAt > BLUR_PAUSE_MS) return
      // Held while typing, so a frame never lands between a key and its paint; a drift this
      // slow does not visibly stop.
      const sinceKey = now - typedAt
      if (sinceKey < TYPING_HOLD_MS) return schedule(TYPING_HOLD_MS - sinceKey)
      last = now
      draw(now / 1000, false)
      schedule(interval - (performance.now() - last))
    }
    const resume = (): void => {
      if (raf === null && timer === null && animated && !document.hidden) raf = requestAnimationFrame(tick)
    }
    const start = (): void => {
      size()
      if (animated) resume()
      else draw(0, true)
    }
    const onFocus = (): void => { blurredAt = null; resume() }
    const onBlur = (): void => { blurredAt = performance.now() }
    start()
    window.addEventListener('resize', start)
    window.addEventListener('keydown', onKey, { capture: true, passive: true })
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', resume)
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('resize', start)
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', resume)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands in for the effects and colours
  }, [signature, animated, lowPower])

  if (effects.length === 0) return null
  return <canvas ref={canvas} className="theme-effects" data-testid="theme-effects" aria-hidden="true" />
}

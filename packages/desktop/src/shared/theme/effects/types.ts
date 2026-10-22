/**
 * One visual effect: a pure function of time that draws a frame. No state lives between frames,
 * so the same `t` always draws the same frame and the still frame is simply `t = 0`.
 */

/**
 * The slice of a 2D canvas context effects and textures use, declared here so they live in shared/
 * and are tested in plain Node; a real `CanvasRenderingContext2D` satisfies it.
 */
export interface Ctx2D {
  globalAlpha: number
  fillStyle: unknown
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  fill(): void
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void }
}

export interface Frame { t: number; w: number; h: number; still: boolean }
export interface EffectParams { intensity: number; speed: number; density: number; color: string }
export interface Effect {
  /** The most opaque this effect may ever paint, at full intensity. */
  maxOpacity: number
  draw(ctx: Ctx2D, f: Frame, p: EffectParams): void
}

/** A deterministic 0–1 hash of integers: the "randomness" every effect uses. */
export function hash(a: number, b = 0): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  return (x >>> 0) / 4294967296
}

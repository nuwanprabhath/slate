import { hash, type Ctx2D } from './effects/types'
import type { Texture } from './spec'

/**
 * Still textures for the page area. Each is a square tile drawn once per theme (applyTheme turns it
 * into a background image), so a texture costs nothing per frame or per keystroke. Drawn in the
 * theme's text colour, never above `TEXTURE_MAX_OPACITY`, which readability.ts allows for.
 */

export const TEXTURES = ['paper', 'linen', 'dots'] as const satisfies ReadonlyArray<Exclude<Texture, 'none'>>
export const TEXTURE_MAX_OPACITY = 0.12
export const TEXTURE_TILE = 192

export function drawTexture(kind: Exclude<Texture, 'none'>, ctx: Ctx2D, size: number, ink: string): void {
  ctx.fillStyle = ink
  if (kind === 'paper') {
    // Paper grain: many faint specks of varying weight, a few darker fibres.
    const count = Math.round((size * size) / 14)
    for (let i = 0; i < count; i += 1) {
      const heavy = hash(i, 93) > 0.92
      ctx.globalAlpha = (heavy ? 0.1 : 0.03 + hash(i, 94) * 0.05)
      ctx.fillRect(hash(i, 91) * size, hash(i, 92) * size, heavy ? 2 : 1, 1)
    }
  } else if (kind === 'linen') {
    // A loose weave: faint threads across and down, each a little uneven.
    for (let i = 0; i < size; i += 3) {
      ctx.globalAlpha = 0.03 + hash(i, 11) * 0.04
      ctx.fillRect(0, i, size, 1)
      ctx.globalAlpha = 0.03 + hash(i, 12) * 0.04
      ctx.fillRect(i, 0, 1, size)
    }
  } else {
    // A dot grid, like a bullet-journal page.
    ctx.globalAlpha = 0.12
    const step = size / 8
    for (let x = step / 2; x < size; x += step) {
      for (let y = step / 2; y < size; y += step) {
        ctx.beginPath()
        ctx.arc(x, y, 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1
}

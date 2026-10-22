import type { EffectKind } from '../spec'
import { hash, type Effect } from './types'

/** Two soft pools of colour wandering slowly behind everything: what glass shows through. */
const gradientDrift: Effect = {
  maxOpacity: 0.4,
  draw(ctx, { t, w, h }, { intensity, speed, density, color }) {
    const s = t * (0.03 + speed * 0.15)
    const r = Math.max(w, h) * (0.3 + density * 0.4)
    ctx.globalAlpha = intensity * this.maxOpacity
    for (const [px, py] of [[0.3 + 0.2 * Math.sin(s), 0.3 + 0.2 * Math.cos(s * 1.3)], [0.7 + 0.2 * Math.cos(s * 0.8), 0.7 + 0.2 * Math.sin(s * 1.1)]] as const) {
      const g = ctx.createRadialGradient(px * w, py * h, 0, px * w, py * h, r)
      g.addColorStop(0, color)
      g.addColorStop(1, 'transparent')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
    ctx.globalAlpha = 1
  },
}

/** Fine, slowly changing film grain behind the UI. */
const grain: Effect = {
  maxOpacity: 0.1,
  draw(ctx, { t, w, h }, { intensity, speed, density, color }) {
    const count = Math.round(((w * h) / 900) * (0.3 + density))
    const seed = Math.floor(t * (1 + speed * 6))
    ctx.fillStyle = color
    ctx.globalAlpha = intensity * this.maxOpacity
    for (let i = 0; i < count; i += 1) ctx.fillRect(hash(i, seed) * w, hash(i + 7, seed) * h, 1, 1)
    ctx.globalAlpha = 1
  },
}

export const EFFECTS: Record<EffectKind, Effect> = {
  'gradient-drift': gradientDrift,
  'grain': grain,
}

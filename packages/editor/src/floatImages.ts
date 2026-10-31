import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

type Point = { x: number; y: number }

/**
 * Where a picture dropped at `drop` (viewport) sits in its box: its top-left, in pixels from the
 * box content's top-left, given the point of the picture it was held by. Sideways it stays inside
 * the box; downwards it may go past the text, and the box grows to hold it (`fitFloats`).
 */
export function floatPosition(drop: Point, grab: Point, area: { left: number; top: number; width: number }, width: number): Point {
  const x = Math.round(Math.min(Math.max(0, drop.x - grab.x - area.left), Math.max(0, area.width - width)))
  const y = Math.round(Math.max(0, drop.y - grab.y - area.top))
  return { x, y }
}

/**
 * A floating picture takes no room in the text, so the box content is made at least tall enough to
 * hold the lowest one. Measured, not stored: the picture's height depends on its loaded size.
 */
export function fitFloats(el: HTMLElement): void {
  const floats = el.querySelectorAll<HTMLImageElement>('img[data-x]')
  // Runs on every keystroke: with nothing floating it must not make the browser lay out the page.
  if (floats.length === 0) {
    if (el.style.minHeight) el.style.minHeight = ''
    return
  }
  let bottom = 0
  for (const img of Array.from(floats)) bottom = Math.max(bottom, img.offsetTop + img.offsetHeight)
  const height = bottom > 0 ? `${bottom + (parseFloat(getComputedStyle(el).paddingBottom) || 0)}px` : ''
  if (el.style.minHeight !== height) el.style.minHeight = height
}

/** Keeps a box editor tall enough for its floating pictures, as they move, resize or finish loading. */
export const FloatFit = Extension.create({
  name: 'floatFit',
  addProseMirrorPlugins: () => [
    new Plugin({
      view: (view) => {
        const fit = () => fitFloats(view.dom)
        view.dom.addEventListener('load', fit, true)
        fit()
        return {
          update: fit,
          destroy: () => view.dom.removeEventListener('load', fit, true),
        }
      },
    }),
  ],
})

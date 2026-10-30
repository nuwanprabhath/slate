import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export const IMAGE_MIN_WIDTH = 32
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se']

export interface CornerDrag {
  corner: Corner
  /** The drawn width when the drag started, in CSS pixels. */
  startWidth: number
  /** Width over height; the height follows the width, so the aspect ratio holds. */
  aspect: number
  dx: number
  dy: number
}

/**
 * The width a corner drag gives: whichever of the horizontal and vertical movement is larger, both
 * measured outward from the dragged corner, between 32px and `max` (the box's content width).
 */
export function resizedWidth({ corner, startWidth, aspect, dx, dy }: CornerDrag, max: number): number {
  const fromX = corner.endsWith('e') ? dx : -dx
  const fromY = (corner.startsWith('s') ? dy : -dy) * aspect
  const grow = Math.abs(fromY) > Math.abs(fromX) ? fromY : fromX
  return Math.round(Math.min(max, Math.max(IMAGE_MIN_WIDTH, startWidth + grow)))
}

/** Sets (null: clears, back to natural size) an image's width as one undo step, keeping it selected. */
export function setImageWidth(view: EditorView, pos: number, width: number | null): void {
  const node = view.state.doc.nodeAt(pos)
  if (node?.type.name !== 'image' || node.attrs.width === width) return
  const tr = view.state.tr.setNodeAttribute(pos, 'width', width)
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)))
}

function contentWidth(view: EditorView): number {
  const style = getComputedStyle(view.dom)
  return view.dom.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
}

/**
 * The four corner handles of a clicked image. An image has no children to hold them and its DOM
 * keeps the selection classes the canvas and the tests read, so the handles are a layer laid over
 * it in its positioned ancestor (the box body), placed from the image's offsets, which the canvas
 * never transforms.
 */
class ResizeHandles {
  private layer: HTMLDivElement | null = null
  private img: HTMLImageElement | null = null
  private pos = -1
  private readonly observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.place())

  constructor(private readonly view: EditorView) {
    this.update()
  }

  update(): void {
    const { selection } = this.view.state
    const clicked = this.view.editable && selection instanceof NodeSelection && selection.node.type.name === 'image'
    const dom = clicked ? this.view.nodeDOM(selection.from) : null
    if (!dom || dom.nodeName !== 'IMG') {
      this.hide()
      return
    }
    this.pos = selection.from
    if (dom !== this.img) {
      this.hide()
      this.img = dom as HTMLImageElement
      this.layer = this.buildLayer()
      ;(this.img.offsetParent ?? this.view.dom.parentElement ?? this.view.dom).appendChild(this.layer)
      this.observer?.observe(this.img)
      this.observer?.observe(this.view.dom)
    }
    this.place()
  }

  destroy(): void {
    this.hide()
    this.observer?.disconnect()
  }

  private hide(): void {
    this.layer?.remove()
    this.layer = null
    this.img = null
    this.observer?.disconnect()
  }

  private place(): void {
    const { layer, img } = this
    if (!layer || !img) return
    layer.style.left = `${img.offsetLeft}px`
    layer.style.top = `${img.offsetTop}px`
    layer.style.width = `${img.offsetWidth}px`
    layer.style.height = `${img.offsetHeight}px`
  }

  private buildLayer(): HTMLDivElement {
    const layer = document.createElement('div')
    layer.className = 'slate-image-handles'
    layer.setAttribute('aria-hidden', 'true')
    for (const corner of CORNERS) {
      const handle = document.createElement('div')
      handle.className = 'slate-image-handle'
      handle.dataset.corner = corner
      this.listen(handle, corner)
      layer.appendChild(handle)
    }
    // The canvas below drags boxes and makes new ones on these; a handle's events stop here.
    for (const type of ['mousedown', 'click', 'dblclick'] as const) layer.addEventListener(type, (e) => e.stopPropagation())
    return layer
  }

  private listen(handle: HTMLElement, corner: Corner): void {
    let drag: { start: CornerDrag; x: number; y: number; max: number; width: number } | null = null
    handle.addEventListener('pointerdown', (e) => {
      const img = this.img
      if (!img || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      handle.setPointerCapture(e.pointerId)
      const startWidth = img.offsetWidth
      const start = { corner, startWidth, aspect: startWidth / Math.max(1, img.offsetHeight), dx: 0, dy: 0 }
      drag = { start, x: e.clientX, y: e.clientY, max: contentWidth(this.view), width: startWidth }
    })
    handle.addEventListener('pointermove', (e) => {
      if (!drag || !this.img) return
      drag.width = resizedWidth({ ...drag.start, dx: e.clientX - drag.x, dy: e.clientY - drag.y }, drag.max)
      this.img.style.width = `${drag.width}px`
      this.place()
    })
    const end = (commit: boolean) => (e: PointerEvent) => {
      if (!drag) return
      const { width, start } = drag
      drag = null
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      if (this.img) this.img.style.width = ''
      if (commit && width !== start.startWidth) setImageWidth(this.view, this.pos, width)
      else this.place()
    }
    handle.addEventListener('pointerup', end(true))
    handle.addEventListener('pointercancel', end(false))
    handle.addEventListener('dblclick', () => setImageWidth(this.view, this.pos, null))
  }
}

/** Corner handles that resize a clicked image, keeping its aspect ratio; the width is the image node's `width`. */
export const ImageResize = Extension.create({
  name: 'imageResize',
  addProseMirrorPlugins: () => [new Plugin({ view: (view) => new ResizeHandles(view) })],
})

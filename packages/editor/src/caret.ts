import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Chromium paints the native caret for the macOS system font (San Francisco) from the ascender
 * only down to the baseline, although the range rect is the full line box. So while the
 * selection is a collapsed text cursor in a focused editor, this draws the caret as an element
 * and makes the native one transparent; every other state (range, node selection, gap cursor,
 * IME composition, blur) shows the native caret again.
 */
export const SlateCaret = Extension.create({
  name: 'slateCaret',
  addProseMirrorPlugins: () => [new Plugin({ view: (view) => new CaretView(view) })],
})

class CaretView {
  private readonly el = document.createElement('div')
  private frame = 0
  private blink: ReturnType<typeof setInterval> | undefined

  constructor(private readonly view: EditorView) {
    this.el.className = 'slate-caret'
    this.el.dataset.testid = 'slate-caret'
    this.el.style.display = 'none'
    view.dom.addEventListener('focus', this.schedule)
    view.dom.addEventListener('blur', this.schedule)
    view.dom.addEventListener('compositionstart', this.schedule)
    view.dom.addEventListener('compositionend', this.schedule)
    window.addEventListener('resize', this.schedule)
    // Capture: the page's scroll container is an ancestor this view does not know.
    document.addEventListener('scroll', this.schedule, true)
    document.fonts.addEventListener('loadingdone', this.schedule)
    void document.fonts.ready.then(this.schedule)
    this.schedule()
  }

  update() {
    this.schedule()
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    clearInterval(this.blink)
    const dom = this.view.dom
    dom.removeEventListener('focus', this.schedule)
    dom.removeEventListener('blur', this.schedule)
    dom.removeEventListener('compositionstart', this.schedule)
    dom.removeEventListener('compositionend', this.schedule)
    window.removeEventListener('resize', this.schedule)
    document.removeEventListener('scroll', this.schedule, true)
    document.fonts.removeEventListener('loadingdone', this.schedule)
    dom.classList.remove('slate-caret-drawn')
    this.el.remove()
  }

  private readonly schedule = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  /**
   * Solid again after every move, then a 1 s blink. A timer, not a CSS animation: an infinite
   * steps() animation runs on the main thread every frame and doubled the keystroke time.
   */
  private restartBlink() {
    clearInterval(this.blink)
    if (document.documentElement.dataset.motion === 'reduced') return
    this.blink = setInterval(() => {
      this.el.style.visibility = this.el.style.visibility ? '' : 'hidden'
    }, 500)
  }

  private draw() {
    const { view, el } = this
    const sel = view.state.selection
    const host = view.dom.parentElement
    const show =
      !view.isDestroyed && host && view.hasFocus() && !view.composing && sel instanceof TextSelection && sel.empty
    if (!show) {
      clearInterval(this.blink)
      el.style.display = 'none'
      view.dom.classList.remove('slate-caret-drawn')
      return
    }
    if (el.parentElement !== host) {
      // The editor's own wrapper is the caret's containing block, so it scrolls with the text.
      host.style.position = 'relative'
      host.appendChild(el)
    }
    // Reads first, then writes: one layout per frame.
    const coords = view.coordsAtPos(sel.head)
    const at = view.domAtPos(sel.head).node
    const text = at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement!
    const style = getComputedStyle(text)
    const origin = host.getBoundingClientRect()
    const height = `${Math.max(coords.bottom - coords.top, parseFloat(style.fontSize) || 0)}px`
    // A transform on its own layer moves the caret without repainting the text under it.
    el.style.transform = `translate(${coords.left - origin.left}px, ${coords.top - origin.top}px)`
    if (el.style.height !== height) el.style.height = height
    if (el.style.color !== style.color) el.style.color = style.color
    el.style.display = ''
    el.style.visibility = ''
    this.restartBlink()
    view.dom.classList.add('slate-caret-drawn')
  }
}

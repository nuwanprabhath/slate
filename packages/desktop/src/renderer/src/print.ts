/**
 * File → Print… and Export Page as PDF…: the open page "as on screen". print.css, under
 * `html.print-page`, hides the app around the page; this sizes the canvas to its boxes and scales it
 * to the paper width. `zoom` (not a transform) so the scaled height is what Chromium splits into sheets.
 */

/** A4's width less the PDF export's 1 cm margins, in CSS px: the narrower of A4 and Letter, so either fits. */
export const PRINT_WIDTH_PX = 718

export interface BoxRect {
  left: number
  top: number
  width: number
  height: number
}

export function printLayout(boxes: readonly BoxRect[], paperWidth = PRINT_WIDTH_PX): { width: number; height: number; zoom: number } {
  const width = boxes.reduce((max, b) => Math.max(max, b.left + b.width), 0)
  const height = boxes.reduce((max, b) => Math.max(max, b.top + b.height), 0)
  return { width, height, zoom: width > paperWidth ? paperWidth / width : 1 }
}

let busy = false

export async function printPage(kind: 'print' | 'pdf'): Promise<void> {
  const canvas = document.querySelector<HTMLElement>('.slate-canvas')
  if (!canvas || busy) return
  busy = true
  const boxes = Array.from(canvas.querySelectorAll<HTMLElement>('.slate-box'), (b) => ({ left: b.offsetLeft, top: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight }))
  const { width, height, zoom } = printLayout(boxes)
  const root = document.documentElement
  root.style.setProperty('--print-width', `${width}px`)
  root.style.setProperty('--print-height', `${height}px`)
  root.style.setProperty('--print-zoom', String(zoom))
  root.classList.add('print-page')
  try {
    const title = document.querySelector<HTMLInputElement>('[data-testid="page-title"]')?.value ?? ''
    await window.slate.printPage(kind === 'print' ? { kind } : { kind, title })
  } finally {
    root.classList.remove('print-page')
    busy = false
  }
}

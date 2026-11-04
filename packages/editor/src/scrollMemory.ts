export interface ScrollSpot {
  left: number
  top: number
}

/** Where each page was scrolled to, for this run of the app only, least recently saved dropped first. */
export class ScrollMemory {
  private spots = new Map<string, ScrollSpot>()
  constructor(private readonly max = 200) {}

  get(key: string): ScrollSpot | undefined {
    return this.spots.get(key)
  }

  set(key: string, spot: ScrollSpot): void {
    this.spots.delete(key)
    this.spots.set(key, spot)
    if (this.spots.size > this.max) this.spots.delete(this.spots.keys().next().value!)
  }
}

export const pageScrolls = new ScrollMemory()

interface Pane {
  scrollTop: number
  scrollLeft: number
  scrollTo(left: number, top: number): void
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void
  removeEventListener(type: string, fn: () => void): void
}

interface KeepScrollOptions {
  memory?: ScrollMemory
  /** Calls `onResize` whenever the content's size changes; returns the stop. */
  watch: (onResize: () => void) => () => void
  /** Calls `giveUp` when another part of the app takes over the scroll (the find bar); returns the stop. */
  interrupt?: (giveUp: () => void) => () => void
  setTimer?: (fn: () => void, ms: number) => () => void
}

/** Long enough for a large page's boxes to measure, short enough that nothing jumps once the person is reading. */
const RESTORE_MS = 3000
/** What the person does to take the page over. */
const TAKE_OVER = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * Saves where `pane` is scrolled to under `key`, and first scrolls it back to the place saved last
 * time. The canvas starts short and grows as its boxes measure, and a box swapping its static render
 * for its editor empties for a moment, which pulls the scroll up with it (to the top on a one-box
 * page). So until the person reaches for the page, `interrupt` fires or RESTORE_MS pass, the saved
 * place is re-applied whenever the content changes size or the page moves away from it. Returns the stop.
 */
export function keepScroll(pane: Pane, key: string, { memory = pageScrolls, watch, interrupt, setTimer = defaultTimer }: KeepScrollOptions): () => void {
  const target = memory.get(key)
  let restoring = target !== undefined && (target.top > 0 || target.left > 0)

  const apply = () => {
    if (restoring && target) pane.scrollTo(target.left, target.top)
  }
  const giveUp = () => {
    restoring = false
  }
  const onScroll = () => {
    if (restoring) return apply()
    memory.set(key, { left: pane.scrollLeft, top: pane.scrollTop })
  }

  apply()
  const unwatch = watch(apply)
  const uninterrupt = interrupt?.(giveUp)
  const cancelTimer = setTimer(giveUp, RESTORE_MS)
  pane.addEventListener('scroll', onScroll, { passive: true })
  for (const type of TAKE_OVER) pane.addEventListener(type, giveUp, { passive: true })
  return () => {
    unwatch()
    uninterrupt?.()
    cancelTimer()
    pane.removeEventListener('scroll', onScroll)
    for (const type of TAKE_OVER) pane.removeEventListener(type, giveUp)
  }
}

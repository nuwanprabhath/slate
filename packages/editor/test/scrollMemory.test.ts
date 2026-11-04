import { describe, expect, it } from 'vitest'
import { keepScroll, ScrollMemory } from '../src/scrollMemory'

/** A scroll pane whose content grows as boxes measure, and whose scroll events the test fires. */
class FakePane {
  scrollTop = 0
  scrollLeft = 0
  contentHeight: number
  readonly height = 500
  private listeners = new Map<string, Set<() => void>>()
  private grow: (() => void) | null = null
  constructor(contentHeight: number) {
    this.contentHeight = contentHeight
  }
  scrollTo(left: number, top: number): void {
    this.scrollLeft = left
    this.scrollTop = Math.max(0, Math.min(top, this.contentHeight - this.height))
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
  /** What a person scrolling, or another part of the app, does. */
  userScroll(top: number): void {
    this.scrollTo(this.scrollLeft, top)
    this.fire('scroll')
  }
  /** The canvas grows as more boxes report their height, or shrinks while a box swaps to its editor. */
  growTo(height: number): void {
    this.contentHeight = height
    const top = this.scrollTop
    this.scrollTop = Math.max(0, Math.min(top, height - this.height))
    this.grow?.()
    if (this.scrollTop !== top) this.fire('scroll')
  }
  watch = (onGrow: () => void) => {
    this.grow = onGrow
    return () => (this.grow = null)
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

describe('ScrollMemory', () => {
  it('forgets the least recently saved page past its limit', () => {
    const memory = new ScrollMemory(2)
    memory.set('a', { left: 0, top: 1 })
    memory.set('b', { left: 0, top: 2 })
    memory.set('a', { left: 0, top: 3 })
    memory.set('c', { left: 0, top: 4 })
    expect(memory.get('b')).toBeUndefined()
    expect(memory.get('a')).toEqual({ left: 0, top: 3 })
    expect(memory.get('c')).toEqual({ left: 0, top: 4 })
  })
})

describe('keepScroll', () => {
  it('saves where the page was scrolled to, and puts a reopened page back there', () => {
    const memory = new ScrollMemory()
    const first = new FakePane(3000)
    const stop = keepScroll(first, 'page-1', { memory, watch: first.watch })
    first.userScroll(1200)
    stop()

    const again = new FakePane(3000)
    keepScroll(again, 'page-1', { memory, watch: again.watch })
    expect(again.scrollTop).toBe(1200)
  })

  it('keeps going until the canvas has grown tall enough to reach the saved place', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(800)
    keepScroll(pane, 'page-1', { memory, watch: pane.watch })
    expect(pane.scrollTop).toBe(300)
    pane.fire('scroll')
    pane.growTo(1400)
    expect(pane.scrollTop).toBe(900)
    pane.growTo(4000)
    expect(pane.scrollTop).toBe(1200)
    // Restored: the saved place is not overwritten by the partial positions on the way there.
    expect(memory.get('page-1')).toEqual({ left: 0, top: 1200 })
  })

  it('goes back to the saved place when the canvas shrinks for a moment after reaching it', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(3000)
    keepScroll(pane, 'page-1', { memory, watch: pane.watch })
    expect(pane.scrollTop).toBe(1200)
    pane.growTo(600)
    expect(pane.scrollTop).toBe(100)
    pane.growTo(3000)
    expect(pane.scrollTop).toBe(1200)
    expect(memory.get('page-1')).toEqual({ left: 0, top: 1200 })
  })

  it('puts the page back when it moves by itself while restoring', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(3000)
    keepScroll(pane, 'page-1', { memory, watch: pane.watch })
    pane.userScroll(0)
    expect(pane.scrollTop).toBe(1200)
    expect(memory.get('page-1')).toEqual({ left: 0, top: 1200 })
  })

  it('stops restoring when the find bar takes over, and saves where it scrolls to', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(3000)
    let findTakesOver: (() => void) | null = null
    keepScroll(pane, 'page-1', { memory, watch: pane.watch, interrupt: (giveUp) => ((findTakesOver = giveUp), () => (findTakesOver = null)) })
    findTakesOver!()
    pane.userScroll(100)
    expect(pane.scrollTop).toBe(100)
    expect(memory.get('page-1')).toEqual({ left: 0, top: 100 })
  })

  it('saves where the person scrolls to once they take over', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(3000)
    keepScroll(pane, 'page-1', { memory, watch: pane.watch })
    pane.fire('wheel')
    pane.userScroll(400)
    expect(memory.get('page-1')).toEqual({ left: 0, top: 400 })
  })

  it('stops restoring when the person reaches for the page', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(800)
    keepScroll(pane, 'page-1', { memory, watch: pane.watch })
    pane.fire('pointerdown')
    pane.growTo(4000)
    expect(pane.scrollTop).toBe(300)
  })

  it('gives up restoring after a while, so a late-growing canvas never jumps under the person', () => {
    const memory = new ScrollMemory()
    memory.set('page-1', { left: 0, top: 1200 })
    const pane = new FakePane(800)
    let giveUp: (() => void) | null = null
    keepScroll(pane, 'page-1', { memory, watch: pane.watch, setTimer: (fn) => ((giveUp = fn), () => (giveUp = null)) })
    giveUp!()
    pane.growTo(4000)
    expect(pane.scrollTop).toBe(300)
  })

  it('leaves a page never scrolled at the top, and removes its listeners when stopped', () => {
    const memory = new ScrollMemory()
    const pane = new FakePane(3000)
    const stop = keepScroll(pane, 'page-2', { memory, watch: pane.watch })
    expect(pane.scrollTop).toBe(0)
    stop()
    expect(pane.listenerCount()).toBe(0)
  })
})

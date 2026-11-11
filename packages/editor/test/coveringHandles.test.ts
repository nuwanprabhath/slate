import { describe, expect, it } from 'vitest'
import { coveringHandles, type OverlapBox } from '../src/coveringHandles'

const HANDLE_HEIGHT = 18
const heights = (h: Record<string, number>) => (id: string) => h[id]

/** What the canvas used to do: compare every box with every other one. */
function pairwise(boxes: readonly OverlapBox[], measured: (id: string) => number | undefined): Set<string> {
  const out = new Set<string>()
  for (const b of boxes) {
    const top = b.y - HANDLE_HEIGHT
    for (const o of boxes) {
      if (o.id === b.id) continue
      const oh = Math.max(measured(o.id) ?? 0, o.height ?? 0)
      if (b.x < o.x + o.width && o.x < b.x + b.width && top < o.y + oh && o.y < b.y) {
        out.add(b.id)
        break
      }
    }
  }
  return out
}

describe('coveringHandles', () => {
  it('marks a box whose handle bar lies over the box above it', () => {
    const boxes: OverlapBox[] = [
      { id: 'a', x: 0, y: 0, width: 200 },
      { id: 'b', x: 0, y: 100, width: 200 },
    ]
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights({ a: 110, b: 50 }))).toEqual(new Set(['b']))
  })

  it('leaves a box alone when the one above ends before its handle band', () => {
    const boxes: OverlapBox[] = [
      { id: 'a', x: 0, y: 0, width: 200 },
      { id: 'b', x: 0, y: 100, width: 200 },
    ]
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights({ a: 50, b: 50 }))).toEqual(new Set())
  })

  it('leaves a box alone when the one above is beside it, not over it', () => {
    const boxes: OverlapBox[] = [
      { id: 'a', x: 300, y: 0, width: 200 },
      { id: 'b', x: 0, y: 100, width: 200 },
    ]
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights({ a: 400, b: 50 }))).toEqual(new Set())
  })

  it('uses the dragged height when it is taller than the measured one', () => {
    const boxes: OverlapBox[] = [
      { id: 'a', x: 0, y: 0, width: 200, height: 200 },
      { id: 'b', x: 0, y: 100, width: 200 },
    ]
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights({ a: 10, b: 50 }))).toEqual(new Set(['b']))
  })

  it('ignores a box at the same y, whose handle is at the same height', () => {
    const boxes: OverlapBox[] = [
      { id: 'a', x: 0, y: 40, width: 200 },
      { id: 'b', x: 0, y: 40, width: 200 },
    ]
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights({ a: 100, b: 100 }))).toEqual(new Set())
  })

  it('answers exactly as the pairwise pass did, over a pseudo-random page', () => {
    let seed = 12345
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    const boxes: OverlapBox[] = []
    const measured: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const id = `b${i}`
      boxes.push({ id, x: rand(800), y: rand(2000), width: 100 + rand(300) })
      measured[id] = 20 + rand(200)
    }
    expect(coveringHandles(boxes, HANDLE_HEIGHT, heights(measured))).toEqual(pairwise(boxes, heights(measured)))
  })

  it('stays near-linear on a page of 2,000 boxes', () => {
    const boxes: OverlapBox[] = []
    const measured: Record<string, number> = {}
    // A long page: boxes in three columns running down it, each row slightly overlapping the one above.
    for (let i = 0; i < 2000; i++) {
      const id = `b${i}`
      boxes.push({ id, x: (i % 3) * 300, y: Math.floor(i / 3) * 90, width: 280 })
      measured[id] = 100
    }
    let looks = 0
    const measuredHeight = (id: string) => (looks++, measured[id])
    const run = () => coveringHandles(boxes, HANDLE_HEIGHT, measuredHeight)
    const marked = run()
    expect(marked.size).toBe(1997) // every box but the top row sits under one
    // Deterministic under load, unlike a wall clock: the pairwise pass cost ~4,000,000 looks.
    looks = 0
    run()
    expect(looks).toBeLessThan(boxes.length * 4)
    let best = Infinity
    for (let i = 0; i < 7; i++) {
      const t = performance.now()
      run()
      best = Math.min(best, performance.now() - t)
    }
    expect(best).toBeLessThan(10)
  })
})

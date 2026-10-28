import { describe, expect, it } from 'vitest'
import { arrangeBoxes, hasOverlaps, type BoxRect } from '../src/layout'

const box = (id: string, x: number, y: number, width: number, height: number): BoxRect => ({ id, x, y, width, height })

function apply(boxes: BoxRect[], moved: Map<string, number>): BoxRect[] {
  return boxes.map((b) => ({ ...b, y: moved.get(b.id) ?? b.y }))
}

const overlap = (a: BoxRect, b: BoxRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function anyOverlap(boxes: BoxRect[]): boolean {
  return boxes.some((a, i) => boxes.some((b, j) => i < j && overlap(a, b)))
}

describe('arrangeBoxes', () => {
  it('leaves a layout without overlaps untouched, even boxes closer than the gap', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 0, 104, 200, 50), box('c', 300, 0, 100, 400)]
    expect(arrangeBoxes(boxes).size).toBe(0)
  })

  it('moves an overlapping box down below the other with the gap, keeping its x', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 50, 40, 200, 50)]
    const moved = arrangeBoxes(boxes)
    expect(moved).toEqual(new Map([['b', 116]]))
  })

  it('honours a custom gap', () => {
    expect(arrangeBoxes([box('a', 0, 0, 200, 100), box('b', 0, 50, 200, 50)], 0)).toEqual(new Map([['b', 100]]))
  })

  it('moves the later box in (y, x) order, never the earlier one', () => {
    const boxes = [box('b', 100, 10, 200, 50), box('a', 0, 10, 200, 50)]
    expect(arrangeBoxes(boxes)).toEqual(new Map([['b', 76]]))
  })

  it('cascades a chain of overlaps down a column', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 0, 50, 200, 100), box('c', 0, 120, 200, 100)]
    const moved = arrangeBoxes(boxes)
    expect(moved.get('b')).toBe(116)
    expect(moved.get('c')).toBe(232)
  })

  it('does not move a box that only overlaps after it would be moved into it: it clears all placed boxes', () => {
    // b moves below a and lands on c's spot, so it must clear c too (c is placed first: it is higher), so it settles below c.
    const boxes = [box('a', 0, 0, 200, 100), box('c', 300, 40, 200, 100), box('b', 150, 50, 200, 50)]
    const after = apply(boxes, arrangeBoxes(boxes))
    expect(anyOverlap(after)).toBe(false)
    expect(after.find((b) => b.id === 'b')!.y).toBe(156)
  })

  it('preserves the vertical order of boxes', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 10, 20, 200, 30), box('c', 20, 40, 200, 30)]
    const after = apply(boxes, arrangeBoxes(boxes))
    const ys = Object.fromEntries(after.map((b) => [b.id, b.y]))
    expect(ys.a!).toBeLessThan(ys.b!)
    expect(ys.b!).toBeLessThan(ys.c!)
  })

  it('only ever moves boxes down and keeps every x and size', () => {
    const boxes = [box('a', 0, 30, 200, 100), box('b', 100, 0, 200, 100)]
    const moved = arrangeBoxes(boxes)
    for (const [id, y] of moved) expect(y).toBeGreaterThan(boxes.find((b) => b.id === id)!.y)
  })

  it('leaves no overlap among many random boxes and is stable on a second run', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const boxes = Array.from({ length: 200 }, (_, i) => box(`b${String(i)}`, Math.floor(rnd() * 1500), Math.floor(rnd() * 3000), 120 + Math.floor(rnd() * 400), 20 + Math.floor(rnd() * 300)))
    const after = apply(boxes, arrangeBoxes(boxes))
    expect(anyOverlap(after)).toBe(false)
    expect(arrangeBoxes(after).size).toBe(0)
  })

  it('ignores boxes that touch edge to edge', () => {
    expect(arrangeBoxes([box('a', 0, 0, 100, 100), box('b', 100, 0, 100, 100), box('c', 0, 100, 100, 10)]).size).toBe(0)
  })
})

describe('hasOverlaps', () => {
  it('is true only when two boxes overlap', () => {
    expect(hasOverlaps([box('a', 0, 0, 100, 100)])).toBe(false)
    expect(hasOverlaps([box('a', 0, 0, 100, 100), box('b', 100, 0, 100, 100)])).toBe(false)
    expect(hasOverlaps([box('a', 0, 0, 100, 100), box('b', 99, 99, 100, 100)])).toBe(true)
  })
})

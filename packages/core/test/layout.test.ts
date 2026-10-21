import { describe, expect, it } from 'vitest'
import { computePush, type BoxRect } from '../src/layout'

const box = (id: string, x: number, y: number, width: number, height: number): BoxRect => ({ id, x, y, width, height })

describe('computePush', () => {
  it('moves nothing when the box shrinks or keeps its height', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 0, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 80).size).toBe(0)
    expect(computePush(boxes, 'a', 100, 100).size).toBe(0)
  })

  it('pushes a horizontally overlapping box below by the growth delta', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 100, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150)).toEqual(new Map([['b', 170]]))
  })

  it('ignores boxes below that do not overlap horizontally', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 250, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150).size).toBe(0)
  })

  it('ignores boxes above or beside the growing box', () => {
    const boxes = [box('a', 0, 100, 200, 100), box('above', 0, 0, 200, 50), box('beside', 0, 150, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150).size).toBe(0)
  })

  it('cascades through boxes that are pushed', () => {
    // c does not overlap a horizontally, but it sits under b, which a pushes.
    const boxes = [box('a', 0, 0, 200, 100), box('b', 150, 120, 200, 50), box('c', 300, 200, 200, 50)]
    expect(computePush(boxes, 'a', 100, 140)).toEqual(new Map([['b', 160], ['c', 240]]))
  })

  it('moves each box at most once', () => {
    const boxes = [box('a', 0, 0, 400, 100), box('b', 0, 120, 200, 50), box('c', 0, 200, 400, 50)]
    expect(computePush(boxes, 'a', 100, 130)).toEqual(new Map([['b', 150], ['c', 230]]))
  })

  it('returns nothing for an unknown box id', () => {
    expect(computePush([box('a', 0, 0, 10, 10)], 'zzz', 10, 20).size).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { newId, randomFraction, randomInt } from '../src/ids'

describe('ids and randomness (the sanctioned replacements for Math.random)', () => {
  it('newId returns distinct UUIDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('randomInt stays in [0, n) and reaches every value', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = randomInt(7)
      expect(Number.isInteger(v) && v >= 0 && v < 7).toBe(true)
      seen.add(v)
    }
    expect(seen.size).toBe(7)
  })

  it('randomInt refuses a bound that is not a positive safe integer', () => {
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 53]) expect(() => randomInt(n), String(n)).toThrow(RangeError)
  })

  it('randomFraction is in [0, 1)', () => {
    for (let i = 0; i < 500; i++) {
      const f = randomFraction()
      expect(f >= 0 && f < 1).toBe(true)
    }
  })
})

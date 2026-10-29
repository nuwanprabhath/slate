import { describe, expect, it } from 'vitest'
import { devicesLacking, PQ_CAPABILITY } from './deviceGate'

const rec = (extra: Record<string, number> = {}, name = 'D') => ({ name, ...extra })

describe('deviceGate', () => {
  it('T-PQ-B2-02: a record without pq, with pq 0, or unreadable is listed; pq 1 and pq 2 are not', () => {
    expect(PQ_CAPABILITY).toBe(1)
    const none = rec({}, 'none')
    const zero = rec({ pq: 0 }, 'zero')
    const unreadable = { name: 'A device record Slate cannot read' }
    const one = rec({ pq: 1 }, 'one')
    const two = rec({ pq: 2 }, 'two')
    expect(devicesLacking([none, zero, unreadable, one, two], 'pq', 1)).toEqual([none, zero, unreadable])
  })

  it('T-PQ-B2-02: the epochs capability is checked the same way, and the level is respected', () => {
    const e1 = rec({ epochs: 1, pq: 1 }, 'e1')
    const e0 = rec({ pq: 1 }, 'e0')
    expect(devicesLacking([e1, e0], 'epochs', 1)).toEqual([e0])
    expect(devicesLacking([e1], 'pq', 2)).toEqual([e1])
  })

  it('T-PQ-B2-02: a record whose capability is not a number is listed', () => {
    const bad = { name: 'bad', pq: '1' as unknown as number }
    expect(devicesLacking([bad], 'pq', 1)).toEqual([bad])
  })
})

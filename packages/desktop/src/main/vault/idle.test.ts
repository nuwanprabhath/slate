import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleTimer } from './idle'

describe('idle lock timer (§6.5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires after the idle time with no input', () => {
    const onIdle = vi.fn()
    const t = new IdleTimer(onIdle)
    t.start(60_000)
    vi.advanceTimersByTime(59_000)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('input pushes the deadline back', () => {
    const onIdle = vi.fn()
    const t = new IdleTimer(onIdle)
    t.start(60_000)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40_000)
      t.touch()
    }
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(61_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('0 means never, and stop cancels', () => {
    const onIdle = vi.fn()
    const t = new IdleTimer(onIdle)
    t.start(0)
    vi.advanceTimersByTime(10 * 24 * 3600_000)
    t.start(1000)
    t.stop()
    vi.advanceTimersByTime(5000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

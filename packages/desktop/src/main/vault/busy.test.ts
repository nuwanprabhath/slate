import { describe, expect, it } from 'vitest'
import { BUSY_MESSAGE, VaultBusy } from './busy'

describe('VaultBusy', () => {
  it('refuses every guarded vault change while a migration runs, and allows them after', async () => {
    const busy = new VaultBusy()
    let cancelled = 0
    const cancel = busy.guard(() => {
      cancelled++
    })
    let finish!: () => void
    const running = busy.run(() => new Promise<void>((r) => (finish = r)))
    expect(busy.running).toBe(true)
    expect(() => cancel()).toThrow(BUSY_MESSAGE)
    await expect(busy.run(async () => 1)).rejects.toThrow(BUSY_MESSAGE)
    expect(cancelled).toBe(0)
    finish()
    await running
    expect(busy.running).toBe(false)
    cancel()
    expect(cancelled).toBe(1)
  })

  it('is free again after a migration fails', async () => {
    const busy = new VaultBusy()
    await expect(busy.run(() => Promise.reject(new Error('copy broke')))).rejects.toThrow('copy broke')
    expect(busy.running).toBe(false)
  })
})

// Review C6 (LOW): module faults reported while a self-test runs are kept, not dropped, and overlapping runs are
// counted, so the first to finish does not open the gate for faults during the second.
import { describe, expect, it } from 'vitest'
import { FaultSupervisor } from './supervisor'

const later = () => {
  let release!: () => void
  const done = new Promise<void>((r) => (release = r))
  return { done, release }
}

describe('FaultSupervisor', () => {
  it('acts at once outside a self-test, and never before start-up handed over or after a failure', () => {
    const acted: string[] = []
    let ready = false
    const s = new FaultSupervisor(() => ready, (k) => void acted.push(k))
    s.report('fault')
    ready = true
    s.report('fault')
    s.report('error-state')
    expect(acted).toEqual(['fault', 'error-state'])
  })

  it('keeps a fault seen during overlapping self-tests until the last one ends, the error state winning', async () => {
    const acted: string[] = []
    const s = new FaultSupervisor(() => true, (k) => void acted.push(k))
    const a = later()
    const b = later()
    const first = s.during(() => a.done)
    const second = s.during(() => b.done)
    s.report('fault')
    a.release()
    await first
    // The second run is still going: the first one finishing must not act yet.
    s.report('error-state')
    s.report('fault')
    expect(acted).toEqual([])
    b.release()
    await second
    expect(acted).toEqual(['error-state'])
  })

  it('drops what it kept when the self-test itself failed (failClosed already ran)', async () => {
    const acted: string[] = []
    let ready = true
    const s = new FaultSupervisor(() => ready, (k) => void acted.push(k))
    await s.during(async () => {
      s.report('error-state')
      ready = false
    })
    expect(acted).toEqual([])
  })
})

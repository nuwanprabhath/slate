import { describe, expect, it } from 'vitest'
import type { PqReadiness } from '../../../shared/api'
import { FORMAT_DONE, FORMAT_RUNNING, nextFormatBanner } from './vaultFormatBanner'

type Vault = PqReadiness['vault']
const header = (version: 1 | 2 | 3, upgrade: 'none' | 'waiting-devices' | 'running' | 'offer-v1' | 'done'): Vault => ({ kind: 'header', version, upgrade })

describe('nextFormatBanner', () => {
  it('T-PQ-D2-06: shows a line while the upgrade runs and remembers a v2 vault was seen', () => {
    expect(nextFormatBanner({ sawV2: false }, header(2, 'running'))).toEqual({ next: { sawV2: true }, show: 'running' })
    expect(FORMAT_RUNNING).not.toMatch(/quantum-proof|unbreakable|validated|certified/i)
  })
  it('T-PQ-D2-06: "updated" shows after a v2 vault became v3, and the memory is cleared so it shows once', () => {
    const step = nextFormatBanner({ sawV2: true }, header(3, 'done'))
    expect(step).toEqual({ next: { sawV2: false }, show: 'done' })
    expect(nextFormatBanner(step.next, header(3, 'done')).show).toBeNull()
  })
  it('T-PQ-D2-06: a vault that was never seen at v2 (new, or already current) says nothing', () => {
    expect(nextFormatBanner({ sawV2: false }, header(3, 'done')).show).toBeNull()
    expect(nextFormatBanner({ sawV2: false }, { kind: 'none' }).show).toBeNull()
  })
  it('T-PQ-D2-06: waiting for devices is not an update in progress, but the v2 is remembered', () => {
    expect(nextFormatBanner({ sawV2: false }, header(2, 'waiting-devices'))).toEqual({ next: { sawV2: true }, show: null })
    expect(FORMAT_DONE).not.toMatch(/quantum-proof|unbreakable|validated|certified/i)
  })
})

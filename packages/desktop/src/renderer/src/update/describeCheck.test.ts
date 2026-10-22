import { describe, expect, it } from 'vitest'
import { describeCheck, formatChecked } from './describeCheck'

const base = { kind: 'deb', visible: false } as const

describe('describeCheck', () => {
  it('says up to date, available, and the error', () => {
    expect(describeCheck({ ...base, phase: 'idle' })).toBe("You're up to date.")
    expect(describeCheck({ ...base, phase: 'available', version: '9.9.9' })).toBe('Slate 9.9.9 is available.')
    expect(describeCheck({ ...base, phase: 'error', error: 'update check failed: offline' })).toBe('Could not check: update check failed: offline')
  })
  it('notes a skipped newer version', () => {
    expect(describeCheck({ ...base, phase: 'available', version: '9.9.9', skippedVersion: '9.9.9' })).toBe('Slate 9.9.9 is available (skipped).')
  })
})

describe('formatChecked', () => {
  it('says never when there is no time', () => {
    expect(formatChecked(undefined)).toBe('never')
  })
})

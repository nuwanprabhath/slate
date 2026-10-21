import { describe, expect, it } from 'vitest'
import { syncAgeText } from './syncAge'

const now = 10_000_000_000
describe('syncAgeText', () => {
  it('is empty when never synced', () => expect(syncAgeText(undefined, now)).toBe(''))
  it('says now under a minute', () => expect(syncAgeText(now - 30_000, now)).toBe('just now'))
  it('uses minutes', () => expect(syncAgeText(now - 2 * 60_000, now)).toBe('2 min ago'))
  it('uses hours', () => expect(syncAgeText(now - 3 * 3_600_000, now)).toBe('3 h ago'))
  it('uses a date after a day', () => expect(syncAgeText(now - 2 * 86_400_000, now)).toBe(new Date(now - 2 * 86_400_000).toLocaleDateString()))
})

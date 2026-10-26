import { describe, expect, it } from 'vitest'
import type { SyncState } from '../../../../shared/api'
import { securityStatusText } from './securityStatus'

const sync = (over: Partial<SyncState>): SyncState => ({ status: 'idle-synced', pushed: 0, pulled: 0, conflicts: 0, at: 1, enabled: true, provider: 'git', ...over })

describe('the Security status line (§10)', () => {
  it('names the sync folder only when sync is on and its vault check passed', () => {
    expect(securityStatusText('unlocked', sync({ lastSyncedAt: 1 }))).toBe('Your notes are encrypted on this computer and in your sync folder.')
  })

  it('says only "on this computer" when sync is off or the remote is not confirmed encrypted', () => {
    const local = 'Your notes are encrypted on this computer.'
    expect(securityStatusText('unlocked', null)).toBe(local)
    expect(securityStatusText('unlocked', sync({ enabled: false, status: 'disabled', provider: null }))).toBe(local)
    expect(securityStatusText('unlocked', sync({ status: 'syncing' }))).toBe(local)
    expect(securityStatusText('unlocked', sync({ lastSyncedAt: 1, vaultProblem: 'other-vault' }))).toBe(local)
    expect(securityStatusText('unlocked', sync({ lastSyncedAt: 1, vaultProblem: 'not-encrypted' }))).toBe(`${local} Your sync folder is not encrypted.`)
  })

  it('reports the unencrypted and unfinished states', () => {
    expect(securityStatusText('plaintext', sync({ lastSyncedAt: 1 }))).toBe('Your notes are not encrypted.')
    expect(securityStatusText('migrating', null)).toMatch(/did not finish/)
  })
})

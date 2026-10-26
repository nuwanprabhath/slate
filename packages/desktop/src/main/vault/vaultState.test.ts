import { describe, expect, it, vi } from 'vitest'
import { initialVaultState, notesOpen, VaultStateMachine, type VaultState } from './vaultState'

/** The machine after a passed power-up self-test handed over to `start` (and, for `unlocked`, an unlock). */
function machineAt(start: 'plaintext' | 'locked' | 'migrating' | 'unlocked'): VaultStateMachine {
  const vs = new VaultStateMachine()
  if (start === 'unlocked') {
    vs.to('locked')
    vs.to('unlocking')
  }
  vs.to(start)
  return vs
}

const ALL: readonly VaultState[] = ['selftest', 'selftest-failed', 'plaintext', 'locked', 'unlocking', 'unlocked', 'locking', 'migrating']

describe('vault state', () => {
  it('starts from the files in the data folder (§6.2, §15 N10)', () => {
    const files = { vault: true, localKeys: false, migration: true, plainDb: true }
    expect(initialVaultState({ ...files, vault: false })).toBe('plaintext')
    expect(initialVaultState({ ...files, localKeys: true })).toBe('locked')
    // An aborted migration: the plaintext database is still the one in use.
    expect(initialVaultState(files)).toBe('migrating')
  })

  it('never treats a missing key file alone as an unfinished migration', () => {
    // Opening `slate.db` here would put a fresh, empty plaintext database over an encrypted folder.
    expect(initialVaultState({ vault: true, localKeys: false, migration: false, plainDb: true })).toBe('locked')
    expect(initialVaultState({ vault: true, localKeys: false, migration: true, plainDb: false })).toBe('locked')
    expect(initialVaultState({ vault: true, localKeys: false, migration: false, plainDb: false })).toBe('locked')
  })

  it('opens notes only when unlocked, plaintext or migrating', () => {
    expect(notesOpen('unlocked')).toBe(true)
    expect(notesOpen('plaintext')).toBe(true)
    expect(notesOpen('migrating')).toBe(true)
    for (const s of ['locked', 'unlocking', 'locking'] as const) expect(notesOpen(s)).toBe(false)
  })

  it('S-1: starts in selftest, the only start state, and leaves it only for a start state or selftest-failed', () => {
    const vs = new VaultStateMachine()
    expect(vs.state).toBe('selftest')
    expect(notesOpen('selftest')).toBe(false)
    for (const next of ['unlocking', 'unlocked', 'locking', 'selftest'] as const) expect(() => new VaultStateMachine().to(next)).toThrow(/selftest →/)
    for (const next of ['plaintext', 'locked', 'migrating', 'selftest-failed'] as const) {
      const m = new VaultStateMachine()
      m.to(next)
      expect(m.state).toBe(next)
    }
  })

  it('S-7/S-9: every state can fall into selftest-failed, which is terminal and opens no notes', () => {
    const reach: Record<VaultState, () => VaultStateMachine> = {
      selftest: () => new VaultStateMachine(),
      'selftest-failed': () => {
        const m = new VaultStateMachine()
        m.fail()
        return m
      },
      plaintext: () => machineAt('plaintext'),
      locked: () => machineAt('locked'),
      unlocking: () => {
        const m = machineAt('locked')
        m.to('unlocking')
        return m
      },
      unlocked: () => machineAt('unlocked'),
      locking: () => {
        const m = machineAt('unlocked')
        m.to('locking')
        return m
      },
      migrating: () => machineAt('migrating'),
    }
    for (const from of ALL) {
      const m = reach[from]()
      expect(m.state).toBe(from)
      m.fail()
      expect(m.state).toBe('selftest-failed')
      // Idempotent: a second failure while failed is not an error.
      m.fail()
      for (const next of ALL) expect(() => m.to(next), `selftest-failed → ${next}`).toThrow()
    }
    expect(notesOpen('selftest-failed')).toBe(false)
  })

  it('tells listeners about the failure once', () => {
    const vs = machineAt('unlocked')
    const seen: VaultState[] = []
    vs.onChange((s) => seen.push(s))
    vs.fail()
    vs.fail()
    expect(seen).toEqual(['selftest-failed'])
  })

  it('walks the unlock and lock cycle and tells listeners', () => {
    const vs = machineAt('locked')
    const seen: string[] = []
    vs.onChange((s) => seen.push(s))
    vs.to('unlocking')
    vs.to('locked')
    vs.to('unlocking')
    vs.to('unlocked')
    vs.to('locking')
    vs.to('locked')
    expect(seen).toEqual(['unlocking', 'locked', 'unlocking', 'unlocked', 'locking', 'locked'])
  })

  it('refuses moves the lifecycle does not have', () => {
    const vs = machineAt('locked')
    expect(() => vs.to('unlocked')).toThrow(/locked → unlocked/)
    expect(() => machineAt('plaintext').to('locking')).toThrow()
    expect(() => machineAt('unlocked').to('unlocking')).toThrow()
    const listener = vi.fn()
    vs.onChange(listener)
    expect(() => vs.to('locking')).toThrow()
    expect(listener).not.toHaveBeenCalled()
    expect(vs.state).toBe('locked')
  })

  it('a plaintext folder migrates, and a finished migration is unlocked', () => {
    const vs = machineAt('plaintext')
    vs.to('migrating')
    vs.to('unlocked')
    expect(vs.state).toBe('unlocked')
  })

  it('lets a cancelled migration fall back to plaintext', () => {
    const vs = machineAt('migrating')
    vs.to('plaintext')
    expect(vs.state).toBe('plaintext')
  })
})

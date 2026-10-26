import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SCHEDULE_V1 } from './suite'
import { importKey } from '../../../test/vaultKeys'
import { KeyRing, Locked } from './keyring'
import { runLock, shouldClearClipboard } from './lockSequence'
import { VaultStateMachine } from './vaultState'

describe('lock sequence (§6.4, §15 N6)', () => {
  function fakes(flush: () => Promise<void> = async () => {}) {
    const calls: string[] = []
    const keyRing = new KeyRing(importKey(randomBytes(32), 'master'), importKey(randomBytes(32), 'db'), SCHEDULE_V1)
    // After a passed power-up self-test and an unlock (C6: the machine starts in `selftest`).
    const state = new VaultStateMachine()
    for (const next of ['locked', 'unlocking', 'unlocked'] as const) state.to(next)
    const steps = {
      flushRenderer: async () => {
        calls.push(`flush:${state.state}`)
        await flush()
      },
      stopEvents: () => void calls.push('stopEvents'),
      stopSync: async () => {
        await new Promise((r) => setTimeout(r, 5))
        calls.push('stopSync')
      },
      closeWatch: () => void calls.push('closeWatch'),
      closeDatabases: () => void calls.push('closeDatabases'),
      closeKeys: () => {
        calls.push('closeKeys')
        keyRing.close()
      },
      showLockWindow: () => void calls.push('showLockWindow'),
      clearClipboard: () => void calls.push('clearClipboard'),
    }
    return { calls, keyRing, state, steps }
  }

  it('runs the steps in order, the notes off screen right after the flush, and ends locked', async () => {
    const { calls, keyRing, state, steps } = fakes()
    await runLock(state, steps)
    expect(calls).toEqual(['flush:locking', 'showLockWindow', 'stopEvents', 'stopSync', 'closeWatch', 'closeDatabases', 'closeKeys', 'clearClipboard'])
    expect(state.state).toBe('locked')
    expect(() => keyRing.get('lk')).toThrow(Locked)
  })

  it('replaces the window before waiting on a slow sync', async () => {
    const { calls, state, steps } = fakes()
    let release!: () => void
    steps.stopSync = () => new Promise<void>((r) => (release = r))
    const locking = runLock(state, steps)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toContain('showLockWindow')
    expect(calls).not.toContain('closeKeys')
    release()
    await locking
  })

  it('lets note writes through only while the renderer flushes', async () => {
    const seen: boolean[] = []
    let writes = false
    const { state, steps } = fakes(async () => void seen.push(writes))
    await runLock(state, { ...steps, allowWrites: (on: boolean) => void (writes = on) })
    expect(seen).toEqual([true])
    expect(writes).toBe(false)
  })

  it('stops letting writes through when the flush times out', async () => {
    let writes = false
    const { state, steps } = fakes(() => new Promise(() => {}))
    await runLock(state, { ...steps, allowWrites: (on: boolean) => void (writes = on) }, { flushTimeoutMs: 20 })
    expect(writes).toBe(false)
  })

  it('closes the MCP socket (letting its request finish) before the databases close', async () => {
    const { calls, state, steps } = fakes()
    await runLock(state, {
      ...steps,
      closeMcp: async () => {
        await new Promise((r) => setTimeout(r, 5))
        calls.push('closeMcp')
      },
    })
    expect(calls.indexOf('closeMcp')).toBeGreaterThan(calls.indexOf('stopEvents'))
    expect(calls.indexOf('closeMcp')).toBeLessThan(calls.indexOf('closeDatabases'))
  })

  it('does not wait more than the timeout for a renderer that never answers', async () => {
    const { calls, state, steps } = fakes(() => new Promise(() => {}))
    const started = Date.now()
    await runLock(state, steps, { flushTimeoutMs: 30 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls.at(-1)).toBe('clearClipboard')
    expect(state.state).toBe('locked')
  })

  it('still closes keys when a step throws', async () => {
    const { calls, state, steps } = fakes(async () => {
      throw new Error('renderer gone')
    })
    steps.stopSync = async () => {
      throw new Error('sync broke')
    }
    await runLock(state, steps)
    expect(calls).toContain('closeKeys')
    expect(state.state).toBe('locked')
  })

  it('clears the clipboard only when Slate wrote it lately and it is unchanged', () => {
    const now = 1_000_000
    expect(shouldClearClipboard({ at: now - 60_000, text: 'secret' }, 'secret', now)).toBe(true)
    expect(shouldClearClipboard({ at: now - 121_000, text: 'secret' }, 'secret', now)).toBe(false)
    expect(shouldClearClipboard({ at: now - 1000, text: 'secret' }, 'something else', now)).toBe(false)
    expect(shouldClearClipboard(null, 'secret', now)).toBe(false)
  })
})

import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SCHEDULE_V1 } from './suite'
import { importKey } from '../../../test/vaultKeys'
import { KeyRing, Locked } from './keyring'
import { runLock, runShutdown, shouldClearClipboard } from './lockSequence'
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

  /**
   * It used to compare the clipboard's current text with what Slate had copied, which meant main read
   * the clipboard and kept a copy of it as a JavaScript string. On the recovery-key path that string was
   * the key, and a string cannot be zeroed, so it outlived the lock in V8's heap -- the 0.7.0 defect
   * T-ZERO-09 caught, on a path that test never walked. Main no longer looks at the clipboard at all.
   *
   * The cost: a lock within the window clears the clipboard even if the person copied something else
   * after copying from Slate. Two minutes of occasionally losing a clipboard beats keeping a permanent
   * credential in memory nothing can wipe.
   */
  it('clears the clipboard when Slate copied lately, without reading what is on it', () => {
    const now = 1_000_000
    expect(shouldClearClipboard({ at: now - 60_000 }, now)).toBe(true)
    expect(shouldClearClipboard({ at: now - 121_000 }, now)).toBe(false)
    expect(shouldClearClipboard(null, now)).toBe(false)
  })

  // C4: quitting used to close the services without asking the windows to write what they held,
  // so an edit still queued in the renderer reached a closed store and was lost.
  describe('shutdown (C4)', () => {
    /** A renderer holding one unwritten edit, and a store that refuses writes once it is closed. */
    function quitFakes() {
      const stored: string[] = []
      let closed = false
      let pending: string | null = 'the last sentence'
      const append = () => {
        if (closed || pending === null) return
        stored.push(pending)
        pending = null
      }
      const steps = {
        flushRenderer: async () => {
          await new Promise((r) => setTimeout(r, 1))
          append()
        },
        stopEvents: () => {},
        stopSync: async () => {
          await new Promise((r) => setTimeout(r, 5))
        },
        closeServices: () => {
          closed = true
        },
      }
      return { stored, steps, closed: () => closed }
    }

    it('writes an edit the window still held before the services close', async () => {
      const { stored, steps } = quitFakes()
      await runShutdown(steps)
      expect(stored).toEqual(['the last sentence'])
    })

    it('lets note writes through only while the window flushes', async () => {
      const seen: boolean[] = []
      let writes = false
      const { steps } = quitFakes()
      const flush = steps.flushRenderer
      await runShutdown({ ...steps, flushRenderer: async () => {
        seen.push(writes)
        await flush()
      }, allowWrites: (on: boolean) => void (writes = on) })
      expect(seen).toEqual([true])
      expect(writes).toBe(false)
    })

    it('closes the services even when the window never answers the flush', async () => {
      const { steps, closed } = quitFakes()
      const started = Date.now()
      await runShutdown({ ...steps, flushRenderer: () => new Promise<void>(() => {}) }, { flushTimeoutMs: 30 })
      expect(Date.now() - started).toBeLessThan(1000)
      expect(closed()).toBe(true)
    })

    it('runs every later step when one throws', async () => {
      const { steps, closed } = quitFakes()
      const errors: string[] = []
      await runShutdown(
        { ...steps, stopSync: async () => { throw new Error('sync broke') } },
        { onError: (step) => void errors.push(step) },
      )
      expect(errors).toEqual(['sync'])
      expect(closed()).toBe(true)
    })

    it('closes the MCP socket before the services close', async () => {
      const calls: string[] = []
      const { steps } = quitFakes()
      await runShutdown({
        ...steps,
        closeMcp: async () => void calls.push('closeMcp'),
        closeServices: () => void calls.push('closeServices'),
      })
      expect(calls).toEqual(['closeMcp', 'closeServices'])
    })
  })
})

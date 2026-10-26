import type { SlateNative } from '@slate/native'
import { describe, expect, it, vi } from 'vitest'
import { secretBytes } from '../../shared/secret'

// Counts derivations that reach the module (C4: Argon2id runs in @slate/native, no worker thread).
const started = vi.hoisted(() => ({ count: 0 }))
vi.mock('./native', async (importOriginal) => {
  const real = await importOriginal<typeof import('./native')>()
  // The addon's methods are read-only, so the counter shadows one on an object that inherits the rest.
  const counting = (n: SlateNative): SlateNative => {
    const wrapped = Object.create(n) as SlateNative
    Object.defineProperty(wrapped, 'argon2idAsync', {
      value: (...args: Parameters<SlateNative['argon2idAsync']>) => {
        started.count++
        return n.argon2idAsync(...args)
      },
    })
    return wrapped
  }
  return { ...real, vaultNative: () => counting(real.vaultNative()) }
})

const { deriveKek } = await import('./kdf')
const { destroyKey } = await import('./native')

describe('deriveKek ceilings', () => {
  it('refuses hostile parameters before any derivation starts, even in test mode', async () => {
    const salt = Buffer.alloc(16).toString('base64')
    const o = { allowWeakForTests: true }
    await expect(deriveKek(secretBytes('pw'), { alg: 'argon2id', memoryKiB: 4 * 1024 * 1024, passes: 2, parallelism: 1, salt }, o)).rejects.toThrow()
    await expect(deriveKek(secretBytes('pw'), { alg: 'argon2id', memoryKiB: 64, passes: 1000, parallelism: 1, salt }, o)).rejects.toThrow()
    expect(started.count).toBe(0)
    destroyKey(await deriveKek(secretBytes('pw'), { alg: 'argon2id', memoryKiB: 64, passes: 1, parallelism: 1, salt }, o))
    expect(started.count).toBe(1)
  })
})

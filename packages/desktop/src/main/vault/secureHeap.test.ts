import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { secretBytes } from '../../shared/secret'
import { destroyKey, vaultNative } from './native'
import { createEncryptedDataDir } from './testVault'
import { unlockVault } from './unlock'

const weak = { allowWeakForTests: true }

describe('T-ZERO-02 (audit §6.3, C7): the secure heap after a lock', () => {
  it('is back at its baseline once the key ring closes (not 0: the DRBG keeps its own state there)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-heap-'))
    const password = secretBytes('a heap test password')
    destroyKey((await createEncryptedDataDir(dir, password, weak)).mk)
    const status = () => vaultNative().status()
    const baseline = status().secureHeapUsed
    const handles = status().liveHandles

    const { keyRing } = await unlockVault(dir, { password }, weak)
    const unlocked = status().secureHeapUsed
    expect(unlocked).toBeGreaterThan(baseline)

    const destroyed = keyRing.close()
    expect(destroyed).toBeGreaterThan(0)
    expect(status().liveHandles).toBe(handles)
    expect(status().secureHeapUsed).toBe(baseline)
    // A second unlock and lock lands on the same baseline: nothing accumulates across cycles.
    const again = await unlockVault(dir, { password }, weak)
    again.keyRing.close()
    expect(status().secureHeapUsed).toBe(baseline)
  })
})

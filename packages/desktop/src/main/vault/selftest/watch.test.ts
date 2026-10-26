// T-POST-08 (audit §6.2) and S-7 (c): a module call answering SCC_12 escalates to failClosed instead of reading as
// "could not be verified"; a module fault runs a self-test; normal results (SCC_11, a stale handle) do neither.
import { randomBytes } from 'node:crypto'
import type { SlateNative } from '@slate/native'
import { afterEach, describe, expect, it } from 'vitest'
import { dbModule, provideDbModule, type DbModule } from '../../db/dbModule'
import { openEnvelope, sealEnvelope, UnverifiableFile, type EnvelopeKeys } from '../envelope'
import { SUITE } from '../suite'
import { moduleFault, watchModule } from './supervisor'

const scc = (code: string) => Object.assign(new Error(code), { code })
let restore: DbModule | null = null
afterEach(() => {
  if (restore) {
    const back = restore
    provideDbModule(() => back)
  }
  restore = null
})

describe('watchModule (S-7 c, T-POST-08)', () => {
  it('classifies module errors: SCC_12 is the error state, module faults call for a self-test, the rest are results', () => {
    expect(moduleFault(scc('SCC_12'))).toBe('error-state')
    for (const code of ['SCC_2', 'SCC_3', 'SCC_6', 'SCC_9', 'SCC_10', 'SCC_15']) expect(moduleFault(scc(code)), code).toBe('fault')
    for (const code of ['SCC_1', 'SCC_8', 'SCC_11', 'SCC_14', 'SCC_16', 'SCC_17']) expect(moduleFault(scc(code)), code).toBeNull()
    expect(moduleFault(new Error('not the module'))).toBeNull()
  })

  it('passes results and errors through unchanged, reporting only faults (the real module)', async () => {
    const real = dbModule().native
    const seen: string[] = []
    const n = watchModule(real, (kind) => void seen.push(kind))
    expect(n.sha256(new Uint8Array([0x61, 0x62, 0x63])).length).toBe(32)
    const k = n.keyRandom()
    const sealed = n.gcmSeal(k, null, new Uint8Array(0), new Uint8Array(4))
    sealed[sealed.length - 1]! ^= 1
    expect(() => n.gcmOpen(k, sealed.subarray(0, 12), new Uint8Array(0), sealed.subarray(12))).toThrow(expect.objectContaining({ code: 'SCC_11' }))
    n.keyDestroy(k)
    expect(() => n.keyDestroy(k)).toThrow(expect.objectContaining({ code: 'SCC_8' }))
    await expect(n.pbkdf2Async(new Uint8Array(8), new Uint8Array(16), 999)).rejects.toThrow()
    expect(seen).toEqual([])
    // Anything that is not a method passes through as it is.
    expect((watchModule({ answer: 42 } as unknown as SlateNative, () => {}) as unknown as { answer: number }).answer).toBe(42)
  })

  it("reports the error state when a caller enters it itself (the database's cipher check, review C3)", () => {
    const seen: string[] = []
    let entered = 0
    const fake = { enterErrorState: () => (entered++, 0 as const) } as unknown as SlateNative
    watchModule(fake, (kind) => void seen.push(kind)).enterErrorState()
    expect([entered, seen]).toEqual([1, ['error-state']])
  })

  it('T-POST-08: SCC_12 from the module while a synced file is opened is rethrown, never UnverifiableFile, and reported', () => {
    const real = dbModule().native
    restore = dbModule()
    const keys: EnvelopeKeys = { syncKey: real.keyRandom(), suite: SUITE.KBKDF_AES256GCM, keyEpoch: 0, readSuites: new Set([SUITE.KBKDF_AES256GCM]) }
    const sealed = sealEnvelope(keys, 'docs/x', randomBytes(32))
    // The module answers SCC_12 to the file's open, as it would after entering its error state on its own.
    const broken = new Proxy({} as SlateNative, {
      get: (_t, prop) => {
        if (prop === 'gcmOpen') return () => {
          throw scc('SCC_12')
        }
        const v: unknown = Reflect.get(real, prop)
        return typeof v === 'function' ? (...a: unknown[]) => Reflect.apply(v, real, a) : v
      },
    })
    const faults: string[] = []
    provideDbModule(() => ({ native: watchModule(broken, (kind) => void faults.push(kind)), requireFips: false }))
    let thrown: unknown
    try {
      openEnvelope(keys, 'docs/x', sealed)
    } catch (e) {
      thrown = e
    }
    expect(thrown).not.toBeInstanceOf(UnverifiableFile)
    expect(thrown).toMatchObject({ code: 'SCC_12' })
    // index.ts answers 'error-state' with failClosed(['POST-MODULE-STATUS']).
    expect(faults).toEqual(['error-state'])
    real.keyDestroy(keys.syncKey)
  })
})

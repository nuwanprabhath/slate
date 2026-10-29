// Review C6 (MEDIUM, key wrapping) and its generalisation: for every cryptographic service of @slate/native, a
// module whose implementation of that service is wrong must fail the POST. Each case wraps the real module in a
// proxy that corrupts one service (its output, or for a service returning a key handle, its input, so the key
// differs) and runs runPost against it. The proxy also stands in for the session and error-state controls, so the
// real module the main-process tests share is never latched.
import type { SlateNative } from '@slate/native'
import { afterEach, describe, expect, it } from 'vitest'
import { dbModule, provideDbModule, type DbModule } from '../../db/dbModule'
import { testHasProvider } from '../../db/testModule'
import { runPost } from './post'

let restore: DbModule | null = null
afterEach(() => {
  const back = restore
  if (back) provideDbModule(() => back)
  // A corrupted keyDestroy leaves that run's handles live, and the 64-slot table is shared by every case here.
  if (back) back.native.zeroizeAll()
  restore = null
})

type Mutation = (real: (...a: unknown[]) => unknown, args: unknown[]) => unknown

const flipOut: Mutation = (real, args) => {
  const out = real(...args)
  if (!(out instanceof Uint8Array)) return out
  const c = Uint8Array.from(out)
  c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 1
  return c
}

/** A different key: the first string argument (a KDF label) or, failing that, the first bytes argument changed. */
const otherKey: Mutation = (real, args) => {
  const a = [...args]
  const s = a.findIndex((x) => typeof x === 'string')
  if (s >= 0) a[s] = `${String(a[s])}!`
  else {
    const b = a.findIndex((x) => x instanceof Uint8Array && x.length > 0)
    const c = Uint8Array.from(a[b] as Uint8Array)
    c[0] = (c[0] ?? 0) ^ 1
    a[b] = c
  }
  return real(...a)
}

/** Every service the vault reaches, and how it is corrupted. tools/guards/selfTest.test.ts keeps this complete. */
export const MUTATIONS: Record<string, Mutation> = {
  sha256: flipOut,
  hmacSha256: flipOut,
  aesEcbBlock: flipOut,
  aesCtr: flipOut,
  gcmSeal: flipOut,
  gcmSealIvInAad: flipOut,
  gcmOpen: flipOut,
  gcmSealKey: flipOut,
  rewrapKey: flipOut,
  historySeal: flipOut,
  historyRewrap: flipOut,
  nameSivEncode: flipOut,
  nameSivDecode: flipOut,
  randomBytes: (real, args) => new Uint8Array((real(...args) as Uint8Array).length),
  kbkdf: otherKey,
  hkdfLegacy: otherKey,
  kbkdfFromSecret: otherKey,
  kbkdfFromRecovery: otherKey,
  recoveryDecode: otherKey,
  gcmOpenKey: otherKey,
  historyOpen: otherKey,
  pbkdf2Async: otherKey,
  argon2idAsync: otherKey,
  keyDestroy: () => 0,
  // PQ-A4: a verifier that accepts everything accepts the flipped signature.
  mldsaVerify: () => true,
}

function mutated(real: SlateNative, name: string, mutation: Mutation): SlateNative {
  return new Proxy({} as SlateNative, {
    get: (_t, prop) => {
      if (prop === 'postBegin' || prop === 'postEnd' || prop === 'enterErrorState' || prop === 'zeroizeAll') return () => 0
      const v: unknown = Reflect.get(real, prop)
      if (typeof v !== 'function') return v
      const call = (...a: unknown[]) => Reflect.apply(v, real, a)
      return prop === name ? (...a: unknown[]) => mutation(call, a) : call
    },
  })
}

describe('the POST fails whenever one cryptographic service is wrong (mutation)', () => {
  it('passes with every service intact (the harness itself changes nothing)', async () => {
    const real = dbModule().native
    restore = dbModule()
    const n = mutated(real, '', flipOut)
    provideDbModule(() => ({ native: n, requireFips: false }))
    expect((await runPost({ native: n, requireFips: testHasProvider })).failed).toEqual([])
  })

  it.each(Object.keys(MUTATIONS).map((name) => [name]))('%s corrupted: the POST fails', async (name) => {
    const real = dbModule().native
    restore = dbModule()
    const n = mutated(real, name, MUTATIONS[name]!)
    provideDbModule(() => ({ native: n, requireFips: false }))
    const r = await runPost({ native: n, requireFips: testHasProvider })
    expect(r.ok, `${name}: ${r.failed.join(',')}`).toBe(false)
  })

  it("T-PQ-A4-02: a module that accepts the flipped ML-DSA signature fails exactly POST-MLDSA-VERIFY", async () => {
    const real = dbModule().native
    restore = dbModule()
    const n = mutated(real, 'mldsaVerify', MUTATIONS.mldsaVerify!)
    provideDbModule(() => ({ native: n, requireFips: false }))
    const r = await runPost({ native: n, requireFips: testHasProvider })
    expect(r).toMatchObject({ ok: false, failed: ['POST-MLDSA-VERIFY'] })
  })

  it('a module that refuses to close the self-test session (postEnd answering SCC_12) fails the POST', async () => {
    const real = dbModule().native
    restore = dbModule()
    const n = new Proxy({} as SlateNative, {
      get: (_t, prop) => {
        if (prop === 'postEnd') return () => {
          throw Object.assign(new Error('SCC_12'), { code: 'SCC_12' })
        }
        if (prop === 'postBegin' || prop === 'enterErrorState') return () => 0
        const v: unknown = Reflect.get(real, prop)
        return typeof v === 'function' ? (...a: unknown[]) => Reflect.apply(v, real, a) : v
      },
    })
    provideDbModule(() => ({ native: n, requireFips: false }))
    const r = await runPost({ native: n, requireFips: testHasProvider })
    expect(r).toMatchObject({ ok: false })
    expect(r.failed).toContain('POST-MODULE-STATUS')
  })
})

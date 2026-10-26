import { createCipheriv, createDecipheriv, createHash, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KeyHandle, NativeStatus, SlateNative } from '@slate/native'
import { roundTrip, startCryptoModule, type StartOptions } from './cryptoModule'

/** A stand-in for slate_native.node with the same contract, backed by node:crypto. */
type FakeNative = SlateNative & { inits: unknown[][]; errored: boolean }

function fakeNative(over: Partial<SlateNative> = {}): FakeNative {
  const keys = new Map<number, Buffer>()
  let next = 1
  let fips = false
  const self: FakeNative = {
    inits: [] as unknown[][],
    errored: false,
    sqlite: {},
    init(config: string, dir: string, requireFips: boolean) {
      self.inits.push([config, dir, requireFips])
      fips = requireFips
      return 0 as const
    },
    hardenProcess: () => true,
    postGate: () => 0 as const,
    postBegin: () => 0 as const,
    postEnd: () => 0 as const,
    status: (): NativeStatus => ({
      fipsActive: fips && !self.errored,
      errorState: self.errored,
      liveHandles: keys.size,
      secureHeapUsed: keys.size * 32,
      secureHeapLocked: true,
      approvedKeysOnly: false,
      moduleSelfTestFailures: 0,
      postPassed: !self.errored,
      libcrypto: 'OpenSSL 3.5.9 30 Sep 2026',
      defaultContextProviders: fips ? 'fips,base' : 'default',
      buildKind: 'slate-native-build:release',
      fipsModule: fips ? { name: 'OpenSSL FIPS Provider', version: '3.1.2' } : null,
    }),
    enterErrorState() {
      self.errored = true
      keys.clear()
      return 0 as const
    },
    zeroizeAll() {
      const n = keys.size
      keys.clear()
      return n
    },
    keyRandom() {
      keys.set(next, randomBytes(32))
      return next++ as KeyHandle
    },
    keyDestroy(h: KeyHandle) {
      if (!keys.delete(h)) throw Object.assign(new Error('bad handle'), { code: 'SCC_8' })
      return 0 as const
    },
    gcmSeal(h: KeyHandle, iv: Uint8Array | null, aad: Uint8Array, pt: Uint8Array) {
      const nonce = iv ? Buffer.from(iv) : randomBytes(12)
      const c = createCipheriv('aes-256-gcm', keys.get(h)!, nonce).setAAD(aad)
      return new Uint8Array(Buffer.concat([nonce, c.update(pt), c.final(), c.getAuthTag()]))
    },
    gcmOpen(h: KeyHandle, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array) {
      const d = createDecipheriv('aes-256-gcm', keys.get(h)!, iv).setAAD(aad)
      d.setAuthTag(ct.subarray(ct.length - 16))
      return new Uint8Array(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]))
    },
    gcmSealKey(kek: KeyHandle, key: KeyHandle, iv: Uint8Array | null, aad: Uint8Array): Uint8Array {
      return self.gcmSeal(kek, iv, aad, keys.get(key)!)
    },
    gcmOpenKey(kek: KeyHandle, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array) {
      keys.set(next, Buffer.from(self.gcmOpen(kek, iv, aad, ct)))
      return next++ as KeyHandle
    },
    randomBytes: (n: number) => new Uint8Array(randomBytes(n)),
    sha256: (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest()),
    // Stand-ins with the same shape (consistent, not the real constructions): the round trip compares two derivations.
    kbkdf(h: KeyHandle, label: string, context: Uint8Array) {
      keys.set(next, Buffer.from(hkdfSync('sha256', keys.get(h)!, context, label, 32)))
      return next++ as KeyHandle
    },
    hkdfLegacy: () => {
      throw new Error('unused')
    },
    pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number) {
      keys.set(next, pbkdf2Sync(password, salt, iterations, 32, 'sha512'))
      return next++ as KeyHandle
    },
    argon2id: () => {
      throw new Error('unused')
    },
    hmacSha256: () => {
      throw new Error('unused')
    },
    aesEcbBlock: () => {
      throw new Error('unused')
    },
    aesCtr: () => {
      throw new Error('unused')
    },
    pbkdf2Async: () => {
      throw new Error('unused')
    },
    kbkdfFromSecret: () => {
      throw new Error('unused')
    },
    pbkdf2Calibrate: () => {
      throw new Error('unused')
    },
    nameSivEncode: () => {
      throw new Error('unused')
    },
    nameSivDecode: () => {
      throw new Error('unused')
    },
    rewrapKey: () => {
      throw new Error('unused')
    },
    historySeal: () => {
      throw new Error('unused')
    },
    historyRewrap: () => {
      throw new Error('unused')
    },
    historyOpen: () => {
      throw new Error('unused')
    },
    requireApprovedKeys: () => {
      throw new Error('unused')
    },
    argon2idAsync: () => {
      throw new Error('unused')
    },
    hkdfFromSecret: () => {
      throw new Error('unused')
    },
    recoveryDecode: () => {
      throw new Error('unused')
    },
    kbkdfFromRecovery: () => {
      throw new Error('unused')
    },
    hkdfFromRecovery: () => {
      throw new Error('unused')
    },
    gcmSealIvInAad: () => {
      throw new Error('unused')
    },
    ...over,
  }
  return self
}

function options(native: SlateNative | null, over: Partial<StartOptions> = {}): StartOptions {
  let t = 1000
  return {
    load: () => {
      if (!native) throw new Error("Cannot find module '../native/slate_native.node'")
      return native
    },
    requireFips: true,
    modulesDir: '/res/fips',
    configFile: '/user/fips/openssl-fips.cnf',
    moduleFile: 'fips.dylib',
    exists: () => true,
    writeConfig: () => {},
    now: () => (t += 7),
    ...over,
  }
}

describe('startCryptoModule (C2 criterion 6, F-FIPS-08)', () => {
  it('a development build reports a missing addon as not available, without throwing', () => {
    const { native, status } = startCryptoModule(options(null, { requireFips: false }))
    expect(native).toBeNull()
    expect(status).toMatchObject({ available: false, approvedMode: false, errorState: false, postMs: null, development: true })
    expect(status.problem).toMatch(/not available/)
    expect(status).toMatchObject({ module: 'OpenSSL FIPS Provider', version: '3.1.2', cmvp: 4985, standard: 'FIPS 140-3' })
  })

  it('writes the config, loads the FIPS provider from <resources>/fips and round-trips a key', () => {
    const fake = fakeNative()
    const writeConfig = vi.fn()
    const { native, status } = startCryptoModule(options(fake, { writeConfig }))
    expect(native).toBe(fake)
    expect(writeConfig).toHaveBeenCalledWith({ modulesDir: '/res/fips', configFile: '/user/fips/openssl-fips.cnf' })
    expect(fake.inits).toEqual([['/user/fips/openssl-fips.cnf', '/res/fips', true]])
    expect(status).toMatchObject({ available: true, approvedMode: true, errorState: false, problem: null, version: '3.1.2', postMs: 7 })
    expect(status.libcrypto).toMatch(/^OpenSSL 3\.5\./)
    expect(fake.status().liveHandles).toBe(0)
  })

  it('Z-9 (C7): hardenProcess runs first in the POST, before the provider loads and before any key exists', () => {
    const calls: string[] = []
    const fake = fakeNative()
    const spy = (name: keyof SlateNative) => {
      const real = fake[name] as (...a: unknown[]) => unknown
      ;(fake as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
        calls.push(name)
        return real(...a)
      }
    }
    for (const name of ['hardenProcess', 'init', 'keyRandom', 'pbkdf2'] as const) spy(name)
    const { status } = startCryptoModule(options(fake))
    expect(status.problem).toBeNull()
    expect(calls[0]).toBe('hardenProcess')
    expect(calls.filter((c) => c === 'hardenProcess')).toHaveLength(1)
    expect(calls.indexOf('init')).toBeGreaterThan(0)
  })

  it('C6: a gated start gates the module before hardening and init, and leaves every key operation to the POST', () => {
    const calls: string[] = []
    const fake = fakeNative()
    for (const name of ['postGate', 'hardenProcess', 'init', 'keyRandom', 'pbkdf2', 'postBegin', 'postEnd'] as const) {
      const real = fake[name] as (...a: unknown[]) => unknown
      ;(fake as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
        calls.push(name)
        return real(...a)
      }
    }
    const { status } = startCryptoModule(options(fake, { gated: true }))
    expect(status.problem).toBeNull()
    // The self-test session belongs to runPost (vault/selftest/post.ts), which runs next.
    expect(calls).toEqual(['postGate', 'hardenProcess', 'init'])
  })

  it('Z-9 (C7): a packaged build that cannot make itself non-dumpable fails the POST; a development build carries on', () => {
    const packaged = fakeNative({ hardenProcess: () => false })
    const { status } = startCryptoModule(options(packaged))
    expect(status.problem).toBe('POST-HARDEN')
    expect(status.errorState).toBe(true)
    const dev = fakeNative({ hardenProcess: () => false })
    expect(startCryptoModule(options(dev, { requireFips: false, exists: () => false })).status.problem).toBeNull()
  })

  it('a development build without the provider runs without a FIPS claim', () => {
    const fake = fakeNative()
    const writeConfig = vi.fn()
    const { status } = startCryptoModule(options(fake, { requireFips: false, exists: () => false, writeConfig }))
    expect(writeConfig).not.toHaveBeenCalled()
    expect(fake.inits).toEqual([['', '', false]])
    expect(status).toMatchObject({ available: true, approvedMode: false, errorState: false, problem: null, development: true })
  })

  it('review M2: a packaged build whose provider is missing fails closed instead of running without FIPS', () => {
    const fake = fakeNative()
    const { status } = startCryptoModule(options(fake, { exists: () => false }))
    expect(fake.inits).toEqual([])
    expect(fake.errored).toBe(true)
    expect(status).toMatchObject({ available: true, approvedMode: false, errorState: true, development: false })
    expect(status.problem).toMatch(/^POST-MODULE-LOAD \(missing provider\)$/)
  })

  it('review M2: a packaged build whose addon is missing fails closed', () => {
    const { status } = startCryptoModule(options(null))
    expect(status).toMatchObject({ available: false, approvedMode: false, errorState: true, development: false })
    expect(status.problem).toMatch(/^POST-MODULE-LOAD \(addon\)$/)
  })

  it('a provider that fails its self-test or integrity check is POST-MODULE-LOAD with the native code', () => {
    const fake = fakeNative({
      init: () => {
        throw Object.assign(new Error('Cryptographic operation failed'), { code: 'SCC_6' })
      },
    })
    fake.errored = true
    const { status } = startCryptoModule(options(fake))
    expect(status).toMatchObject({ available: true, approvedMode: false, errorState: true, problem: 'POST-MODULE-LOAD (SCC_6)' })
  })

  it('M4: a provider the addon refuses before loading (digest pin, SCC_15) is POST-MODULE-STATUS', () => {
    const fake = fakeNative({
      init: () => {
        throw Object.assign(new Error('Cryptographic operation failed'), { code: 'SCC_15' })
      },
    })
    fake.errored = true
    const { status } = startCryptoModule(options(fake))
    expect(status).toMatchObject({ approvedMode: false, errorState: true, problem: 'POST-MODULE-STATUS (SCC_15)' })
  })

  it('M4: the JavaScript side no longer hashes the provider after it was loaded', () => {
    const readFile = vi.fn(() => new Uint8Array(0))
    startCryptoModule(options(fakeNative(), { readFile } as Partial<StartOptions>))
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a failed round trip puts the module in the error state', () => {
    const fake = fakeNative()
    fake.gcmOpen = () => new Uint8Array(32)
    const { status } = startCryptoModule(options(fake))
    expect(fake.errored).toBe(true)
    expect(status).toMatchObject({ errorState: true, approvedMode: false, problem: 'POST-ROUNDTRIP' })
  })
})

describe('roundTrip', () => {
  it('wraps a key, unwraps it into a new handle and proves both handles hold the same key', () => {
    const fake = fakeNative()
    expect(roundTrip(fake)).toBe(true)
    expect(fake.status().liveHandles).toBe(0)
  })

  it('fails when a handle is left behind', () => {
    const fake = fakeNative()
    fake.keyDestroy = () => 0
    expect(roundTrip(fake)).toBe(false)
  })
})

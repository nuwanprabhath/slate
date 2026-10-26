// Starts @slate/native at launch (audit C2): load the addon, point OpenSSL at the bundled FIPS
// provider, check the provider file against the digest pinned at build time, and round-trip a key
// through the secure heap. Notes do not use the module yet (C3/C4); Settings → Security shows what
// this found (F-FIPS-08). A missing addon is reported, never fatal: dev checkouts may lack OpenSSL.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeErrorCode, type KeyHandle, type SlateNative } from '@slate/native'
import moduleInfo from '../../../../../docs/compliance/crypto-module.json'
import type { CryptoModuleStatus } from '../../shared/api'
import { writeFipsConfig, type FipsPaths } from './fipsConfig'

export interface StartOptions extends FipsPaths {
  /** Loads slate_native.node; throws when it is missing or unloadable. */
  load: () => SlateNative
  /**
   * Decided by the build type, never by which files happen to exist (review M2): a packaged build
   * must run on the approved module, so a missing addon or provider is a start-up failure there.
   */
  requireFips: boolean
  /**
   * C6: gate the module (`postGate`) before anything else, so no service runs until the power-up self-test
   * (vault/selftest/post.ts) passed; its POST-KEY-WRAP check (gcmSealKey, rewrapKey, gcmOpenKey) replaces this round trip. The app always gates; the
   * main-process tests' own module does not.
   */
  gated?: boolean
  moduleFile: 'fips.dylib' | 'fips.so'
  exists?: (path: string) => boolean
  writeConfig?: (paths: FipsPaths) => void
  now?: () => number
}

const ROUND_TRIP_AAD = new TextEncoder().encode('slate/c2/round-trip')

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Wraps a fresh master key under a PBKDF2 KEK, unwraps it into a new handle, and shows the two handles
 * hold the same key: a KBKDF subkey of one opens what a subkey of the other sealed. Every service it
 * uses runs in the FIPS library context. Every handle is destroyed again, and the live count must
 * return to where it started.
 */
export function roundTrip(native: SlateNative): boolean {
  const before = native.status().liveHandles
  const handles: KeyHandle[] = []
  let ok = false
  try {
    const kek = native.pbkdf2(native.randomBytes(32), native.randomBytes(16), 1000)
    handles.push(kek)
    const key = native.keyRandom('master')
    handles.push(key)
    const wrapped = native.gcmSealKey(kek, key, null, ROUND_TRIP_AAD)
    const unwrapped = native.gcmOpenKey(kek, wrapped.subarray(0, 12), ROUND_TRIP_AAD, wrapped.subarray(12))
    handles.push(unwrapped)
    const context = native.randomBytes(16)
    const a = native.kbkdf(key, 'slate/module/round-trip', context)
    handles.push(a)
    const b = native.kbkdf(unwrapped, 'slate/module/round-trip', context)
    handles.push(b)
    const probe = native.randomBytes(32)
    const sealed = native.gcmSeal(b, null, ROUND_TRIP_AAD, probe)
    ok = wrapped.length === 60 && sameBytes(native.gcmOpen(a, sealed.subarray(0, 12), ROUND_TRIP_AAD, sealed.subarray(12)), probe)
  } catch {
    ok = false
  } finally {
    for (const h of handles) {
      try {
        native.keyDestroy(h)
      } catch {
        ok = false
      }
    }
  }
  return ok && native.status().liveHandles === before
}

function baseStatus(): CryptoModuleStatus {
  return {
    available: false,
    problem: null,
    module: moduleInfo.module,
    version: moduleInfo.version,
    cmvp: moduleInfo.cmvp,
    standard: moduleInfo.standard,
    certificateUrl: moduleInfo.certificateUrl,
    approvedMode: false,
    errorState: false,
    postMs: null,
    libcrypto: null,
    secureHeapLocked: null,
    development: true,
  }
}

export function startCryptoModule(o: StartOptions): { native: SlateNative | null; status: CryptoModuleStatus } {
  const exists = o.exists ?? existsSync
  const writeConfig = o.writeConfig ?? writeFipsConfig
  const now = o.now ?? (() => performance.now())
  const status = baseStatus()
  status.development = !o.requireFips
  const started = now()
  let native: SlateNative
  try {
    native = o.load()
  } catch {
    if (o.requireFips) {
      status.problem = 'POST-MODULE-LOAD (addon)'
      status.errorState = true
    } else status.problem = 'The cryptographic module is not available in this build.'
    return { native: null, status }
  }
  status.available = true
  if (o.gated) {
    try {
      native.postGate()
    } catch {
      status.problem = 'POST-MODULE-LOAD (gate)'
    }
  }
  const providerFile = join(o.modulesDir, o.moduleFile)
  const withProvider = exists(providerFile)
  const fail = (problem: string) => {
    status.problem ??= problem
    try {
      native.enterErrorState()
    } catch {
      // Already in the error state, or the addon is beyond reach: the status below says so.
    }
  }
  // Z-9 (C7), before any key exists: no core file (RLIMIT_CORE 0) and, on Linux, not dumpable or
  // ptrace-attachable by other processes of the user (PR_SET_DUMPABLE 0). On macOS the hardened runtime
  // would stop attaching; it needs a Developer ID (D-1), so it is a POA&M entry. A shipped build that
  // cannot harden itself does not start; a development checkout carries on.
  let hardened = false
  try {
    hardened = native.hardenProcess()
  } catch {
    hardened = false
  }
  if (!hardened && o.requireFips) fail('POST-HARDEN')
  try {
    if (status.problem !== null) {
      // Refused above; nothing more is loaded.
    } else if (!withProvider && o.requireFips) {
      fail('POST-MODULE-LOAD (missing provider)')
    } else if (withProvider) {
      writeConfig({ modulesDir: o.modulesDir, configFile: o.configFile })
      // The addon hashes the provider against its compiled-in pin before loading it (SCC_15 on mismatch).
      native.init(o.configFile, o.modulesDir, true)
    } else {
      native.init('', '', false)
    }
  } catch (e) {
    const code = nativeErrorCode(e)
    fail(code === 'SCC_15' ? `POST-MODULE-STATUS (${code})` : `POST-MODULE-LOAD (${code ?? 'load'})`)
  }
  if (status.problem === null && !o.gated && !roundTrip(native)) fail('POST-ROUNDTRIP')
  const s = native.status()
  status.approvedMode = s.fipsActive
  status.errorState = s.errorState
  status.libcrypto = s.libcrypto
  status.secureHeapLocked = s.secureHeapLocked
  if (s.fipsModule) status.version = s.fipsModule.version
  status.postMs = Math.round(now() - started)
  return { native, status }
}

// The typed surface of slate_native.node (src/binding.c). Keys cross into JavaScript only as handles.
import { createRequire } from 'node:module'
import { isMainThread } from 'node:worker_threads'
import createDatabase, { type DatabaseConstructor } from './sqlite/database.js'

export type { Database, DatabaseConstructor } from './sqlite/database.js'

/** An opaque reference to a 32-byte key held in OpenSSL's secure heap. Never the key itself. */
export type KeyHandle = number & { readonly __keyHandle: unique symbol }

/**
 * What a key may do (C4; reviews C2 R2, C3 L1/L2, C4 M1); the module refuses cross-use with SCC_17.
 * - `data`: subkeys, file keys, module-random keys. AEAD, HMAC, AES and key derivation. It wraps and
 *   unwraps no key: what it decrypts goes to the caller, so a key wrapped under it would be exported.
 * - `master`: the vault master key. Key derivation only; wrapped only under a password-class KEK.
 * - `db`: a database key (LK). Keys SQLCipher; wrapped only under a `kek`.
 * - `kek`: wraps and unwraps database keys and nothing else; derived from a master key for the
 *   `…/local-wrap` purpose only (or random).
 * A fifth, password class (from `pbkdf2`, `argon2id`, `hkdfFromSecret`) is never named here: those keys
 * are reproducible by whoever knows the input, so they wrap and unwrap master keys and do nothing else.
 * Only a fresh key (from `keyRandom`, not yet used) is ever wrapped. A master key's wrap moves to another
 * password-class KEK with `rewrapKey`, which yields neither a handle nor bytes; a database key never moves
 * (review C4 M1-R, closed in C5), so it stays in the tree of the master key it was created under.
 */
export type KeyUsage = 'data' | 'master' | 'db' | 'kek'

export interface NativeStatus {
  /** `init` succeeded and the module is not in the error state. False before init and after a failed one. */
  ready: boolean
  /** The FIPS provider is loaded, passed its self-tests, and `fips=yes` is the default property query. */
  fipsActive: boolean
  /** Sticky: a module self-test failed or `enterErrorState` ran. Every service now throws `SCC_12`. */
  errorState: boolean
  liveHandles: number
  secureHeapUsed: number
  /** False when the secure heap could not be mlock'd (RLIMIT_MEMLOCK); reported as degraded. */
  secureHeapLocked: boolean
  /**
   * `requireApprovedKeys` ran (a fips-140-3 vault, C5): SQLCipher refuses non-approved key handles, and the
   * non-approved services (`argon2id*`, `hkdfLegacy`, `hkdfFromSecret`, `aesEcbBlock`) refuse with SCC_16.
   */
  approvedKeysOnly: boolean
  moduleSelfTestFailures: number
  /**
   * C6: false while a gated module (`postGate`) has not yet passed its power-up self-test, and in the error
   * state. A module that was never gated (tests, the CLIs) reports true once it runs.
   */
  postPassed: boolean
  libcrypto: string
  /** `slate-native-build:release` for a shipped addon; KAT builds never get a binding. */
  buildKind: string
  /** Providers active in the default library context, comma-separated: `base,fips` when `requireFips`. */
  defaultContextProviders: string
  /** What the loaded FIPS provider reports about itself (F-FIPS-08); null when no provider is loaded. */
  fipsModule: { name: string; version: string } | null
  /**
   * PQ-A1: the post-quantum algorithms the standard library context can create keys for, among ML-KEM-768,
   * ML-KEM-1024, ML-DSA-65, ML-DSA-87 and SLH-DSA-SHA2-256s. Empty before `init`.
   */
  pqAlgorithms: string[]
  /** PQ-A1: the loaded FIPS provider itself offers ML-KEM-768 and ML-DSA-65. False with provider 3.1.2 and without one. */
  pqInFipsBoundary: boolean
}

export interface SlateNative {
  /** `modulesDir` holds fips.so / fips.dylib; `fipsConfigPath` is the config written by packages/desktop/src/main/native/fipsConfig.ts (§4.9). */
  init(fipsConfigPath: string, modulesDir: string, requireFips: boolean): 0
  hardenProcess(): boolean
  /**
   * C6 (audit S-1, S-2), one-way, before `init`: from now on every service refuses (SCC_2) until a power-up
   * self-test session has passed. Only `vault/selftest/post.ts` opens and closes such a session.
   */
  postGate(): 0
  /** Opens a self-test session, in which the services run even before the first self-test passed. */
  postBegin(): 0
  /**
   * Closes the session. `true` opens the services for the process; `false` enters the error state (every key
   * destroyed, every SQLCipher connection closed) and throws SCC_12, as any later service does.
   */
  postEnd(passed: boolean): 0
  status(): NativeStatus
  enterErrorState(): 0
  zeroizeAll(): number
  keyRandom(usage?: KeyUsage): KeyHandle
  /**
   * One-way, for the process: from now on SQLCipher refuses a non-approved key handle, and Argon2id, RFC 5869
   * HKDF and AES-ECB (the standard profile and suite 0x01) refuse to run (SCC_16). A fips-140-3 vault sets it
   * before its first key is derived (C5 criterion 2).
   */
  requireApprovedKeys(): 0
  keyDestroy(key: KeyHandle): 0
  /** SP 800-108r1 counter mode, HMAC-SHA-256, 0x00 separator, [L]32: label = purpose, context = binding. */
  kbkdf(key: KeyHandle, label: string, context: Uint8Array, usage?: 'data' | 'kek'): KeyHandle
  /** RFC 5869 HKDF-SHA-256 for legacy suite 0x01 only; outside the FIPS library context. */
  hkdfLegacy(key: KeyHandle, salt: Uint8Array, info: string, usage?: 'data' | 'kek'): KeyHandle
  /** Cleanses `password`. `iterations`: an integer in [1000, 10^7], else SCC_1. */
  pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): KeyHandle
  /**
   * `pbkdf2` on a libuv thread (review C5 L1): up to 10^7 iterations from a header not yet verified must not
   * stall the main process. The password is copied into the secure heap and cleansed before this returns.
   */
  pbkdf2Async(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<KeyHandle>
  /** Cleanses `password`. Standard profile only; outside the FIPS context. `memoryKiB` in [32, 4 GiB], `passes` in [1, 16]. */
  argon2id(password: Uint8Array, salt: Uint8Array, memoryKiB: number, passes: number): KeyHandle
  /**
   * `argon2id` on a libuv thread, so a 256 MiB derivation does not stall the main process. The password is
   * copied into the secure heap and cleansed before this returns; argument errors reject the promise.
   */
  argon2idAsync(password: Uint8Array, salt: Uint8Array, memoryKiB: number, passes: number): Promise<KeyHandle>
  /**
   * RFC 5869 HKDF-SHA-256 with `secret` as the input key material, for suite 0x01's recovery and quick-unlock
   * KEKs. Cleanses `secret`. The result is a password-class KEK, outside the FIPS library context.
   */
  hkdfFromSecret(secret: Uint8Array, salt: Uint8Array, info: string): KeyHandle
  /**
   * SP 800-108r1 KBKDF (as `kbkdf`) with `secret` (at least 16 bytes) as the key: suite 0x02's recovery and
   * quick-unlock KEKs. Cleanses `secret`. A password-class KEK, in the FIPS library context. `approved: false`
   * for a standard-profile vault, whose master key an Argon2id KEK also opens (IG 2.4.A), so that moving its
   * wrap between these KEKs keeps one approval status (SCC_16 refuses non-approved to approved).
   */
  kbkdfFromSecret(secret: Uint8Array, label: string, context: Uint8Array, approved: boolean): KeyHandle
  /** PBKDF2-HMAC-SHA-512 iterations that take about `targetMs` (100..10000) here, clamped to [600000, 10^7]. */
  pbkdf2Calibrate(targetMs: number): number
  /**
   * Suite 0x02 remote name (audit §4.6): SIV(16) || C(16), SIV = HMAC-SHA-256(mac, "slate-name/v2" 0x00 || packed)
   * truncated, C = AES-256-CTR(enc, ICB = SIV, packed). `enc` and `mac` are distinct data keys.
   */
  nameSivEncode(enc: KeyHandle, mac: KeyHandle, packed: Uint8Array): Uint8Array
  /** The 16 packed bytes of a 32-byte name, or null when its SIV does not verify (compared in constant time). */
  nameSivDecode(enc: KeyHandle, mac: KeyHandle, name: Uint8Array): Uint8Array | null
  /**
   * C7: decodes a typed recovery key (its UTF-8 text: base32, case, spaces and dashes ignored, O read as 0,
   * I and L as 1, with its checksum) inside the module, so the 32-byte secret never exists in JavaScript.
   * Cleanses `text` on every path. SCC_1 for any text that is not a valid key. The handle is recovery
   * class: `hkdfFromRecovery` is its only use, and the caller destroys it.
   */
  recoveryDecode(text: Uint8Array): KeyHandle
  /** `hkdfFromSecret` over a `recoveryDecode` handle's secret: suite 0x01's KEK_rc, a password-class key. */
  hkdfFromRecovery(recovery: KeyHandle, salt: Uint8Array, info: string): KeyHandle
  /** Suite 0x02's KEK_rc: `kbkdfFromSecret` over a `recoveryDecode` handle's secret (C5 with C7). */
  kbkdfFromRecovery(recovery: KeyHandle, label: string, context: Uint8Array, approved: boolean): KeyHandle
  /** iv(12) || ct || tag(16). `iv` null = fresh IV from the module DRBG; a caller IV throws SCC_16 in approved mode. */
  gcmSeal(key: KeyHandle, iv: Uint8Array | null, aad: Uint8Array, plaintext: Uint8Array): Uint8Array
  /**
   * iv(12) || ct || tag(16), for a format whose AAD holds its own nonce (the SLE envelopes): the module draws
   * the IV, writes it into its copy of `aad` at `ivOffset` (the caller's 12 bytes there are ignored), and
   * seals. The caller rebuilds its header from the returned IV.
   */
  gcmSealIvInAad(key: KeyHandle, aad: Uint8Array, ivOffset: number, plaintext: Uint8Array): Uint8Array
  gcmOpen(key: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): Uint8Array
  /**
   * Wraps a fresh key: a fresh master key under a password-class KEK (a new vault), a fresh db key under a
   * `kek` (a new device). Throws SCC_1 when `kek === key`; SCC_17 for any other pair or a key already in
   * use (ever unwrapped, derived from, or keying a database); SCC_16 when an approved KEK would wrap a
   * non-approved key, which would come back approved.
   *
   * What password wrapping cannot stop: code that picks a password can unwrap bytes it chose as a master key
   * (approved under PBKDF2) and so build a key tree whose bytes it knows. No existing key enters such a tree:
   * a master key is wrapped only fresh or moved between password KEKs that open it, and a database key is
   * wrapped once, fresh, and never moved (C5 closed review C4 M1-R; docs/compliance/decisions.md).
   */
  gcmSealKey(kek: KeyHandle, key: KeyHandle, iv: Uint8Array | null, aad: Uint8Array): Uint8Array
  /** Without `usage`, a password-class KEK yields a master key and a `kek` a db key. Never fresh. */
  gcmOpenKey(kek: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array, usage?: KeyUsage): KeyHandle
  /**
   * iv(12) || wrapped(32) || tag(16): the master key wrapped under password-class `oldKek` (which must open it)
   * moved under password-class `newKek`; no handle or byte of the moved key leaves this call. SCC_17 for any
   * other class (a database key never moves); SCC_16 when the old KEK is non-approved and the new one approved.
   */
  rewrapKey(oldKek: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array, newKek: KeyHandle, newAad: Uint8Array): Uint8Array
  /**
   * C9: iv(12) || wrapped(32) || tag(16), a header `history` entry. The master key a proof opens (its wrap under
   * password-class `proofKek`, as for rewrapKey) sealed under K_hist = KBKDF(mkNew, "slate/v2/history", ctx), ctx =
   * vid || uint32be(epoch) (20 bytes). K_hist is never a handle. SCC_1 for `mkNew` being the moved key itself;
   * SCC_16 when the moved key is non-approved and `mkNew` approved.
   */
  historySeal(proofKek: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array, mkNew: KeyHandle, ctx: Uint8Array, newAad: Uint8Array): Uint8Array
  /** C9: a history entry under the K_hist of the master key the proof opens, moved under `mkNew`'s K_hist (the next rotation). */
  historyRewrap(
    proofKek: KeyHandle,
    iv: Uint8Array,
    aad: Uint8Array,
    ctAndTag: Uint8Array,
    ctxCur: Uint8Array,
    entryIv: Uint8Array,
    entryAad: Uint8Array,
    entryCt: Uint8Array,
    mkNew: KeyHandle,
    ctxNew: Uint8Array,
    newAad: Uint8Array,
  ): Uint8Array
  /** C9: a history entry under `mk`'s K_hist as a master-key handle (approved as `mk`, never wrapped again). The caller destroys it. */
  historyOpen(mk: KeyHandle, ctx: Uint8Array, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): KeyHandle
  hmacSha256(key: KeyHandle, data: Uint8Array): Uint8Array
  aesEcbBlock(key: KeyHandle, block: Uint8Array, encrypt: boolean): Uint8Array
  /** AES-256-CTR from the given 16-byte initial counter block (SP 800-38A). */
  aesCtr(key: KeyHandle, icb: Uint8Array, data: Uint8Array): Uint8Array
  sha256(data: Uint8Array): Uint8Array
  randomBytes(n: number): Uint8Array
  /**
   * PQ-A1: FIPS 204 ML-DSA verification, "pure" mode with context string `ctx` (at most 255 bytes), over public
   * bytes only: `spkiDer` is exactly an id-ml-dsa-65/-87 SubjectPublicKeyInfo for `level`, `sig` exactly that
   * level's signature length. False for a signature that does not verify; SCC_1 for any malformed input. Runs
   * outside the FIPS boundary (provider 3.1.2 has no ML-DSA) and is still served after `requireApprovedKeys`.
   */
  mldsaVerify(level: 65 | 87, spkiDer: Uint8Array, msg: Uint8Array, ctx: Uint8Array, sig: Uint8Array): boolean
  /** SQLCipher and the vendored better-sqlite3 binding (audit C3); reach it through `databaseClass`. */
  readonly sqlite: object
}

/**
 * Bit 31 marks a key from a non-approved function (Argon2id, legacy HKDF, or anything derived from one),
 * or any key while no FIPS provider is loaded (review N8). C5's profile policy decides what may use it.
 */
export function isApprovedKey(key: KeyHandle): boolean {
  return (key & 0x80000000) === 0
}

/** `SCC_11` = authentication failed, `SCC_12` = error state; anything else is a module fault. */
export function nativeErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('SCC_') ? code : null
}

let loaded: SlateNative | null = null

/** Throws if the addon is missing or built for another ABI; the POST turns that into POST-MODULE-LOAD. */
export function loadNative(addonPath: string): SlateNative {
  // The addon's state is process-wide: only the main thread may hold it (review N3; binding.c refuses too).
  if (!isMainThread) throw new Error('@slate/native loads on the main thread only')
  loaded ??= createRequire(import.meta.url)(addonPath) as SlateNative
  return loaded
}

const databaseClasses = new WeakMap<SlateNative, DatabaseConstructor>()

/**
 * better-sqlite3's `Database` over this addon's SQLCipher: the app's only SQLite binding (audit C3
 * criterion 1). Its API is better-sqlite3's, except that a key enters only through `keyWithHandle` /
 * `rekeyWithHandle`, the key pragmas are refused, and `loadExtension` does not exist.
 */
export function databaseClass(native: SlateNative): DatabaseConstructor {
  let cls = databaseClasses.get(native)
  if (!cls) {
    cls = createDatabase(() => native.sqlite, false)
    databaseClasses.set(native, cls)
  }
  return cls
}

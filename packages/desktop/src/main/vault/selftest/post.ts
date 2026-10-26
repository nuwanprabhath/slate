// The application power-up self-test (audit §4.2 S-3, §5.2; C6). It runs the production code paths with fixed
// inputs: the key schedule (`deriveSubkey`), the envelope (`sealEnvelope`/`openEnvelope`), both name codecs and
// the password KDF (`deriveKek`), so a corrupted composition fails here, not only a reimplementation of it.
// Every comparison is constant-time. Fault injection (`corrupt`) flips one bit of the expected value, which the
// comparison cannot tell apart from a wrong computation.
//
// Deviations from the audit's listing, forced by the module (C2-C5):
// - no key is imported (`keyImport` exists only in KAT builds): known keys come in through a public password-
//   class KEK and the key schedule (vectors.ts);
// - no caller IV in approved mode: GCM encryption is checked as the CTR keystream (a known answer) plus the
//   sealed body against it, the GCM known answer is an open, and SLE2 is a production seal opened back plus the
//   reference vector opened;
// - once a fips-140-3 vault latched the module approved-only, the non-approved functions must refuse (SCC_16),
//   and that refusal is what their checks expect;
// - the provider's own digest is checked by the module before it loads (SCC_15 at init: POST-MODULE-LOAD).
import { nativeErrorCode, type KeyHandle, type NativeStatus, type SlateNative } from '@slate/native'
import { openEnvelope, sealEnvelope, type EnvelopeKeys } from '../envelope'
import { selfTestKek } from '../kdf'
import { deriveSubkey } from '../keyring'
import { decodeId, decodeIdV2, encodeId, encodeIdV2, blobRemoteName } from '../names'
import { decodeRecovery } from '../recovery'
import { vaultNative } from '../native'
import { SCHEDULE_V1, SUITE, scheduleV2, vidOf } from '../suite'
import { KAT, KAT_VAULT_ID } from './vectors'

export const KAT_IDS = [
  'POST-MODULE-STATUS',
  'POST-SHA256',
  'POST-HMAC-SHA256',
  'POST-AES-ECB-ENC',
  'POST-AES-ECB-DEC',
  'POST-AES-GCM-ENC',
  'POST-AES-GCM-DEC',
  'POST-AES-GCM-TAG-REJECT',
  'POST-KBKDF',
  'POST-HKDF-LEGACY',
  'POST-PBKDF2',
  'POST-ARGON2ID',
  'POST-KEY-WRAP',
  'POST-RECOVERY',
  'POST-SLE2-SEAL',
  'POST-SLE1-OPEN',
  'POST-NAME-V2',
  'POST-DRBG',
  'POST-ZEROIZE',
] as const
/** Besides the KATs: the module could not be loaded or initialised, the run overran its budget (S-5), or the
 * process could not make itself non-dumpable (Z-9, C7). */
export type KatId = (typeof KAT_IDS)[number] | 'POST-MODULE-LOAD' | 'POST-TIMEOUT' | 'POST-HARDEN'

const ALL_IDS: ReadonlySet<string> = new Set<string>([...KAT_IDS, 'POST-MODULE-LOAD', 'POST-TIMEOUT', 'POST-HARDEN'])
export const isKatId = (v: unknown): v is KatId => typeof v === 'string' && ALL_IDS.has(v)

export interface PostResult {
  ok: boolean
  /** In run order; the first entry is the reason the error screen shows. */
  failed: KatId[]
  ran: KatId[]
  ms: number
  module: NativeStatus | null
}

export interface PostOptions {
  /** Null when the addon could not be loaded or initialised at all. */
  native: SlateNative | null
  /** The vault (or install policy) is fips-140-3: the FIPS provider must be active. */
  requireFips: boolean
  /**
   * Test hook (SLATE_TEST_SELFTEST_CORRUPT; honoured only when SLATE_E2E=1 and the app is not packaged, and
   * scrubTestHooks removes it otherwise): the named check compares against an expected value with one bit flipped.
   */
  corrupt?: KatId | null
  /**
   * True at start-up, when nothing else runs: the module's live handle count must also return to where it was.
   * An on-demand run shares the module with the open vault, so it checks only its own handles.
   */
  exclusive?: boolean
  /** Whole-run budget (S-5); exceeding it is POST-TIMEOUT. */
  budgetMs?: number
  now?: () => number
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return d === 0
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const equalText = (a: string, b: string): boolean => equal(utf8(a), utf8(b))

function flipped(v: Uint8Array): Uint8Array {
  const c = Uint8Array.from(v)
  c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 0x01
  return c
}

const flippedText = (s: string): string => s.slice(0, -1) + (s.endsWith('0') ? '1' : '0')

/** The service refused because a fips-140-3 vault latched the module approved-only (C5). */
function refusedAsNonApproved(run: () => unknown): boolean {
  try {
    run()
    return false
  } catch (e) {
    return nativeErrorCode(e) === 'SCC_16'
  }
}

async function refusedAsNonApprovedAsync(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch (e) {
    return nativeErrorCode(e) === 'SCC_16'
  }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * S-3 steps 4-6 (the module was loaded, hardened and initialised before). Runs inside a module self-test
 * session (`postBegin`/`postEnd`): a gated module serves nothing else until the first one passed, and a failed
 * one leaves it in the error state for the life of the process (ISO/IEC 19790 §7.10). Runs one at a time.
 */
export function runPost(opts: PostOptions): Promise<PostResult> {
  const run = queue.then(() => runPostNow(opts))
  queue = run.catch(() => {})
  return run
}

async function runPostNow(opts: PostOptions): Promise<PostResult> {
  const now = opts.now ?? (() => performance.now())
  const start = now()
  const n = opts.native
  if (!n) return { ok: false, failed: ['POST-MODULE-LOAD'], ran: ['POST-MODULE-LOAD'], ms: now() - start, module: null }
  const ran: KatId[] = []
  const failed: KatId[] = []
  const budget = opts.budgetMs ?? 10_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget)
  })
  let session = false
  try {
    n.postBegin()
    session = true
  } catch {
    failed.push('POST-MODULE-STATUS')
  }
  if (session) {
    const outcome = await Promise.race([runChecks(n, opts, ran, failed), timedOut])
    if (outcome === 'timeout' && !failed.includes('POST-TIMEOUT')) failed.push('POST-TIMEOUT')
  }
  clearTimeout(timer)
  const ms = now() - start
  if (ms > budget && !failed.includes('POST-TIMEOUT')) failed.push('POST-TIMEOUT')
  const passed = failed.length === 0
  try {
    if (session) n.postEnd(passed)
    else n.enterErrorState()
  } catch {
    // postEnd(false) answers SCC_12: the module is now in its error state, which is the point. postEnd(true)
    // refusing means the module latched after the last check (review C6): that is a failure too.
    if (passed) failed.push('POST-MODULE-STATUS')
  }
  const ok = failed.length === 0
  return { ok, failed, ran, ms, module: safeStatus(n) }
}

function safeStatus(n: SlateNative): NativeStatus | null {
  try {
    return n.status()
  } catch {
    return null
  }
}

async function runChecks(n: SlateNative, opts: PostOptions, ran: KatId[], failed: KatId[]): Promise<void> {
  const corrupt = opts.corrupt ?? null
  const want = (id: KatId, v: Uint8Array) => (corrupt === id ? flipped(v) : v)
  const wantText = (id: KatId, v: string) => (corrupt === id ? flippedText(v) : v)
  const owned: KeyHandle[] = []
  const own = (h: KeyHandle) => (owned.push(h), h)
  const check = async (id: KatId, test: () => boolean | Promise<boolean>) => {
    ran.push(id)
    let ok = false
    try {
      ok = (await test()) && corrupt !== id
    } catch {
      ok = false
    }
    if (!ok) failed.push(id)
  }
  const baseline = n.status().liveHandles
  const latched = () => n.status().approvedKeysOnly

  await check('POST-MODULE-STATUS', () => {
    const s = n.status()
    if (s.errorState || s.moduleSelfTestFailures !== 0) return false
    // The vault's primitives must run on the module under test, not on some other instance.
    if (vaultNative() !== n) return false
    return !opts.requireFips || s.fipsActive
  })
  await check('POST-SHA256', () => equal(n.sha256(KAT.sha256.msg), want('POST-SHA256', KAT.sha256.out)))

  // Known keys, through public functions only (vectors.ts): KEK_t from a public secret unwraps MK.
  const t = KAT.transport
  const vid = vidOf(KAT_VAULT_ID)
  let master: KeyHandle | null = null
  let kekT: KeyHandle | null = null
  try {
    kekT = own(n.kbkdfFromSecret(t.secret(), t.label, vid, true))
    master = own(n.gcmOpenKey(kekT, t.mkIv, t.mkAad, t.mkWrap, 'master'))
  } catch {
    master = null
  }
  const v2 = scheduleV2(KAT_VAULT_ID, 'standard')
  const sub = (name: Parameters<typeof deriveSubkey>[1], schedule: typeof v2) => {
    if (master === null) throw new Error('no master key')
    return own(deriveSubkey(master, name, schedule))
  }

  await check('POST-HMAC-SHA256', () => equalText(blobRemoteName(sub('name', v2), KAT.hmacSha256.name), wantText('POST-HMAC-SHA256', KAT.hmacSha256.out)))

  if (latched()) {
    // Suite 0x01 names are AES-ECB: refused outright, whatever the key, after a fips-140-3 vault's latch.
    const e = KAT.aesEcb
    await check('POST-AES-ECB-ENC', () => refusedAsNonApproved(() => encodeId(sub('nameEnc', v2), e.kind, e.uuid)))
    await check('POST-AES-ECB-DEC', () => refusedAsNonApproved(() => decodeId(sub('nameEnc', v2), e.name)))
  } else {
    const nameEnc1 = (() => {
      try {
        return sub('nameEnc', SCHEDULE_V1)
      } catch {
        return null
      }
    })()
    const e = KAT.aesEcb
    await check('POST-AES-ECB-ENC', () => nameEnc1 !== null && equalText(encodeId(nameEnc1, e.kind, e.uuid), wantText('POST-AES-ECB-ENC', e.name)))
    await check('POST-AES-ECB-DEC', () => {
      const back = nameEnc1 === null ? null : decodeId(nameEnc1, e.name)
      return back !== null && back.kind === e.kind && equalText(back.uuid, wantText('POST-AES-ECB-DEC', e.uuid))
    })
  }

  const g = KAT.aesGcm
  const gcmKey = (() => {
    try {
      return sub('prefs', v2)
    } catch {
      return null
    }
  })()
  await check('POST-AES-GCM-ENC', () => {
    if (gcmKey === null) return false
    // The forward cipher as a known answer (CTR from a fixed counter block), then a production seal (module IV)
    // whose ciphertext must be that keystream from its own IV, and which opens back.
    if (!equal(n.aesCtr(gcmKey, g.icb, g.pt), want('POST-AES-GCM-ENC', g.ctr))) return false
    const sealed = n.gcmSeal(gcmKey, null, g.aad, g.pt)
    const iv = sealed.subarray(0, 12)
    const icb = new Uint8Array(16)
    icb.set(iv, 0)
    icb[15] = 2
    if (sealed.length !== 12 + g.pt.length + 16) return false
    if (!equal(sealed.subarray(12, 12 + g.pt.length), n.aesCtr(gcmKey, icb, g.pt))) return false
    return equal(n.gcmOpen(gcmKey, iv, g.aad, sealed.subarray(12)), g.pt)
  })
  await check('POST-AES-GCM-DEC', () => gcmKey !== null && equal(n.gcmOpen(gcmKey, g.iv, g.aad, g.ctTag), want('POST-AES-GCM-DEC', g.pt)))
  await check('POST-AES-GCM-TAG-REJECT', () => {
    if (gcmKey === null) return false
    try {
      n.gcmOpen(gcmKey, g.iv, g.aad, flipped(g.ctTag))
      return false // a forged tag that opens is the worst failure there is
    } catch (e) {
      return nativeErrorCode(e) === 'SCC_11'
    }
  })

  await check('POST-KBKDF', () => equal(n.hmacSha256(sub('sync', v2), KAT.probe), want('POST-KBKDF', KAT.kbkdf.out)))
  await check('POST-HKDF-LEGACY', () =>
    latched() ? refusedAsNonApproved(() => sub('sync', SCHEDULE_V1)) : equal(n.hmacSha256(sub('sync', SCHEDULE_V1), KAT.probe), want('POST-HKDF-LEGACY', KAT.hkdfV1.out)),
  )

  // A password KEK proves its bytes by unwrapping a key sealed under the expected KEK (it can do nothing else).
  const opensUnder = (kek: KeyHandle, wrap: Uint8Array): boolean => {
    own(n.gcmOpenKey(kek, KAT.kdfWrap.iv, KAT.kdfWrap.aad, wrap, 'master'))
    return true
  }
  // The vectors' cost is far below a vault's floor, so they come from kdf.ts's fixed self-test inputs, never
  // from deriveKek with its floors lowered.
  const p = KAT.pbkdf2
  await check('POST-PBKDF2', async () => opensUnder(own(await selfTestKek('pbkdf2-hmac-sha512')), want('POST-PBKDF2', p.wrap)))
  const a = KAT.argon2
  await check('POST-ARGON2ID', async () => {
    if (latched()) return refusedAsNonApprovedAsync(async () => own(await selfTestKek('argon2id')))
    return opensUnder(own(await selfTestKek('argon2id')), want('POST-ARGON2ID', a.wrap))
  })

  // A master key's identity, observed through the key schedule: HMAC(K_sync v2, probe). For the published MK this is
  // the known answer KAT.kbkdf.out.
  const probeOf = (mk: KeyHandle) => n.hmacSha256(own(deriveSubkey(mk, 'sync', v2)), KAT.probe)
  const w = KAT.keyWrap
  await check('POST-KEY-WRAP', () => {
    if (kekT === null || master === null) return false
    // Review C6: wrapping writes the keys a vault keeps on disk (MK under KEK_pw, LK under K_localwrap); a wrong wrap
    // would lose them. Each wrap is opened by gcmOpenKey, whose known answer is the transport above.
    // (1) A fresh master key, wrapped under a password-class KEK, opens to the same key.
    const fresh = own(n.keyRandom('master'))
    const wrapped = n.gcmSealKey(kekT, fresh, null, w.aad)
    const back = own(n.gcmOpenKey(kekT, wrapped.subarray(0, 12), w.aad, wrapped.subarray(12), 'master'))
    if (!equal(probeOf(fresh), probeOf(back))) return false
    // (2) The published MK's wrap moved to a second KEK (rewrapKey) opens there to the published MK.
    const kek2 = own(n.kbkdfFromSecret(w.secret2(), t.label, vid, true))
    const moved = n.rewrapKey(kekT, t.mkIv, t.mkAad, t.mkWrap, kek2, w.aad)
    const mk2 = own(n.gcmOpenKey(kek2, moved.subarray(0, 12), w.aad, moved.subarray(12), 'master'))
    if (!equal(probeOf(mk2), want('POST-KEY-WRAP', KAT.kbkdf.out))) return false
    // (3) A fresh database key under K_localwrap opens again (GCM authenticates the key bytes it carries).
    const localWrap = sub('localwrap', v2)
    const lk = own(n.keyRandom('db'))
    const lkWrap = n.gcmSealKey(localWrap, lk, null, w.aad)
    own(n.gcmOpenKey(localWrap, lkWrap.subarray(0, 12), w.aad, lkWrap.subarray(12), 'db'))
    if (lkWrap.length !== 60) return false
    // (4) C9: the published MK moved into the key history of `fresh` (historySeal), and on to the next epoch's key
    // (historyRewrap, from fresh's own wrap as the proof), opens there (historyOpen) to the published MK.
    const ctx = new Uint8Array(20)
    ctx.set(vid, 0)
    const entry = n.historySeal(kekT, t.mkIv, t.mkAad, t.mkWrap, fresh, ctx, w.aad)
    const next = own(n.keyRandom('master'))
    const onward = n.historyRewrap(kekT, wrapped.subarray(0, 12), w.aad, wrapped.subarray(12), ctx, entry.subarray(0, 12), w.aad, entry.subarray(12), next, ctx, w.aad)
    const old = own(n.historyOpen(next, ctx, onward.subarray(0, 12), w.aad, onward.subarray(12)))
    return equal(probeOf(old), want('POST-KEY-WRAP', KAT.kbkdf.out))
  })
  await check('POST-RECOVERY', () => {
    // The typed recovery key, decoded in the module (production decodeRecovery), gives KEK_rc (suite 0x02), which
    // opens the published MK sealed under the expected KEK_rc.
    const r = KAT.recovery
    const decoded = own(decodeRecovery(utf8(r.text)))
    const kekRc = own(n.kbkdfFromRecovery(decoded, 'slate/v2/recovery', vid, true))
    const mk3 = own(n.gcmOpenKey(kekRc, r.iv, r.aad, r.wrap, 'master'))
    return equal(probeOf(mk3), want('POST-RECOVERY', KAT.kbkdf.out))
  })

  const env = KAT.envelope
  await check('POST-SLE2-SEAL', () => {
    const keys: EnvelopeKeys = { syncKey: sub('sync', v2), suite: SUITE.KBKDF_AES256GCM, keyEpoch: 0, readSuites: new Set([SUITE.KBKDF_AES256GCM]) }
    const sealed = sealEnvelope(keys, env.path, env.plaintext)
    const header = sealed.subarray(0, 10)
    const shape = equal(header, Uint8Array.from([0x53, 0x4c, 0x45, 0x32, 0x02, 0x00, 0, 0, 0, 0])) && sealed.length === 38 + env.plaintext.length + 16
    return shape && equal(openEnvelope(keys, env.path, sealed), env.plaintext) && equal(openEnvelope(keys, env.path, env.sle2), want('POST-SLE2-SEAL', env.plaintext))
  })
  await check('POST-SLE1-OPEN', () => {
    if (latched()) return refusedAsNonApproved(() => sub('sync', SCHEDULE_V1))
    const keys: EnvelopeKeys = { syncKey: sub('sync', SCHEDULE_V1), suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: new Set([SUITE.HKDF_AES256GCM]) }
    return equal(openEnvelope(keys, env.path, env.sle1), want('POST-SLE1-OPEN', env.plaintext))
  })
  await check('POST-NAME-V2', () => {
    const v = KAT.nameV2
    const keys = { enc: sub('nameEnc', v2), mac: sub('nameMac', v2) }
    const name = encodeIdV2(keys, v.kind, v.uuid)
    const back = decodeIdV2(keys, v.name)
    return equalText(name, wantText('POST-NAME-V2', v.name)) && back !== null && back.kind === v.kind && back.uuid === v.uuid
  })
  await check('POST-DRBG', () => {
    // A sanity check only: the module runs the SP 800-90A/B health tests itself.
    const x = n.randomBytes(32)
    const y = n.randomBytes(32)
    return !equal(x, y) && x.some((b) => b !== 0)
  })
  await check('POST-ZEROIZE', () => {
    let all = true
    for (const h of owned.splice(0)) {
      try {
        n.keyDestroy(h)
      } catch {
        all = false
      }
      // Gone for good: destroying it again is SCC_8.
      try {
        n.keyDestroy(h)
        all = false
      } catch (e) {
        if (nativeErrorCode(e) !== 'SCC_8') all = false
      }
    }
    return all && (!opts.exclusive || n.status().liveHandles === baseline)
  })
  for (const h of owned.splice(0)) {
    try {
      n.keyDestroy(h)
    } catch {
      // Already gone.
    }
  }
}

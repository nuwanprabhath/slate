// Known-answer vectors for the power-up self-test (audit §5.2, C6). Computed with node:crypto and hash-wasm,
// independently of @slate/native, and recomputed by vectors.test.ts; the PBKDF2 and Argon2id outputs are the
// audit's Appendix A vectors.
//
// The module imports no key bytes (review C2 M3), so the self-test brings known keys in the way the vault
// formats do: a password-class KEK from a public secret (`kbkdfFromSecret`) unwraps a public master key, and
// the production key schedule (`deriveSubkey`) derives every other key from it. Those keys are public by
// construction and live only for the run; post.ts destroys each one (POST-ZEROIZE).

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'))
const fill = (n: number, byte: number): Uint8Array => new Uint8Array(n).fill(byte)
const seq = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => from + i)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The vault id whose 16 bytes are every suite-0x02 KBKDF Context below (the audit's KBKDF context). */
export const KAT_VAULT_ID = '00000000-0000-4000-8000-0000000000aa'

export const KAT = {
  /** KEK_t = KBKDF(00..1f, "slate/post/transport", vid), password class; MK = 20..3f wrapped under it. */
  transport: {
    /** A fresh copy each time: the module wipes the secret it is given. */
    secret: () => seq(32),
    label: 'slate/post/transport',
    mkIv: fill(12, 0x33),
    mkAad: utf8('slate/post/mk'),
    mkWrap: hex('3388ca613e7a1e4f6ced2cbe5213e00721158305ca90e734cbc41764991e3018a7ad97c2071cfa7ef44adc7c099cc9c2'),
  },
  sha256: { msg: utf8('abc'), out: hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') }, // FIPS 180-4 example
  /** blobRemoteName(K_name v2, "post.png") = HMAC-SHA-256(K_name, "blob|post.png"). */
  hmacSha256: { name: 'post.png', out: 'a9ad6e71c62af744727f94e603e2ce853b8022718c189fc7e9197baa0a8401bc' },
  /** encodeId(K_name_enc v1, page, uuid): one AES-256 block of the packed id (suite 0x01 names). */
  aesEcb: { kind: 'page', uuid: '00000000-0000-4000-8000-000000000001', name: 'ac694c0a827f33870c991f75990b8329' },
  /** Under K_prefs v2: AES-256-CTR from a fixed counter block, and GCM with a fixed IV (opened, never sealed). */
  aesGcm: {
    pt: utf8('slate-post-gcm-plaintext'),
    icb: fill(16, 0x44),
    ctr: hex('74309c301f73f45ea25c8360a11e79ae93908cd00f3cf2f3'),
    iv: fill(12, 0x55),
    aad: utf8('slate/post/gcm'),
    ctTag: hex('6174e761724ed51af69dfd7ed5190b8e759b47ddd7a65e935cb43e11608b33bccc4f4766d1009aa2'),
  },
  /** HMAC-SHA-256(subkey, probe) for K_sync of each key schedule: KBKDF (suite 0x02) and RFC 5869 HKDF (0x01). */
  probe: utf8('slate/post/probe'),
  kbkdf: { out: hex('40b25650f41b008b3e18d6f659cf56b5d461dcaab389c1fc02cc982682533e32') },
  hkdfV1: { out: hex('319545a810b8d3659c4c118ee0296f2040e02fb5931298f0af3302e3095fa324') },
  /**
   * Password KEKs, each checked by unwrapping 40..5f sealed under the expected KEK (Appendix A outputs). The
   * inputs are fixed in kdf.ts (`selfTestKek`), so nothing can ask it for another derivation; vectors.test.ts
   * holds them equal to these.
   */
  kdfWrap: { iv: fill(12, 0x66), aad: utf8('slate/post/kdf') },
  pbkdf2: {
    password: 'slate-kat-password',
    salt: fill(32, 0x5a),
    iterations: 1000,
    out: hex('13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079'),
    wrap: hex('ec11d124a6e74830691b7f8c88d41f3893d18b377690a348a44a90fd1830a743978d088452d234b80c549aed59b9f818'),
  },
  argon2: {
    password: 'slate-kat-password',
    salt: fill(16, 0x5a),
    memoryKiB: 32,
    passes: 3,
    out: hex('688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812'),
    wrap: hex('5385c97a5e853dfa95b2c4d9c0f8aeacccc784c28fbf7d5e1db52db6c4e7f7e9da163159e1ae88dd5e9b7b27759ed1b9'),
  },
  /** POST-KEY-WRAP: a second password-class KEK, KBKDF(a0..bf, "slate/post/transport", vid), and the wraps' AAD. */
  keyWrap: { secret2: () => seq(32, 0xa0), aad: utf8('slate/post/wrap') },
  /** POST-RECOVERY: the recovery key 80..9f as typed text, and MK sealed under its KEK_rc = KBKDF(rk, "slate/v2/recovery", vid). */
  recovery: {
    text: 'G20R-50W4-GP38-F249-HA5R-S3CE-HY89-34MK-JJAS-D5WR-K6D9-Q74X-KTFG-GBC6',
    iv: fill(12, 0x77),
    aad: utf8('slate/post/recovery'),
    wrap: hex('41b6e0725d02b0241bc6848e90b84782e720ae39b6be21f0806a138ab09b7088d6f737bb11e501e25f8f196559743a2a'),
  },
  /** Envelopes under K_sync of each schedule, salt 11 x 16, nonce 22 x 12, epoch 0, no flags. */
  envelope: {
    path: 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk',
    plaintext: utf8('slate-kat-plaintext'),
    sle2: hex('534c453202000000000011111111111111111111111111111111222222222222222222222222fdd9ade163a688b97af8cb8c8a466cca26bf3c9a4ceb0042a96469dba7dd481f24fa85'),
    sle1: hex('534c45310011111111111111111111111111111111222222222222222222222222c84c42456e94bf248e150675453fea5bb0c936b75ed7aee75f905cada9a486659ff77e'),
  },
  /** encodeIdV2(K_name_enc v2, K_name_mac v2, page, uuid): the suite-0x02 SIV name. */
  nameV2: { kind: 'page', uuid: '00000000-0000-4000-8000-000000000001', name: '79562cdb0c97e0e24e5f707d6c96f07c35f98b83f461f73656af0db679a7078d' },
} as const

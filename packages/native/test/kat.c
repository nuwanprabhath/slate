/* packages/native/test/kat.c — native KATs and zeroisation checks (T-ZERO-03). Built with -DSCC_KAT_BUILD,
 * which is the only build that compiles scc__slot_bytes_for_kat; the shipped addon never contains it. */
#include "slate_crypto_core.h"
#include "vectors/mldsa/sigver.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>

unsigned char *scc__slot_bytes_for_kat(uint32_t h);
void scc__force_provider_error_for_kat(void);
void scc__set_generation_for_kat(uint32_t slot, uint32_t generation);

static int fails = 0;

static void expect(const char *name, const unsigned char *got, size_t n, const char *want) {
  char h[512];
  for (size_t i = 0; i < n; i++) snprintf(h + 2 * i, 3, "%02x", got[i]);
  int ok = strcmp(h, want) == 0;
  fails += !ok;
  printf("%s %s%s%s\n", ok ? "PASS" : "FAIL", name, ok ? "" : " got ", ok ? "" : h);
}

static void expect_key(const char *name, uint32_t h, const char *want) {
  unsigned char *k = scc__slot_bytes_for_kat(h);
  if (k == NULL) { printf("FAIL %s (no such handle)\n", name); fails++; return; }
  expect(name, k, 32, want);
}

static void check(const char *name, int ok) {
  fails += !ok;
  printf("%s %s\n", ok ? "PASS" : "FAIL", name);
}

/* T-PQ-A1-06: an ACVP ML-DSA sigVer case as bytes; its SPKI is the level's fixed RFC 9881 DER prefix || pk. */
typedef struct {
  unsigned char spki[22 + 2592 + 1], msg[8192], ctx[256], sig[4627 + 1];
  size_t spki_len, msg_len, ctx_len, sig_len;
} mldsa_bytes_t;

static size_t unhex(const char *h, unsigned char *out, size_t cap) {
  size_t n = strlen(h) / 2;
  if (n > cap) { printf("FAIL vector does not fit (%zu > %zu)\n", n, cap); fails++; return 0; }
  for (size_t i = 0; i < n; i++) sscanf(h + 2 * i, "%2hhx", &out[i]);
  return n;
}

static void mldsa_bytes(const mldsa_sigver_t *v, mldsa_bytes_t *b) {
  const char *prefix = v->level == 65 ? "308207b2300b0609608648016503040312038207a100" : "30820a32300b060960864801650304031303820a2100";
  size_t pre = unhex(prefix, b->spki, sizeof b->spki);
  b->spki_len = pre + unhex(v->pk, b->spki + pre, sizeof b->spki - 1 - pre);
  b->msg_len = unhex(v->message, b->msg, sizeof b->msg);
  b->ctx_len = unhex(v->context, b->ctx, sizeof b->ctx);
  b->sig_len = unhex(v->signature, b->sig, sizeof b->sig - 1);
}

static int mldsa_verify(int level, const mldsa_bytes_t *b) {
  return scc_mldsa_verify(level, b->spki, b->spki_len, b->msg, b->msg_len, b->ctx, b->ctx_len, b->sig, b->sig_len);
}

/* kat                     -> development build: default provider only, no FIPS claim
 * kat <config> <modules>  -> the FIPS provider through the generated config (fipsConfig.ts layout) */
int main(int argc, char **argv) {
  int fips = argc == 3;
  /* Review M1: before scc_init every service refuses (SCC_2), so nothing can reach OpenSSL's implicit
   * configuration (OPENSSL_CONF) or allocate a key outside the secure heap. */
  unsigned char early[32];
  uint32_t eh = 0;
  check("pre-init: scc_preinit", scc_preinit() == SCC_OK);
  check("pre-init: random refused", scc_random(early, 4) == SCC_ERR_STATE);
  check("pre-init: keyRandom refused", scc_key_random(&eh) == SCC_ERR_STATE);
  check("pre-init: sha256 refused", scc_sha256(early, 4, early) == SCC_ERR_STATE);
  check("pre-init: nothing allocated", scc_live_handles() == 0);
  /* C2 M2: the status queries are safe with no secure heap (OpenSSL's heap lock is still NULL here). */
  check("pre-init: secure heap query safe", scc_secure_heap_used() == 0);
  check("pre-init: not ready, nothing passed", !scc_ready() && !scc_post_passed() && !scc_fips_active());
  char early_names[64], early_ver[32];
  check("pre-init: no provider list, no module info", scc_default_ctx_providers(early_names, sizeof early_names) == SCC_ERR_STATE &&
                                                      scc_fips_module_info(early_names, sizeof early_names, early_ver, sizeof early_ver) == SCC_ERR_STATE);
  check("pre-init: zeroize and in_error_state safe", scc_zeroize_all() == 0 && !scc_in_error_state());
  check("T-PQ-A1-06 pre-init: no PQ inventory, ML-DSA verify refused", scc_pq_algorithms(early_names, sizeof early_names) == SCC_ERR_STATE &&
                                                                       scc_pq_in_fips_boundary() == 0 &&
                                                                       scc_mldsa_verify(65, early, 0, early, 0, early, 0, early, 0) == SCC_ERR_STATE);
  int rc = fips ? scc_init(argv[1], argv[2], 1) : scc_init(NULL, NULL, 0);
  if (rc != SCC_OK) { printf("FAIL init SCC_%d\n", -rc); return 1; }
  check(fips ? "FIPS provider active (fips + base, fips=yes)" : "no FIPS claim without the provider", scc_fips_active() == fips);
  if (fips) {
    char name[128], version[64];
    check("FIPS module reports its name and version", scc_fips_module_info(name, sizeof name, version, sizeof version) == SCC_OK);
    printf("     module: %s %s\n", name, version);
  }
  unsigned char seq[32], zero[32] = {0}, out[64], iv0[12] = {0}, ivo[12], ct[64], pt[32];
  for (int i = 0; i < 32; i++) seq[i] = (unsigned char)i;
  const unsigned char vid[16] = {0, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 0xaa};
  unsigned char s11[16], s5a16[16], s5a32[32], n22[12];
  memset(s11, 0x11, 16); memset(s5a16, 0x5a, 16); memset(s5a32, 0x5a, 32); memset(n22, 0x22, 12);
  uint32_t mk, ksync, kfile, kpw, kargon, kz, kecb, kjefe, kv1, kek, wrapped, back, bad;

  scc_key_import(seq, 32, &mk);
  scc_kbkdf(mk, "slate/v2/sync", 13, vid, 16, &ksync);
  expect_key("KBKDF kSync", ksync, "88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388");
  scc_kbkdf(ksync, "slate/v2/remote-file", 20, s11, 16, &kfile);
  expect_key("KBKDF fileKey", kfile, "ccc0c941926d90b66ab707799a53336118ec8590779bd7b244719575a403696a");
  scc_hkdf_legacy(mk, zero, 0, "slate/v1/sync", 13, &kv1);
  expect_key("HKDF legacy v1 sync", kv1, "50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c");
  scc_pbkdf2((const unsigned char *)"slate-kat-password", 18, s5a32, 32, 1000, &kpw);
  expect_key("PBKDF2-HMAC-SHA-512", kpw, "13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079");
  scc_argon2id((const unsigned char *)"slate-kat-password", 18, s5a16, 16, 32, 3, &kargon);
  expect_key("Argon2id", kargon, "688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812");

  scc_key_import(zero, 32, &kz);
  scc_gcm_seal(kz, iv0, NULL, 0, zero, 16, ivo, ct);
  expect("AES-256-GCM TC14", ct, 32, "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919");
  check("AES-256-GCM open", scc_gcm_open(kz, iv0, NULL, 0, ct, 32, pt) == SCC_OK);
  ct[0] ^= 1;
  check("AES-256-GCM tamper refused", scc_gcm_open(kz, iv0, NULL, 0, ct, 32, pt) == SCC_ERR_AUTH);

  /* H1: a length above the cap is refused before anything is read or written (these buffers are
   * small on purpose: the old (int) casts processed len mod 2^32 bytes and wrote the tag out of bounds). */
  const size_t over_int = (size_t)INT_MAX + 17u, over_4g = ((size_t)1 << 32) + 21u;
  uint32_t lk = 0;
  check("L1 a label with a NUL inside is refused", scc_kbkdf(kz, "slate/enc\0other", 15, vid, 16, &lk) == SCC_ERR_ARG);
  check("L1 a 129-byte label is refused", scc_kbkdf(kz, (const char *)out, SCC_MAX_LABEL + 1, vid, 16, &lk) == SCC_ERR_ARG);
  check("L1 an empty label is refused", scc_kbkdf(kz, "", 0, vid, 16, &lk) == SCC_ERR_ARG);
  check("L1 HKDF info with a NUL is refused", scc_hkdf_legacy(kz, zero, 0, "a\0b", 3, &lk) == SCC_ERR_ARG);
  check("L2 PBKDF2 below 1000 iterations is refused", scc_pbkdf2(seq, 8, s5a32, 32, 999, &lk) == SCC_ERR_ARG);
  check("L2 PBKDF2 above 10^7 iterations is refused", scc_pbkdf2(seq, 8, s5a32, 32, 10000001u, &lk) == SCC_ERR_ARG);
  check("L2 Argon2id above 4 GiB is refused", scc_argon2id(seq, 8, s5a16, 16, 4194305u, 3, &lk) == SCC_ERR_ARG);
  check("L2 Argon2id with 0 or 17 passes is refused", scc_argon2id(seq, 8, s5a16, 16, 32, 0, &lk) == SCC_ERR_ARG && scc_argon2id(seq, 8, s5a16, 16, 32, 17, &lk) == SCC_ERR_ARG);
  check("H1 gcmOpen refuses a > INT_MAX ciphertext", scc_gcm_open(kz, iv0, NULL, 0, ct, over_int, pt) == SCC_ERR_TOO_LARGE);
  check("H1 gcmOpen refuses a 2^32 + 21 ciphertext (forgery shape)", scc_gcm_open(kz, iv0, NULL, 0, ct, over_4g, pt) == SCC_ERR_TOO_LARGE);
  check("H1 gcmSeal refuses a 2^32 + 21 plaintext", scc_gcm_seal(kz, iv0, NULL, 0, zero, over_4g, ivo, ct) == SCC_ERR_TOO_LARGE);
  check("H1 gcmSeal refuses 2^32 + 21 bytes of AAD", scc_gcm_seal(kz, iv0, zero, over_4g, zero, 16, ivo, ct) == SCC_ERR_TOO_LARGE);
  check("H1 gcmOpen refuses 2^32 + 21 bytes of AAD", scc_gcm_open(kz, iv0, zero, over_4g, ct, 32, pt) == SCC_ERR_TOO_LARGE);
  check("H1 aesCtr refuses a > INT_MAX input", scc_aes_ctr(kz, zero, zero, over_int, out) == SCC_ERR_TOO_LARGE);
  check("H1 one byte over the 256 MiB cap is refused", scc_gcm_open(kz, iv0, NULL, 0, ct, SCC_MAX_INPUT + 17u, pt) == SCC_ERR_TOO_LARGE);

  const char *path = "docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk";
  unsigned char hdr[38] = {'S', 'L', 'E', '2', 0x02, 0x00, 0, 0, 0, 0}, aad[256];
  memcpy(hdr + 10, s11, 16); memcpy(hdr + 26, n22, 12);
  memcpy(aad, hdr, 38); aad[38] = '|'; memcpy(aad + 39, path, strlen(path));
  scc_gcm_seal(kfile, n22, aad, 39 + strlen(path), (const unsigned char *)"slate-kat-plaintext", 19, ivo, ct);
  expect("SLE2 ct|tag", ct, 35, "3a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010");

  unsigned char blk[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}, back16[16];
  scc_key_import(seq, 32, &kecb);
  scc_aes_ecb_block(kecb, blk, 1, out);
  expect("AES-256 FIPS 197 C.3 encrypt", out, 16, "8ea2b7ca516745bfeafc49904b496089");
  scc_aes_ecb_block(kecb, out, 0, back16);
  expect("AES-256 FIPS 197 C.3 decrypt", back16, 16, "00112233445566778899aabbccddeeff");
  scc_sha256((const unsigned char *)"abc", 3, out);
  expect("SHA-256 abc", out, 32, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  unsigned char jefe[32] = {'J', 'e', 'f', 'e'};
  scc_key_import(jefe, 32, &kjefe);
  scc_hmac_sha256(kjefe, (const unsigned char *)"what do ya want for nothing?", 28, out);
  expect("HMAC-SHA-256 RFC 4231 TC2", out, 32, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");

  scc_key_random_for(SCC_USE_KEK, &kek);
  scc_key_random_for(SCC_USE_DB, &wrapped);
  scc_gcm_seal_key(kek, wrapped, NULL, (const unsigned char *)"aad", 3, ivo, ct);
  check("key unwrap into the heap", scc_gcm_open_key(kek, ivo, (const unsigned char *)"aad", 3, ct, 48, &back) == SCC_OK &&
                                        memcmp(scc__slot_bytes_for_kat(back), scc__slot_bytes_for_kat(wrapped), 32) == 0);
  check("M3 a key is never wrapped with itself", scc_gcm_seal_key(kek, kek, NULL, NULL, 0, ivo, ct) == SCC_ERR_ARG);
  size_t live = scc_live_handles();
  ct[47] ^= 1;
  check("tampered unwrap refused, no handle leaked", scc_gcm_open_key(kek, ivo, (const unsigned char *)"aad", 3, ct, 48, &bad) == SCC_ERR_AUTH && scc_live_handles() == live);

  char raw[68];
  uint32_t kdb = 0;
  scc_key_import_for(seq, 32, SCC_USE_DB, &kdb);
  check("SQLCipher raw key format", scc_sqlcipher_raw_key(kdb, raw) == SCC_OK && strcmp(raw, "x'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'") == 0);
  check("C4 only a database key reaches SQLCipher", scc_sqlcipher_raw_key(mk, raw) == SCC_ERR_USAGE);
  scc_key_destroy(kdb);
  uint32_t stale = mk;
  check("destroy", scc_key_destroy(mk) == SCC_OK);
  check("stale handle refused", scc_key_destroy(stale) == SCC_ERR_HANDLE);
  size_t n = scc_zeroize_all();
  check("zeroize_all destroyed every live handle", n == live - 1 && scc_live_handles() == 0);

  /* C4 usage flags (review C2 R2, C3 L1/L2): a handle does only what its usage allows (SCC_ERR_USAGE). */
  {
    uint32_t pwk = 0, data = 0, master = 0, dbk = 0, back2 = 0, sub = 0, x = 0;
    scc_pbkdf2((const unsigned char *)"slate-kat-password", 18, s5a32, 32, 1000, &pwk);
    scc_key_random(&data);
    scc_key_random_for(SCC_USE_MASTER, &master);
    scc_key_random_for(SCC_USE_DB, &dbk);
    check("C4 keyRandom never makes a password-class key", scc_key_random_for(SCC_USE_PASSWORD, &x) == SCC_ERR_ARG);
    check("C4 R2 a password KEK never wraps a data key", scc_gcm_seal_key(pwk, data, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    check("C4 R2 a password KEK never wraps a database key", scc_gcm_seal_key(pwk, dbk, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    check("C4 a password KEK wraps a master key", scc_gcm_seal_key(pwk, master, NULL, NULL, 0, ivo, ct) == SCC_OK);
    check("C4 what a password KEK unwraps is a master key only", scc_gcm_open_key_for(pwk, ivo, NULL, 0, ct, 48, SCC_USE_DATA, &x) == SCC_ERR_USAGE);
    check("C4 password KEK unwrap", scc_gcm_open_key(pwk, ivo, NULL, 0, ct, 48, &back2) == SCC_OK &&
                                        memcmp(scc__slot_bytes_for_kat(back2), scc__slot_bytes_for_kat(master), 32) == 0);
    check("C4 a password KEK encrypts nothing", scc_gcm_seal(pwk, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE);
    check("C4 a password KEK derives nothing", scc_kbkdf(pwk, "x", 1, vid, 16, &x) == SCC_ERR_USAGE && scc_hkdf_legacy(pwk, zero, 0, "x", 1, &x) == SCC_ERR_USAGE);
    check("C4 a master key encrypts nothing", scc_gcm_seal(back2, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE && scc_hmac_sha256(back2, seq, 4, out) == SCC_ERR_USAGE);
    check("C4 a master key derives data keys", scc_hkdf_legacy(back2, zero, 0, "slate/v1/sync", 13, &sub) == SCC_OK && scc_gcm_seal(sub, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_OK);
    check("C4 a data key is never wrapped under a master key", scc_gcm_seal_key(back2, sub, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    check("C4 a database key encrypts and derives nothing", scc_gcm_seal(dbk, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE && scc_kbkdf(dbk, "x", 1, vid, 16, &x) == SCC_ERR_USAGE);
    /* Review C4 M1: a data key wraps and unwraps nothing; a KEK (local-wrap) wraps only a fresh db key. */
    uint32_t wk = 0, lk2 = 0;
    check("C4 M1 a data key never wraps a database key", scc_gcm_seal_key(data, dbk, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    check("C4 M1 a KEK only from a master key, for local-wrap", scc_hkdf_legacy_for(back2, zero, 0, "slate/v1/sync", 13, SCC_USE_KEK, &x) == SCC_ERR_USAGE &&
                                        scc_hkdf_legacy_for(sub, zero, 0, "slate/v1/local-wrap", 19, SCC_USE_KEK, &x) == SCC_ERR_USAGE &&
                                        scc_hkdf_legacy_for(back2, zero, 0, "slate/v1/local-wrap", 19, SCC_USE_KEK, &wk) == SCC_OK);
    check("C4 M1 a KEK wraps a fresh database key", scc_gcm_seal_key(wk, dbk, NULL, NULL, 0, ivo, ct) == SCC_OK);
    check("C4 M1 a KEK encrypts and opens no data", scc_gcm_seal(wk, NULL, NULL, 0, zero, 16, ivo, out) == SCC_ERR_USAGE && scc_gcm_open(wk, ivo, NULL, 0, ct, 48, out) == SCC_ERR_USAGE);
    check("C4 M1 a KEK unwraps a database key, never a master key", scc_gcm_open_key_for(wk, ivo, NULL, 0, ct, 48, SCC_USE_MASTER, &x) == SCC_ERR_USAGE &&
                                        scc_gcm_open_key_for(wk, ivo, NULL, 0, ct, 48, SCC_USE_DB, &lk2) == SCC_OK && scc_sqlcipher_raw_key(lk2, raw) == SCC_OK);
    check("C4 M1 an unwrapped key is never wrapped again", scc_gcm_seal_key(wk, lk2, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    check("C4 M1 a key that keyed a database is no longer fresh", scc_gcm_seal_key(wk, dbk, NULL, NULL, 0, ivo, ct) == SCC_OK &&
                                        scc_sqlcipher_raw_key(dbk, raw) == SCC_OK && scc_gcm_seal_key(wk, dbk, NULL, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    /* The IV the module draws lands in the AAD at the offset, and the result opens under exactly that AAD. */
    {
      unsigned char a2[40], ivx[12], ctx2[64], ptx[16];
      memset(a2, 0x33, sizeof a2);
      check("C4 gcmSealIvInAad", scc_gcm_seal_iv_in_aad(data, a2, sizeof a2, 21, seq, 16, ivx, ctx2) == SCC_OK);
      check("C4 gcmSealIvInAad refuses an IV past the AAD", scc_gcm_seal_iv_in_aad(data, a2, sizeof a2, 29, seq, 16, ivx, ctx2) == SCC_ERR_ARG);
      check("C4 the caller's AAD is not authenticated as given", scc_gcm_open(data, ivx, a2, sizeof a2, ctx2, 32, ptx) == SCC_ERR_AUTH);
      memcpy(a2 + 21, ivx, 12);
      check("C4 it opens with the module's IV in the AAD", scc_gcm_open(data, ivx, a2, sizeof a2, ctx2, 32, ptx) == SCC_OK && memcmp(ptx, seq, 16) == 0);
    }
    /* RFC 5869 from caller bytes (recovery and quick-unlock secrets): equal to HKDF over the same bytes as a key. */
    uint32_t hs = 0, hl = 0, imp = 0;
    unsigned char secret[32];
    memcpy(secret, seq, 32);
    check("C4 hkdfFromSecret", scc_hkdf_secret(secret, 32, (const unsigned char *)"salt", 4, "slate/v1/recovery", 17, &hs) == SCC_OK);
    scc_key_import(seq, 32, &imp);
    scc_hkdf_legacy(imp, (const unsigned char *)"salt", 4, "slate/v1/recovery", 17, &hl);
    check("C4 hkdfFromSecret equals HKDF-SHA-256 over the same bytes, and is a non-approved password-class key",
          memcmp(scc__slot_bytes_for_kat(hs), scc__slot_bytes_for_kat(hl), 32) == 0 && (hs >> 31) == 1 && scc_gcm_seal(hs, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE);
    /* C7: the typed recovery key of the bytes 00..1f, decoded in the module: its KEK_rc equals hkdfFromSecret's. */
    {
      const char *text = "000g 40r4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W";
      const char *typo = "000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6X";
      uint32_t rc1 = 0, kr = 0, ks = 0, bad1 = 0;
      memcpy(secret, seq, 32);
      check("C7 recoveryDecode of a known key", scc_recovery_decode((const unsigned char *)text, strlen(text), &rc1) == SCC_OK && scc_key_usage(rc1) == SCC_USE_RECOVERY);
      check("C7 KEK_rc from the handle equals HKDF over the key's bytes",
            scc_hkdf_recovery(rc1, (const unsigned char *)"salt", 4, "slate/v1/recovery", 17, &kr) == SCC_OK &&
            scc_hkdf_secret(secret, 32, (const unsigned char *)"salt", 4, "slate/v1/recovery", 17, &ks) == SCC_OK &&
            memcmp(scc__slot_bytes_for_kat(kr), scc__slot_bytes_for_kat(ks), 32) == 0 && scc_key_usage(kr) == SCC_USE_PASSWORD);
      check("C7 a checksum typo is refused", scc_recovery_decode((const unsigned char *)typo, strlen(typo), &bad1) == SCC_ERR_ARG);
      check("C7 a recovery handle is not a data key", scc_gcm_seal(rc1, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE);
      check("C7 hkdfFromRecovery takes only a recovery handle", scc_hkdf_recovery(ks, (const unsigned char *)"salt", 4, "slate/v1/recovery", 17, &bad1) == SCC_ERR_USAGE);
      /* C5 with C7: suite 0x02's KEK_rc from the decoded handle equals KBKDF over the key's bytes. */
      uint32_t kv2 = 0, ks2 = 0;
      check("C5 KEK_rc v2 from the recovery handle equals kbkdfFromSecret over its bytes",
            scc_kbkdf_recovery(rc1, "slate/v2/recovery", 17, vid, 16, 1, &kv2) == SCC_OK && scc_kbkdf_secret(seq, 32, "slate/v2/recovery", 17, vid, 16, 1, &ks2) == SCC_OK &&
            memcmp(scc__slot_bytes_for_kat(kv2), scc__slot_bytes_for_kat(ks2), 32) == 0 && scc_key_usage(kv2) == SCC_USE_PASSWORD);
      check("C5 kbkdfFromRecovery takes only a recovery handle", scc_kbkdf_recovery(ks, "slate/v2/recovery", 17, vid, 16, 1, &bad1) == SCC_ERR_USAGE);
      scc_key_destroy(kv2); scc_key_destroy(ks2);
      scc_key_destroy(rc1); scc_key_destroy(kr); scc_key_destroy(ks);
    }
    /* A real-cost matrix never fits the 1 MiB secure heap: the patched libcrypto (patchOpensslArgon2)
     * derives it in ordinary memory, wiped on free, and the secure heap is back where it was. */
    {
      uint32_t big1 = 0, big2 = 0;
      size_t heap_before = scc_secure_heap_used();
      check("C4 Argon2id with a 2 MiB matrix (larger than the secure heap)",
            scc_argon2id(seq, 8, s5a16, 16, 2048, 1, &big1) == SCC_OK && scc_argon2id(seq, 8, s5a16, 16, 2048, 1, &big2) == SCC_OK &&
                memcmp(scc__slot_bytes_for_kat(big1), scc__slot_bytes_for_kat(big2), 32) == 0);
      scc_key_destroy(big1);
      scc_key_destroy(big2);
      check("C4 the secure heap is back after a large Argon2id", scc_secure_heap_used() == heap_before);
    }
    /* Argon2id as a job (the addon runs it off the main thread): same key as the synchronous call. */
    uint32_t ja = 0;
    scc_argon2_job *job = NULL;
    check("C4 Argon2id job created", scc_argon2id_job_new((const unsigned char *)"slate-kat-password", 18, s5a16, 16, 32, 3, &job) == SCC_OK && job != NULL);
    check("C4 Argon2id job runs", scc_argon2id_job_run(job) == SCC_OK);
    check("C4 Argon2id job finishes into a handle", scc_argon2id_job_finish(job, &ja) == SCC_OK);
    scc_argon2id_job_free(job);
    expect_key("C4 Argon2id job", ja, "688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812");
    check("C4 Argon2id job key is password-class", scc_gcm_seal(ja, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE && (ja >> 31) == 1);
    check("C4 Argon2id job refuses bad cost before any work", scc_argon2id_job_new(seq, 8, s5a16, 16, 31, 1, &job) == SCC_ERR_ARG && job == NULL);
    size_t live0 = scc_live_handles();
    scc_argon2id_job_new(seq, 8, s5a16, 16, 32, 1, &job);
    scc_argon2id_job_run(job);
    scc_argon2id_job_free(job);
    check("C4 a dropped job leaves no handle", scc_live_handles() == live0);
    scc_zeroize_all();
  }

  /* C5: suite 0x02 primitives (audit §4.5, §4.6, Appendix A) and the closed C4 residual (review C4 M1-R). */
  {
    uint32_t m5 = 0, nenc = 0, nmac = 0, x = 0, rs = 0, master = 0, pwa = 0, pwb = 0, kk = 0, kk2 = 0;
    unsigned char name[32], back5[16], ivx[12], ctx5[64];
    const unsigned char page[16] = {0, 0, 0, 0, 0, 0, 0x20, 0, 0x80, 0, 0, 0, 0, 0, 0, 0x01};
    scc_key_import_for(seq, 32, SCC_USE_MASTER, &m5);
    scc_kbkdf(m5, "slate/v2/name-enc", 17, vid, 16, &nenc);
    scc_kbkdf(m5, "slate/v2/name-mac", 17, vid, 16, &nmac);
    expect_key("C5 KBKDF name-enc", nenc, "945f11ea9bf4b80dc2ca2f87255998fd341f56c6d9a6fb45a44aa067c1b3f589");
    expect_key("C5 KBKDF name-mac", nmac, "5ed3ac7f8024fae8e05db04c670e85169ccb2a046814a7cd455d78575be4f36e");
    check("C5 name SIV encode", scc_name_siv_encode(nenc, nmac, page, name) == SCC_OK);
    expect("C5 name, suite 0x02 (SIV || C)", name, 32, "50e291505985f76efa7aeb45620bd1b830101fd8c6a1b6030c339f4eee5ffe9c");
    check("C5 name SIV decode", scc_name_siv_decode(nenc, nmac, name, back5) == SCC_OK && memcmp(back5, page, 16) == 0);
    name[31] ^= 1;
    check("C5 a forged name fails the SIV, and no plaintext is released",
          scc_name_siv_decode(nenc, nmac, name, back5) == SCC_ERR_AUTH && memcmp(back5, zero, 16) == 0);
    name[31] ^= 1;
    name[0] ^= 0x80;
    check("C5 a changed SIV fails too", scc_name_siv_decode(nenc, nmac, name, back5) == SCC_ERR_AUTH);
    check("C5 the name keys must differ", scc_name_siv_encode(nenc, nenc, page, name) == SCC_ERR_ARG);
    check("C5 name keys are data keys", scc_name_siv_encode(m5, nmac, page, name) == SCC_ERR_USAGE && scc_name_siv_decode(nenc, m5, name, back5) == SCC_ERR_USAGE);
    /* KEK_rc and KEK_qu of suite 0x02: SP 800-108r1 over caller bytes, the same KDF as from a stored key. */
    check("C5 kbkdfFromSecret", scc_kbkdf_secret(seq, 32, "slate/v2/sync", 13, vid, 16, 1, &rs) == SCC_OK);
    expect_key("C5 kbkdfFromSecret equals the KBKDF vector", rs, "88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388");
    check("C5 kbkdfFromSecret gives a password-class key, approved only with the provider",
          scc_key_usage(rs) == SCC_USE_PASSWORD && (rs >> 31) == (uint32_t)!fips && scc_gcm_seal(rs, NULL, NULL, 0, zero, 16, ivo, ct) == SCC_ERR_USAGE);
    check("C5 kbkdfFromSecret refuses a secret under 128 bits", scc_kbkdf_secret(seq, 15, "slate/v2/x", 10, vid, 16, 1, &x) == SCC_ERR_ARG);
    check("C5 kbkdfFromSecret for a standard vault is non-approved", scc_kbkdf_secret(seq, 32, "slate/v2/x", 10, vid, 16, 0, &x) == SCC_OK && (x >> 31) == 1);
    /* Review C4 M1-R: rewrapKey moves password-class wraps only; no KEK-class move exists any more. */
    scc_key_random_for(SCC_USE_MASTER, &master);
    scc_kbkdf_secret(seq, 32, "slate/v2/recovery", 17, vid, 16, 1, &pwa);
    scc_pbkdf2((const unsigned char *)"slate-kat-password", 18, s5a32, 32, 1000, &pwb);
    scc_gcm_seal_key(pwa, master, NULL, NULL, 0, ivx, ctx5);
    check("C5 rewrap between password-class KEKs", scc_rewrap_key(pwa, ivx, NULL, 0, ctx5, 48, pwb, NULL, 0, ivo, ct) == SCC_OK);
    uint32_t wk1 = 0, wk2 = 0, dbk = 0, m6 = 0;
    scc_key_random_for(SCC_USE_MASTER, &m6);
    scc_kbkdf_for(m5, "slate/v2/local-wrap", 19, vid, 16, SCC_USE_KEK, &wk1);
    scc_kbkdf_for(m6, "evil/local-wrap", 15, vid, 16, SCC_USE_KEK, &wk2);
    scc_key_random_for(SCC_USE_DB, &dbk);
    scc_gcm_seal_key(wk1, dbk, NULL, NULL, 0, ivx, ctx5);
    check("C5 M1-R a KEK-class rewrap is refused (LK never leaves its master's tree)",
          scc_rewrap_key(wk1, ivx, NULL, 0, ctx5, 48, wk2, NULL, 0, ivo, ct) == SCC_ERR_USAGE);
    /* Review C5 L1: PBKDF2 as a job (off the main thread in the addon), same key as the synchronous call. */
    {
      scc_argon2_job *pj = NULL;
      uint32_t pk = 0;
      check("C5 L1 PBKDF2 job", scc_pbkdf2_job_new((const unsigned char *)"slate-kat-password", 18, s5a32, 32, 1000, &pj) == SCC_OK &&
                                    scc_argon2id_job_run(pj) == SCC_OK && scc_argon2id_job_finish(pj, &pk) == SCC_OK);
      scc_argon2id_job_free(pj);
      expect_key("C5 L1 PBKDF2 job key", pk, "13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079");
      check("C5 L1 PBKDF2 job refuses a count above 10^7", scc_pbkdf2_job_new(seq, 8, s5a32, 32, 10000001u, &pj) == SCC_ERR_ARG && pj == NULL);
    }
    /* PBKDF2 calibration for the fips-140-3 profile: about `target` ms, clamped to [600000, 10^7]. */
    uint64_t iters = 0;
    check("C5 PBKDF2 calibration lands in the profile's range", scc_pbkdf2_calibrate(1000, &iters) == SCC_OK && iters >= 600000u && iters <= 10000000u);
    check("C5 PBKDF2 calibration refuses a target outside 100..10000 ms", scc_pbkdf2_calibrate(99, &iters) == SCC_ERR_ARG && scc_pbkdf2_calibrate(10001, &iters) == SCC_ERR_ARG);
    (void)kk;
    (void)kk2;
    scc_zeroize_all();
  }

  /* C9 (audit §4.5.2, §4.7 R-1): MK of an earlier epoch in `history`, wrapped under
   * K_hist,e = KBKDF(MK_current, "slate/v2/history", vid || uint32be(e)), which never becomes a handle. The key that
   * moves into history comes out of a proof (its wrap under a password-class KEK that opens it), as for rewrapKey. */
  {
    uint32_t cur = 0, old = 0, pw = 0, pw2 = 0, h = 0, h2 = 0, kh = 0, mnew = 0, d = 0, arg = 0, x = 0;
    unsigned char hctx[20], hctx2[20], piv[12], pct[48], eiv[12], ect[48], riv[12], rct[48], fixed[48];
    const unsigned char haad[] = "slate-vault/v2|history|7";
    memcpy(hctx, vid, 16);
    hctx[16] = 0, hctx[17] = 0, hctx[18] = 0, hctx[19] = 7;
    memcpy(hctx2, hctx, 20);
    hctx2[19] = 8;
    /* Known answer: an entry sealed under the reference K_hist (stdlib HMAC-SHA-256 SP 800-108r1, Appendix A
     * construction) opens with history_open from MK = 00..1f, so the module derives exactly that key. */
    unsigned char khist[32];
    const char *kh_hex = "cfb649012ab676777a9777c8cbfa091b150d67ccc5506ac88163acabca0be417";
    for (int i = 0; i < 32; i++) sscanf(kh_hex + 2 * i, "%2hhx", &khist[i]);
    scc_key_import_for(seq, 32, SCC_USE_MASTER, &cur);
    scc_key_import_for(khist, 32, SCC_USE_DATA, &kh);
    scc_key_random_for(SCC_USE_MASTER, &old);
    unsigned char oldb[32];
    memcpy(oldb, scc__slot_bytes_for_kat(old), 32);
    check("C9 an entry sealed under the reference K_hist", scc_gcm_seal(kh, iv0, haad, sizeof haad - 1, oldb, 32, eiv, fixed) == SCC_OK);
    check("C9 history_open derives K_hist,e = KBKDF(MK, \"slate/v2/history\", vid || uint32be(e))",
          scc_history_open(cur, hctx, 20, iv0, haad, sizeof haad - 1, fixed, 48, &h) == SCC_OK && memcmp(scc__slot_bytes_for_kat(h), oldb, 32) == 0);
    check("C9 an opened history key is a master key, never fresh (it can be used, not wrapped again)",
          scc_key_usage(h) == SCC_USE_MASTER && scc_kbkdf_secret(seq, 32, "slate/v2/recovery", 17, vid, 16, 1, &pw) == SCC_OK &&
              scc_gcm_seal_key(pw, h, NULL, NULL, 0, piv, pct) == SCC_ERR_USAGE);
    check("C9 another epoch's context does not open it", scc_history_open(cur, hctx2, 20, iv0, haad, sizeof haad - 1, fixed, 48, &x) == SCC_ERR_AUTH);
    check("C9 nor does another AAD", scc_history_open(cur, hctx, 20, iv0, haad, 4, fixed, 48, &x) == SCC_ERR_AUTH);
    check("C9 history_open takes a master key only", scc_history_open(kh, hctx, 20, iv0, haad, sizeof haad - 1, fixed, 48, &x) == SCC_ERR_USAGE);
    /* Review C9 M1: the public KDFs never reach a module-internal key. K_hist's label is reserved, and a local-wrap
     * label yields only a KEK (which opens database keys inside the module, never a data key that hands them out). */
    check("C9 M1 kbkdf refuses the history label", scc_kbkdf(cur, "slate/v2/history", 16, hctx, 20, &x) == SCC_ERR_USAGE &&
                                                     scc_kbkdf_for(cur, "slate/v2/history", 16, hctx, 20, SCC_USE_KEK, &x) == SCC_ERR_USAGE);
    check("C9 M1 kbkdfFromSecret refuses the history label", scc_kbkdf_secret(seq, 32, "slate/v2/history", 16, hctx, 20, 1, &x) == SCC_ERR_USAGE);
    check("C9 M1 a local-wrap label never gives a data key", scc_kbkdf(cur, "slate/v2/local-wrap", 19, vid, 16, &x) == SCC_ERR_USAGE &&
                                                               scc_hkdf_legacy(cur, zero, 0, "slate/v1/local-wrap", 19, &x) == SCC_ERR_USAGE);
    check("C9 M1 the history label is refused by the legacy KDF too", scc_hkdf_legacy_for(cur, zero, 0, "slate/v2/history", 16, SCC_USE_DATA, &x) == SCC_ERR_USAGE);
    scc_zeroize_all();

    /* Round trip: MK_e moves from its password wrap (the proof) into the history of a new master key. */
    scc_key_random_for(SCC_USE_MASTER, &old);
    memcpy(oldb, scc__slot_bytes_for_kat(old), 32);
    scc_kbkdf_secret(seq, 32, "slate/v2/recovery", 17, vid, 16, 1, &pw);
    scc_gcm_seal_key(pw, old, NULL, NULL, 0, piv, pct);
    scc_key_random_for(SCC_USE_MASTER, &mnew);
    check("C9 history_seal from a proof", scc_history_seal(pw, piv, NULL, 0, pct, 48, mnew, hctx, 20, haad, sizeof haad - 1, eiv, ect) == SCC_OK);
    check("C9 history_seal round trip", scc_history_open(mnew, hctx, 20, eiv, haad, sizeof haad - 1, ect, 48, &h) == SCC_OK &&
                                            memcmp(scc__slot_bytes_for_kat(h), oldb, 32) == 0);
    check("C9 a proof that does not open is refused", (pct[0] ^= 1, scc_history_seal(pw, piv, NULL, 0, pct, 48, mnew, hctx, 20, haad, 4, riv, rct) == SCC_ERR_AUTH));
    pct[0] ^= 1;
    scc_key_random(&d);
    check("C9 the proof's KEK must be password class", scc_history_seal(d, piv, NULL, 0, pct, 48, mnew, hctx, 20, haad, 4, riv, rct) == SCC_ERR_USAGE);
    check("C9 the new key must be a master key", scc_history_seal(pw, piv, NULL, 0, pct, 48, d, hctx, 20, haad, 4, riv, rct) == SCC_ERR_USAGE);
    /* The new master key is the one the proof opens: an entry for the current epoch is refused. */
    scc_gcm_open_key(pw, piv, NULL, 0, pct, 48, &arg);
    check("C9 a key is never sealed into its own history", scc_history_seal(pw, piv, NULL, 0, pct, 48, arg, hctx, 20, haad, 4, riv, rct) == SCC_ERR_ARG);
    check("C9 a context of the wrong size is refused", scc_history_seal(pw, piv, NULL, 0, pct, 48, mnew, hctx, 16, haad, 4, riv, rct) == SCC_ERR_ARG);

    /* Rewrap at the next rotation: the entry under MK_cur's K_hist moves under MK_next's, MK_cur shown by its proof. */
    uint32_t nxt = 0;
    scc_kbkdf_secret(zero, 32, "slate/v2/recovery", 17, vid, 16, 1, &pw2);
    unsigned char ciw[12], cct[48];
    uint32_t cur2 = 0;
    scc_key_random_for(SCC_USE_MASTER, &cur2);
    scc_gcm_seal_key(pw2, cur2, NULL, NULL, 0, ciw, cct);
    scc_history_seal(pw, piv, NULL, 0, pct, 48, cur2, hctx, 20, haad, sizeof haad - 1, eiv, ect);
    scc_key_random_for(SCC_USE_MASTER, &nxt);
    check("C9 history_rewrap", scc_history_rewrap(pw2, ciw, NULL, 0, cct, 48, hctx, 20, eiv, haad, sizeof haad - 1, ect, 48, nxt, hctx, 20, haad, sizeof haad - 1, riv, rct) == SCC_OK);
    check("C9 history_rewrap round trip", scc_history_open(nxt, hctx, 20, riv, haad, sizeof haad - 1, rct, 48, &h2) == SCC_OK &&
                                              memcmp(scc__slot_bytes_for_kat(h2), oldb, 32) == 0);
    check("C9 history_rewrap needs the proof of the key the entry is under",
          scc_history_rewrap(pw, piv, NULL, 0, pct, 48, hctx, 20, eiv, haad, sizeof haad - 1, ect, 48, nxt, hctx, 20, haad, 4, riv, rct) == SCC_ERR_AUTH);
    /* Approval (review C4 M1): a key from a non-approved KEK never lands under an approved K_hist. */
    if (fips) {
      uint32_t apw = 0, am = 0, an = 0;
      unsigned char aiv[12], act[48];
      scc_argon2id(seq, 8, s5a16, 16, 32, 1, &apw);
      scc_key_random_for(SCC_USE_MASTER, &am);
      scc_gcm_seal_key(apw, am, NULL, NULL, 0, aiv, act);
      scc_key_random_for(SCC_USE_MASTER, &an);
      check("C9 a non-approved key is not sealed under an approved K_hist",
            scc_history_seal(apw, aiv, NULL, 0, act, 48, an, hctx, 20, haad, 4, riv, rct) == SCC_ERR_NOT_APPROVED);
    }
    scc_zeroize_all();
  }

  /* T-ZERO-03: six imported keys, zeroize_all, and the secure heap is back to its baseline. */
  size_t heap0 = scc_secure_heap_used();
  uint32_t six[6];
  for (int i = 0; i < 6; i++) scc_key_import(seq, 32, &six[i]);
  check("T-ZERO-03 six keys live in the secure heap", scc_live_handles() == 6 && scc_secure_heap_used() > heap0);
  check("T-ZERO-03 zeroize_all = 6, live = 0, heap at baseline", scc_zeroize_all() == 6 && scc_live_handles() == 0 && scc_secure_heap_used() == heap0);
  check("handle of a zeroized key refused", scc_hmac_sha256(six[0], seq, 32, out) == SCC_ERR_HANDLE);
  /* N8: non-approved functions (Argon2id, legacy HKDF) give handles in their own namespace (bit 31),
   * and keys derived from them stay there. */
  uint32_t na = 0, nd = 0, nr = 0;
  uint32_t nm0 = 0, nm = 0;
  scc_argon2id(seq, 8, s5a16, 16, 32, 1, &na);
  /* C4: a password KEK derives nothing itself; the master key it unwraps inherits its namespace. */
  scc_key_random_for(SCC_USE_MASTER, &nm0);
  scc_gcm_seal_key(na, nm0, NULL, NULL, 0, ivo, ct);
  scc_gcm_open_key(na, ivo, NULL, 0, ct, 48, &nm);
  scc_kbkdf(nm, "slate/v2/sync", 13, vid, 16, &nd);
  scc_key_random(&nr);
  check("N8 Argon2id and keys derived from it are non-approved", (na >> 31) == 1 && (nd >> 31) == 1);
  check("N8 a module-random key is approved only with the FIPS provider", (nr >> 31) == (uint32_t)!fips);
  check("N8 the namespace bit is part of the handle", scc_key_destroy(na ^ 0x80000000u) == SCC_ERR_HANDLE);
  scc_zeroize_all();

  /* T-PQ-A1-06: ML-DSA verification (FIPS 204 pure, with a context string) and the PQ inventory. */
  static mldsa_bytes_t mb, m87;
  {
    char inv[128];
    check("T-PQ-A1-06 inventory lists ML-DSA-65 and ML-KEM-768", scc_pq_algorithms(inv, sizeof inv) == SCC_OK && strstr(inv, "ML-DSA-65") != NULL &&
                                                                  strstr(inv, "ML-KEM-768") != NULL && strstr(inv, "ML-DSA-87") != NULL);
    printf("     pq: %s\n", inv);
    check("T-PQ-A1-06 no PQ algorithm inside the FIPS boundary (provider 3.1.2, or none)", scc_pq_in_fips_boundary() == 0);
    check("T-PQ-A1-06 a too-small inventory buffer is refused", scc_pq_algorithms(inv, 12) == SCC_ERR_ARG && inv[0] == '\0');
    for (size_t i = 0; i < sizeof MLDSA_SIGVER / sizeof MLDSA_SIGVER[0]; i++) {
      const mldsa_sigver_t *v = &MLDSA_SIGVER[i];
      char name[96];
      snprintf(name, sizeof name, "T-PQ-A1-06 ACVP ML-DSA-%d tcId %d %s", v->level, v->tc_id, v->passed ? "verifies" : "fails (SCC_11)");
      mldsa_bytes(v, &mb);
      check(name, mldsa_verify(v->level, &mb) == (v->passed ? SCC_OK : SCC_ERR_AUTH));
    }
    mldsa_bytes(&MLDSA_SIGVER[2], &m87);
    mldsa_bytes(&MLDSA_SIGVER[0], &mb);
    mb.sig[100] ^= 0x01;
    check("T-PQ-A1-06 one flipped signature bit fails (SCC_11)", mldsa_verify(65, &mb) == SCC_ERR_AUTH);
    mb.sig[100] ^= 0x01;
    mb.ctx[0] ^= 0x80;
    check("T-PQ-A1-06 another context string fails (SCC_11)", mldsa_verify(65, &mb) == SCC_ERR_AUTH);
    mb.ctx[0] ^= 0x80;
    check("T-PQ-A1-06 the vector still verifies after the edits are undone", mldsa_verify(65, &mb) == SCC_OK);
    check("T-PQ-A1-06 levels other than 65 and 87 are refused", mldsa_verify(44, &mb) == SCC_ERR_ARG && mldsa_verify(0, &mb) == SCC_ERR_ARG);
    check("T-PQ-A1-06 an ML-DSA-65 key at level 87 is refused", scc_mldsa_verify(87, mb.spki, mb.spki_len, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, m87.sig, m87.sig_len) == SCC_ERR_ARG);
    mb.spki[16] = 0x11; /* id-ml-dsa-44 */
    check("T-PQ-A1-06 another OID is refused", mldsa_verify(65, &mb) == SCC_ERR_ARG);
    mb.spki[16] = 0x12;
    check("T-PQ-A1-06 a truncated or extended SPKI is refused",
          scc_mldsa_verify(65, mb.spki, mb.spki_len - 1, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len) == SCC_ERR_ARG &&
          scc_mldsa_verify(65, mb.spki, mb.spki_len + 1, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len) == SCC_ERR_ARG &&
          scc_mldsa_verify(65, NULL, 0, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len) == SCC_ERR_ARG);
    check("T-PQ-A1-06 an empty, short or long signature is refused",
          scc_mldsa_verify(65, mb.spki, mb.spki_len, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, NULL, 0) == SCC_ERR_ARG &&
          scc_mldsa_verify(65, mb.spki, mb.spki_len, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len - 1) == SCC_ERR_ARG &&
          scc_mldsa_verify(65, mb.spki, mb.spki_len, mb.msg, mb.msg_len, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len + 1) == SCC_ERR_ARG);
    check("T-PQ-A1-06 a context over 255 bytes is refused", scc_mldsa_verify(65, mb.spki, mb.spki_len, mb.msg, mb.msg_len, mb.ctx, 256, mb.sig, mb.sig_len) == SCC_ERR_ARG);
    check("T-PQ-A1-06 a message over the input cap is refused before any work",
          scc_mldsa_verify(65, mb.spki, mb.spki_len, mb.msg, SCC_MAX_INPUT + 1, mb.ctx, mb.ctx_len, mb.sig, mb.sig_len) == SCC_ERR_TOO_LARGE);
    check("T-PQ-A1-06 an empty message with a valid key and signature fails (SCC_11), never crashes",
          scc_mldsa_verify(65, mb.spki, mb.spki_len, NULL, 0, NULL, 0, mb.sig, mb.sig_len) == SCC_ERR_AUTH);
  }

  /* C5 criterion 2: once a fips-140-3 vault latches approved-only, no non-approved service runs at all. */
  {
    uint32_t lm = 0, ld = 0, x = 0;
    unsigned char sec[32], o16[16];
    scc_argon2_job *job = NULL;
    memcpy(sec, seq, 32);
    scc_key_random_for(SCC_USE_MASTER, &lm);
    scc_key_random(&ld);
    check("C5 the latch", scc_require_approved_keys() == SCC_OK && scc_approved_keys_required() == 1);
    check("C5 latched: hkdfLegacy refused", scc_hkdf_legacy(lm, zero, 0, "slate/v1/sync", 13, &x) == SCC_ERR_NOT_APPROVED);
    check("C5 latched: hkdfFromSecret refused", scc_hkdf_secret(sec, 32, NULL, 0, "slate/v1/quick", 14, &x) == SCC_ERR_NOT_APPROVED);
    check("C5 latched: Argon2id refused", scc_argon2id(seq, 8, s5a16, 16, 32, 1, &x) == SCC_ERR_NOT_APPROVED);
    check("C5 latched: an Argon2id job is refused", scc_argon2id_job_new(seq, 8, s5a16, 16, 32, 1, &job) == SCC_ERR_NOT_APPROVED && job == NULL);
    check("C5 latched: AES-ECB (suite 0x01 names) refused", scc_aes_ecb_block(ld, seq, 1, o16) == SCC_ERR_NOT_APPROVED);
    check("C5 latched: KBKDF and PBKDF2 still run", scc_kbkdf(lm, "slate/v2/sync", 13, vid, 16, &x) == SCC_OK &&
                                                     scc_pbkdf2(seq, 8, s5a32, 32, 1000, &x) == SCC_OK);
    check("T-PQ-A1-06 latched: ML-DSA verification (public data, no key) still runs", mldsa_verify(65, &mb) == SCC_OK && scc_approved_keys_required() == 1);
    scc_zeroize_all();
  }

  /* Notes: a slot whose generation is used up is retired, never wrapped; when all are, keyRandom fails. */
  uint32_t g1 = 0, g2 = 0;
  scc__set_generation_for_kat(0, 0x7ffffeu);
  check("a slot's last generation is still issued", scc_key_random(&g1) == SCC_OK && (g1 & 0xffu) == 0);
  scc_key_destroy(g1);
  check("then the slot is retired, not wrapped", scc_key_random(&g2) == SCC_OK && (g2 & 0xffu) != 0 && g2 != g1);
  scc_zeroize_all();
  for (uint32_t i = 0; i < 64; i++) scc__set_generation_for_kat(i, 0x7fffffu);
  check("handle exhaustion is an error, never a reused handle", scc_key_random(&g2) == SCC_ERR_HANDLES);

  /* C6 (audit S-1, S-2): the power-up self-test gate. Once the app gates the module, every service
   * refuses until a self-test session has passed; only the self-test's own session may use them before. */
  {
    uint32_t gh = 0;
    check("C6 ungated: services run without a self-test", scc_post_passed() == 1 && scc_random(out, 4) == SCC_OK);
    check("C6 ending a session that was never begun is refused", scc_post_end(1) == SCC_ERR_STATE);
    scc_post_gate();
    check("C6 gated: no service runs before the POST passed", scc_post_passed() == 0 && scc_random(out, 4) == SCC_ERR_STATE &&
                                                               scc_key_random(&gh) == SCC_ERR_STATE && scc_sha256(seq, 3, out) == SCC_ERR_STATE);
    check("C6 a self-test session may use the services", scc_post_begin() == SCC_OK && scc_random(out, 4) == SCC_OK);
    check("C6 a passed self-test opens them for the process", scc_post_end(1) == SCC_OK && scc_post_passed() == 1 && scc_random(out, 4) == SCC_OK);
    check("C6 a later (on-demand) session leaves them open", scc_post_begin() == SCC_OK && scc_post_end(1) == SCC_OK && scc_random(out, 4) == SCC_OK);
  }

  /* L4: the provider's own error state (a failed conditional self-test after load) is the module's. */
  check("L4 a healthy provider is not in the error state", scc_in_error_state() == 0 && scc_random(out, 4) == SCC_OK);
  scc__force_provider_error_for_kat();
  check("L4 a provider reporting an error latches the error state", scc_in_error_state() == 1 && scc_fips_active() == 0);
  check("L4 services then refuse with SCC_12", scc_random(out, 4) == SCC_ERR_ERROR_STATE);
  scc_enter_error_state();
  uint32_t h = 0;
  check("error state refuses keyRandom", scc_key_random(&h) == SCC_ERR_ERROR_STATE);
  check("error state refuses sha256", scc_sha256((const unsigned char *)"abc", 3, out) == SCC_ERR_ERROR_STATE);
  check("T-PQ-A1-06 error state refuses ML-DSA verification", mldsa_verify(65, &mb) == SCC_ERR_ERROR_STATE);
  check("error state refuses keyImport", scc_key_import(seq, 32, &h) == SCC_ERR_ERROR_STATE);
  check("error state refuses kbkdf", scc_kbkdf(h, "x", 1, vid, 16, &h) == SCC_ERR_ERROR_STATE);
  check("error state refuses pbkdf2", scc_pbkdf2(seq, 8, s5a32, 32, 1000, &h) == SCC_ERR_ERROR_STATE);
  check("error state refuses random", scc_random(out, 16) == SCC_ERR_ERROR_STATE);
  check("error state refuses gcmOpenKey", scc_gcm_open_key(kek, ivo, NULL, 0, ct, 48, &h) == SCC_ERR_ERROR_STATE);
  check("error state refuses gcmSealKey", scc_gcm_seal_key(kek, wrapped, NULL, NULL, 0, ivo, ct) == SCC_ERR_ERROR_STATE);
  check("error state refuses sqlcipher raw key", scc_sqlcipher_raw_key(kek, raw) == SCC_ERR_ERROR_STATE);
  check("error state is sticky and reported", scc_in_error_state() == 1 && scc_fips_active() == 0);
  check("C6 no self-test session opens in the error state", scc_post_begin() == SCC_ERR_ERROR_STATE && scc_random(out, 4) == SCC_ERR_ERROR_STATE);
  printf("%s: %d failure(s)\n", fails ? "FAILED" : "OK", fails);
  return fails != 0;
}

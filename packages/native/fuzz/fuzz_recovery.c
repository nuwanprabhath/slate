/* scc_recovery_decode over arbitrary text (C7: the typed recovery key is decoded in the module).
 * Oracles: only SCC_OK or SCC_ERR_ARG; no read past `len` (the input is an exactly sized heap copy, so
 * ASan traps the separator lookahead running one byte over); a text that decodes, written again by this
 * file's own base32 writer and decoded, gives a key whose scc_hkdf_recovery output is the same; no
 * handle outlives the input. */
#include "harness.h"

static const char ALPHABET[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
static size_t g_live0;

int LLVMFuzzerInitialize(int *argc, char ***argv) {
  fuzz_init(*argc, *argv);
  g_live0 = scc_live_handles();
  return 0;
}

/* 52 characters for the 256 key bits and 4 zero bits, then 4 for SHA-256(key)'s first 20 bits, with a
 * dash every 4 characters as vault/recovery.ts writes it. Independent of the module's decoder. */
static size_t encode(const unsigned char key[32], char out[70]) {
  char digits[56];
  size_t n = 0;
  uint32_t acc = 0;
  unsigned bits = 0;
  for (size_t i = 0; i < 32; i++) {
    acc = (acc << 8) | key[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      digits[n++] = ALPHABET[(acc >> bits) & 31u];
    }
  }
  digits[n++] = ALPHABET[(acc << (5 - bits)) & 31u]; /* 256 = 51*5 + 1: one bit and four zero bits */
  unsigned char d[32];
  FUZZ_CHECK(scc_sha256(key, 32, d) == SCC_OK, "sha256 for the check characters");
  uint32_t check = ((uint32_t)d[0] << 12) | ((uint32_t)d[1] << 4) | ((uint32_t)d[2] >> 4);
  for (unsigned i = 0; i < 4; i++) digits[n++] = ALPHABET[(check >> (15u - 5u * i)) & 31u];
  FUZZ_CHECK(n == 56, "encoder wrote 56 characters");
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    if (i > 0 && i % 4 == 0) out[o++] = '-';
    out[o++] = digits[i];
  }
  return o;
}

static void derive(uint32_t h, unsigned char out[32]) {
  static const unsigned char salt[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
  static const char info[] = "slate-fuzz/recovery";
  uint32_t kek = 0;
  FUZZ_CHECK(scc_hkdf_recovery(h, salt, sizeof salt, info, sizeof info - 1, &kek) == SCC_OK, "hkdf_recovery of a decoded key");
  unsigned char *b = scc__slot_bytes_for_kat(kek);
  FUZZ_CHECK(b != NULL, "hkdf_recovery handle is live");
  memcpy(out, b, 32);
  FUZZ_CHECK(scc_key_destroy(kek) == SCC_OK, "destroy derived KEK");
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  unsigned char *text = fuzz_dup(data, size);
  uint32_t h = 0;
  int rc = scc_recovery_decode(text, size, &h);
  free(text);
  FUZZ_CHECK(rc == SCC_OK || rc == SCC_ERR_ARG, "recovery_decode returns only OK or ARG");
  if (rc == SCC_OK) {
    FUZZ_CHECK(scc_key_usage(h) == SCC_USE_RECOVERY, "a decoded key is a RECOVERY key");
    unsigned char *kb = scc__slot_bytes_for_kat(h), key[32];
    FUZZ_CHECK(kb != NULL, "decoded handle is live");
    memcpy(key, kb, 32);
    char again[70];
    size_t n = encode(key, again);
    unsigned char *copy = fuzz_dup((const uint8_t *)again, n);
    uint32_t h2 = 0;
    FUZZ_CHECK(scc_recovery_decode(copy, n, &h2) == SCC_OK, "re-encoded text decodes");
    free(copy);
    unsigned char *kb2 = scc__slot_bytes_for_kat(h2);
    FUZZ_CHECK(kb2 != NULL && memcmp(kb2, key, 32) == 0, "re-encoded text decodes to the same key");
    if (scc_approved_keys_required()) {
      /* fuzz.mjs --fips: RFC 5869 HKDF (suite 0x01) is refused in a fips-140-3 vault. */
      uint32_t kek = 0;
      static const char info[] = "slate-fuzz/recovery";
      FUZZ_CHECK(scc_hkdf_recovery(h, NULL, 0, info, sizeof info - 1, &kek) == SCC_ERR_NOT_APPROVED, "hkdf_recovery refused once approved-only");
    } else {
      unsigned char a[32], b[32];
      derive(h, a);
      derive(h2, b);
      FUZZ_CHECK(memcmp(a, b, 32) == 0, "re-encoded key derives the same KEK");
    }
    FUZZ_CHECK(scc_key_destroy(h) == SCC_OK && scc_key_destroy(h2) == SCC_OK, "destroy decoded keys");
  }
  FUZZ_CHECK(scc_live_handles() == g_live0, "no handle outlives the input");
  return 0;
}

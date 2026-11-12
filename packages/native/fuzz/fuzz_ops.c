/* A byte-coded program over the handle table: create, destroy, derive (KBKDF, legacy HKDF), HMAC, AES-CTR,
 * remote names (SIV encode/decode), the SQLCipher key text and zeroize_all, each called with a live,
 * destroyed, stale-generation, wrong-approval-bit or out-of-range handle, and labels of 0, 1, 128 and 129
 * bytes with and without a NUL.
 * Oracles: a handle that is not live always gives SCC_ERR_HANDLE (when the call's other arguments are
 * valid); scc_live_handles() equals this file's own count after every step; after scc_key_destroy the 32
 * bytes the handle named are zero; after scc_zeroize_all the count is 0 and scc_secure_heap_used() is back
 * at its baseline; scc_name_siv_decode(scc_name_siv_encode(p)) == p, and a changed name gives SCC_ERR_AUTH
 * with a zeroed output; every return code is an SCC_* code. */
#include "harness.h"

#define MAX_LIVE 64
#define MAX_DEAD 256
static uint32_t g_live[MAX_LIVE], g_dead[MAX_DEAD];
static size_t g_nlive, g_ndead, g_heap0;

int LLVMFuzzerInitialize(int *argc, char ***argv) {
  fuzz_init(*argc, *argv);
  FUZZ_CHECK(scc_live_handles() == 0, "no handle before the first input");
  /* The private DRBG keeps its state in the secure heap from its first use on; the baseline is after it. */
  uint32_t warm = 0;
  FUZZ_CHECK(scc_key_random_for(SCC_USE_DATA, &warm) == SCC_OK && scc_key_destroy(warm) == SCC_OK, "warm the DRBG");
  g_heap0 = scc_secure_heap_used();
  return 0;
}

static int is_live(uint32_t h) {
  for (size_t i = 0; i < g_nlive; i++)
    if (g_live[i] == h) return 1;
  return 0;
}

static void add_live(uint32_t h) {
  FUZZ_CHECK(g_nlive < MAX_LIVE && !is_live(h), "a new handle is new");
  g_live[g_nlive++] = h;
}

static void kill(uint32_t h) {
  for (size_t i = 0; i < g_nlive; i++)
    if (g_live[i] == h) {
      g_live[i] = g_live[--g_nlive];
      break;
    }
  g_dead[g_ndead++ % MAX_DEAD] = h;
}

/* Which handle a step names: one of the five classes, chosen by the input. */
static uint32_t pick(uint8_t c, uint8_t idx) {
  size_t nd = g_ndead < MAX_DEAD ? g_ndead : MAX_DEAD;
  switch (c % 5) {
    case 0:
      if (g_nlive > 0) return g_live[idx % g_nlive];
      break;
    case 1:
      if (nd > 0) return g_dead[idx % nd];
      break;
    case 2:
      if (g_nlive > 0) return g_live[idx % g_nlive] ^ ((uint32_t)(1 + idx % 3) << 8); /* another generation */
      break;
    case 3:
      if (g_nlive > 0) return g_live[idx % g_nlive] ^ 0x80000000u;                     /* the other namespace */
      break;
    default:
      break;
  }
  return ((uint32_t)idx << 8) | (64u + (uint32_t)(c % 192)); /* slot 64..255: out of range */
}

static int usage_of(uint8_t b) { return (int)(b % 8) - 1; }

/* Labels of 0, 1, 128 and 129 bytes, one with a NUL, or the input's own bytes. */
static size_t label(uint8_t v, const uint8_t **data, size_t *len, char out[160]) {
  size_t n;
  switch (v % 6) {
    case 0: n = 0; break;
    case 1: n = 1; break;
    case 2: n = 128; break;
    case 3: n = 129; break;
    case 4: n = 6; break;
    default: {
      size_t m = 0;
      const uint8_t *p = take_field(data, len, 129, &m);
      if (m > 0) memcpy(out, p, m);
      return m;
    }
  }
  memset(out, 'L', n);
  if (v % 6 == 4) out[3] = '\0';
  return n;
}

static int label_valid(const char *l, size_t n) { return n >= 1 && n <= SCC_MAX_LABEL && memchr(l, '\0', n) == NULL; }

static void expect_not_live(int rc, uint32_t h) {
  if (!is_live(h)) FUZZ_CHECK(rc == SCC_ERR_HANDLE, "a stale handle named a live key");
}

static void step(const uint8_t **data, size_t *len) {
  uint8_t op = take_u8(data, len), a = take_u8(data, len), b = take_u8(data, len);
  uint32_t h = pick(a, b);
  int rc = SCC_OK;
  switch (op % 9) {
    case 0: {
      int usage = usage_of(b);
      uint32_t out = 0;
      rc = scc_key_random_for(usage, &out);
      int creatable = usage == SCC_USE_DATA || usage == SCC_USE_MASTER || usage == SCC_USE_DB || usage == SCC_USE_KEK;
      if (!creatable) FUZZ_CHECK(rc == SCC_ERR_ARG, "random_for refuses a class it cannot create");
      if (rc == SCC_OK) add_live(out);
      break;
    }
    case 1: {
      int live = is_live(h);
      unsigned char *at = live ? scc__slot_bytes_for_kat(h) : NULL, was[32];
      if (live) FUZZ_CHECK(at != NULL, "a live handle has bytes");
      if (live) memcpy(was, at, 32);
      rc = scc_key_destroy(h);
      if (live) {
        FUZZ_CHECK(rc == SCC_OK, "destroy a live key");
        /* OpenSSL's secure heap keeps its free-list links (two pointers) in the first 16 bytes of a freed
         * block, so those are not zero; neither of them may still be the key's bytes. */
        FUZZ_CHECK(fuzz_all_bytes(at + 16, 16, 0), "a destroyed key's bytes are zero");
        FUZZ_CHECK(memcmp(at, was, 8) != 0 && memcmp(at + 8, was + 8, 8) != 0, "a destroyed key's bytes are zero");
        kill(h);
      } else {
        expect_not_live(rc, h);
      }
      break;
    }
    case 2:
    case 3: {
      char l[160];
      size_t n = label(take_u8(data, len), data, len, l), ctx_len = 0;
      const uint8_t *ctx = take_field(data, len, 64, &ctx_len);
      int usage = usage_of(take_u8(data, len));
      uint32_t out = 0;
      rc = op % 9 == 2 ? scc_kbkdf_for(h, l, n, ctx, ctx_len, usage, &out) : scc_hkdf_legacy_for(h, ctx, ctx_len, l, n, usage, &out);
      /* A fips-140-3 vault (fuzz.mjs --fips) refuses RFC 5869 HKDF before it looks at anything else. */
      if (op % 9 == 3 && scc_approved_keys_required()) FUZZ_CHECK(rc == SCC_ERR_NOT_APPROVED, "legacy HKDF refused once approved-only");
      else if (!label_valid(l, n)) FUZZ_CHECK(rc == SCC_ERR_ARG, "a bad label is refused");
      else expect_not_live(rc, h);
      if (rc == SCC_OK) {
        FUZZ_CHECK(usage == SCC_USE_DATA || usage == SCC_USE_KEK, "a KDF gives a DATA or KEK key");
        FUZZ_CHECK(scc_key_usage(out) == usage, "the derived key has the usage asked for");
        add_live(out);
      }
      break;
    }
    case 4: {
      size_t n = 0;
      const uint8_t *p = take_field(data, len, 255, &n);
      unsigned char *in = fuzz_dup(p, n), mac[32];
      rc = scc_hmac_sha256(h, in, n, mac);
      free(in);
      expect_not_live(rc, h);
      break;
    }
    case 5: {
      size_t n = 0;
      const uint8_t *icb = take(data, len, 16), *p = take_field(data, len, 255, &n);
      if (icb == NULL) return;
      unsigned char *in = fuzz_dup(p, n), *ct = malloc(n), *back = malloc(n);
      FUZZ_CHECK(n == 0 || (ct != NULL && back != NULL), "malloc");
      rc = scc_aes_ctr(h, icb, in, n, ct);
      expect_not_live(rc, h);
      if (rc == SCC_OK) {
        FUZZ_CHECK(scc_aes_ctr(h, icb, ct, n, back) == SCC_OK && (n == 0 || memcmp(back, in, n) == 0), "CTR twice is the identity");
      }
      free(in);
      free(ct);
      free(back);
      break;
    }
    case 6: {
      uint32_t mac = pick(take_u8(data, len), take_u8(data, len));
      const uint8_t *p = take(data, len, 16);
      uint8_t at = take_u8(data, len), mask = take_u8(data, len);
      if (p == NULL) return;
      unsigned char name[32], back[16];
      rc = scc_name_siv_encode(h, mac, p, name);
      /* `enc` is checked first: an enc key of another usage is SCC_ERR_USAGE before `mac` is looked at. */
      if (!is_live(h) || (scc_key_usage(h) == SCC_USE_DATA && !is_live(mac))) FUZZ_CHECK(rc == SCC_ERR_HANDLE, "a stale handle named a live key");
      if (rc == SCC_OK) {
        FUZZ_CHECK(scc_name_siv_decode(h, mac, name, back) == SCC_OK && memcmp(back, p, 16) == 0, "decode(encode(p)) == p");
        if (mask != 0) {
          name[at % 32] ^= mask;
          memset(back, 0xA5, sizeof back);
          FUZZ_CHECK(scc_name_siv_decode(h, mac, name, back) == SCC_ERR_AUTH, "a changed name is refused");
          FUZZ_CHECK(fuzz_all_bytes(back, 16, 0), "a refused name releases nothing");
        }
      }
      break;
    }
    case 7: {
      char text[68];
      memset(text, 0x5a, sizeof text);
      rc = scc_sqlcipher_raw_key(h, text);
      expect_not_live(rc, h);
      if (rc == SCC_OK) FUZZ_CHECK(text[0] == 'x' && text[1] == '\'' && text[66] == '\'' && text[67] == '\0', "the SQLCipher key text is x'<hex>'");
      else FUZZ_CHECK(fuzz_all_bytes((unsigned char *)text, sizeof text, 0x5a), "a refused key writes no text");
      break;
    }
    default: {
      size_t n = scc_zeroize_all();
      FUZZ_CHECK(n == g_nlive, "zeroize_all destroys every live key");
      while (g_nlive > 0) kill(g_live[0]);
      FUZZ_CHECK(scc_secure_heap_used() == g_heap0, "the secure heap is back at its baseline");
      break;
    }
  }
  FUZZ_CHECK(fuzz_is_scc_code(rc), "an SCC_* return code");
  FUZZ_CHECK(scc_live_handles() == g_nlive, "the module's count is the harness's count");
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  for (int steps = 0; size > 0 && steps < 256; steps++) step(&data, &size);
  while (g_nlive > 0) {
    uint32_t h = g_live[0];
    FUZZ_CHECK(scc_key_destroy(h) == SCC_OK, "destroy what is left");
    kill(h);
  }
  FUZZ_CHECK(scc_live_handles() == 0, "no handle outlives the input");
  FUZZ_CHECK(scc_secure_heap_used() == g_heap0, "the secure heap is back at its baseline");
  return 0;
}

/* scc_mldsa_verify (update signatures) over level, SubjectPublicKeyInfo, message, context and signature.
 * Input: vector choice, mode, then
 *   mode 0/1  edits of a valid ACVP vector (test/vectors/mldsa/sigver.h): a level swap bit, a field to
 *             grow or shrink by one byte, then (offset hi, offset lo, xor) triples over spki||msg||ctx||sig
 *   mode 2    raw fields from the input: level, then four length-prefixed fields
 * Oracles: only SCC_OK, SCC_ERR_AUTH, SCC_ERR_ARG, SCC_ERR_TOO_LARGE or SCC_ERR_CRYPTO; the unchanged
 * valid vector verifies; any input whose bytes differ from the vector's never returns SCC_OK. Every
 * field is an exactly sized heap copy. */
#include "harness.h"
#include "../test/vectors/mldsa/sigver.h"

#define NVEC (sizeof MLDSA_SIGVER / sizeof MLDSA_SIGVER[0])

typedef struct {
  int level;
  unsigned char *f[4]; /* spki, msg, ctx, sig */
  size_t n[4];
} vec_t;

static vec_t g_valid[NVEC];
static size_t g_nvalid;

static unsigned char *unhex(const char *prefix, const char *h, size_t *n) {
  size_t a = strlen(prefix) / 2, b = strlen(h) / 2;
  unsigned char *out = malloc(a + b + 1);
  FUZZ_CHECK(out != NULL, "malloc");
  for (size_t i = 0; i < a + b; i++) {
    const char *s = i < a ? prefix + 2 * i : h + 2 * (i - a);
    unsigned int v = 0;
    FUZZ_CHECK(sscanf(s, "%2x", &v) == 1, "vector hex");
    out[i] = (unsigned char)v;
  }
  *n = a + b;
  return out;
}

int LLVMFuzzerInitialize(int *argc, char ***argv) {
  fuzz_init(*argc, *argv);
  for (size_t i = 0; i < NVEC; i++) {
    const mldsa_sigver_t *v = &MLDSA_SIGVER[i];
    if (!v->passed) continue;
    vec_t *t = &g_valid[g_nvalid++];
    t->level = v->level;
    t->f[0] = unhex(v->level == 65 ? "308207b2300b0609608648016503040312038207a100" : "30820a32300b060960864801650304031303820a2100", v->pk, &t->n[0]);
    t->f[1] = unhex("", v->message, &t->n[1]);
    t->f[2] = unhex("", v->context, &t->n[2]);
    t->f[3] = unhex("", v->signature, &t->n[3]);
    FUZZ_CHECK(scc_mldsa_verify(t->level, t->f[0], t->n[0], t->f[1], t->n[1], t->f[2], t->n[2], t->f[3], t->n[3]) == SCC_OK, "a valid vector verifies");
  }
  FUZZ_CHECK(g_nvalid > 0, "sigver.h has a valid vector");
  return 0;
}

static int allowed_rc(int rc) {
  return rc == SCC_OK || rc == SCC_ERR_AUTH || rc == SCC_ERR_ARG || rc == SCC_ERR_TOO_LARGE || rc == SCC_ERR_CRYPTO;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  const vec_t *v = &g_valid[take_u8(&data, &size) % g_nvalid];
  uint8_t mode = (uint8_t)(take_u8(&data, &size) % 3);
  unsigned char *f[4];
  size_t n[4];
  int level, differs = 0;
  if (mode == 2) {
    level = take_u8(&data, &size);
    level = level < 128 ? level : 65 + (level & 1) * 22; /* mostly 65 or 87, sometimes anything */
    for (int i = 0; i < 4; i++) {
      const uint8_t *p = take_field(&data, &size, 255, &n[i]);
      f[i] = fuzz_dup(p, n[i]);
    }
    differs = 1; /* no field of 255 bytes or fewer is a whole valid SPKI or signature */
  } else {
    uint8_t shape = take_u8(&data, &size);
    level = (shape & 1) ? (v->level == 65 ? 87 : 65) : v->level;
    int grow = (shape >> 1) & 7; /* 0..3 shrink field k, 4..7 grow field k-4 */
    for (int i = 0; i < 4; i++) {
      n[i] = v->n[i];
      if ((shape & 0x10) && grow % 4 == i) {
        if (grow < 4 && n[i] > 0) n[i]--;
        else if (grow >= 4) n[i]++;
      }
      f[i] = malloc(n[i]);
      FUZZ_CHECK(f[i] != NULL || n[i] == 0, "malloc");
      size_t keep = n[i] < v->n[i] ? n[i] : v->n[i];
      if (keep > 0) memcpy(f[i], v->f[i], keep);
      if (n[i] > v->n[i]) f[i][n[i] - 1] = 0;
    }
    size_t total = n[0] + n[1] + n[2] + n[3];
    for (int e = 0; e < 8 && size >= 3 && total > 0; e++) {
      const uint8_t *t = take(&data, &size, 3);
      size_t at = ((size_t)t[0] << 8 | t[1]) % total;
      int k = 0;
      while (at >= n[k]) at -= n[k++];
      f[k][at] ^= t[2];
    }
    /* Two edits can cancel out, so "changed" is decided on the final bytes. */
    differs = level != v->level;
    for (int i = 0; i < 4; i++) differs |= n[i] != v->n[i] || (n[i] > 0 && memcmp(f[i], v->f[i], n[i]) != 0);
  }
  int rc = scc_mldsa_verify(level, f[0], n[0], f[1], n[1], f[2], n[2], f[3], n[3]);
  FUZZ_CHECK(allowed_rc(rc), "mldsa_verify returns only OK, AUTH, ARG, TOO_LARGE or CRYPTO");
  if (differs) FUZZ_CHECK(rc != SCC_OK, "a changed vector never verifies");
  if (mode != 2 && !differs) FUZZ_CHECK(rc == SCC_OK, "the unchanged vector verifies");
  for (int i = 0; i < 4; i++) free(f[i]);
  FUZZ_CHECK(scc_live_handles() == 0, "no handle outlives the input");
  return 0;
}

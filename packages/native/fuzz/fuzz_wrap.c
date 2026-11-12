/* The key-wrapping services: scc_gcm_open_key_for, scc_rewrap_key, scc_history_seal, scc_history_rewrap,
 * scc_history_open, with every usage value and every class of KEK.
 * Input: op, usage, KEK choice, second-key choice, wrap mode (0 raw bytes from the input, 1 a valid wrap
 * with one byte XORed, 2 a valid wrap), index, mask, IV (12), AAD (field), ciphertext (field), ctx (field).
 * Oracles: on every failure no new handle is live and the 60-byte output buffer (IV || wrapped key),
 * pre-filled with 0xA5, is untouched; a handle comes out only with a usage wrap_allowed permits (a
 * password-class KEK gives a MASTER key, a KEK a DB key) and history_open gives only MASTER; a valid wrap
 * (mode 2) through an allowed KEK always succeeds; every return code is an SCC_* code; no handle outlives
 * the input. */
#include "harness.h"

enum { P1, P2, KK, MK, M2, DK, RK, DEAD, NKEYS };
static size_t g_live0;

int LLVMFuzzerInitialize(int *argc, char ***argv) {
  fuzz_init(*argc, *argv);
  g_live0 = scc_live_handles();
  return 0;
}

static unsigned char key_byte(int i) { return (unsigned char)(0x11 * (i + 1)); }

static uint32_t import(int i, int usage) {
  unsigned char b[32];
  memset(b, key_byte(i), sizeof b);
  uint32_t h = 0;
  FUZZ_CHECK(scc_key_import_for(b, 32, usage, &h) == SCC_OK, "import a fixture key");
  return h;
}

/* GCM of 32 bytes of `moved` under the bytes of fixture key `kek`, through a DATA twin of those bytes. */
static void wrap_under(int kek, unsigned char moved, const unsigned char *iv, const unsigned char *aad, size_t aad_len, unsigned char ct[48]) {
  uint32_t twin = import(kek, SCC_USE_DATA);
  unsigned char k[32], iv_out[12];
  memset(k, moved, sizeof k);
  FUZZ_CHECK(scc_gcm_seal(twin, iv, aad, aad_len, k, 32, iv_out, ct) == SCC_OK, "wrap a fixture key");
  FUZZ_CHECK(scc_key_destroy(twin) == SCC_OK, "destroy the twin");
}

static int allowed(int ku, int usage) {
  return (ku == SCC_USE_PASSWORD && usage == SCC_USE_MASTER) || (ku == SCC_USE_KEK && usage == SCC_USE_DB);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  uint8_t op = (uint8_t)(take_u8(&data, &size) % 5);
  int usage = (int)(take_u8(&data, &size) % 9) - 1; /* -1 .. 7: every usage and both neighbours */
  int kc = take_u8(&data, &size) % NKEYS, sc = take_u8(&data, &size) % NKEYS;
  uint8_t mode = (uint8_t)(take_u8(&data, &size) % 3), at = take_u8(&data, &size), mask = take_u8(&data, &size);
  const uint8_t *iv_p = take(&data, &size, 12);
  if (iv_p == NULL) return 0;
  size_t aad_len = 0, ct_len = 0, ctx_len = 0;
  const uint8_t *aad_p = take_field(&data, &size, 255, &aad_len);
  const uint8_t *ct_p = take_field(&data, &size, 255, &ct_len);
  const uint8_t *ctx_p = take_field(&data, &size, 64, &ctx_len);

  static const int USAGE[NKEYS] = {SCC_USE_PASSWORD, SCC_USE_PASSWORD, SCC_USE_KEK, SCC_USE_MASTER, SCC_USE_MASTER, SCC_USE_DATA, SCC_USE_RECOVERY, SCC_USE_DATA};
  uint32_t h[NKEYS];
  for (int i = 0; i < NKEYS; i++) h[i] = import(i, USAGE[i]);
  FUZZ_CHECK(scc_key_destroy(h[DEAD]) == SCC_OK, "destroy the dead fixture");
  size_t live = scc_live_handles();

  unsigned char *iv = fuzz_dup(iv_p, 12), *aad = fuzz_dup(aad_p, aad_len), *ctx = fuzz_dup(ctx_p, ctx_len);
  unsigned char *ct;
  /* The proof (or, for history_open, the entry) the call is given. */
  unsigned char valid[48];
  int valid_ok = 0;
  if (mode == 0) {
    ct = fuzz_dup(ct_p, ct_len);
  } else {
    unsigned char hctx[20];
    memset(hctx, 0x77, sizeof hctx);
    if (op == 4) {
      /* An entry under K_hist(MK, hctx), made by the module itself: P1 proves the moved key (0xAA..). */
      unsigned char proof[48], out[60];
      wrap_under(P1, 0xAA, iv, aad, aad_len, proof);
      FUZZ_CHECK(scc_history_seal(h[P1], iv, aad, aad_len, proof, 48, h[MK], hctx, 20, aad, aad_len, out, out + 12) == SCC_OK, "make a history entry");
      memcpy(iv, out, 12);
      memcpy(valid, out + 12, 48);
      if (ctx_len == 20) memcpy(ctx, hctx, 20); /* the entry's own ctx, when the input asks for a 20-byte one */
      valid_ok = kc == MK && ctx_len == 20;
    } else {
      /* gcm_open_key_for unwraps the second key's bytes; the proofs carry MK for history_rewrap, else 0xAA... */
      unsigned char moved = op == 3 ? key_byte(MK) : op == 0 ? key_byte(sc) : 0xAA;
      if (kc < DEAD) wrap_under(kc, moved, iv, aad, aad_len, valid);
      else memset(valid, 0, sizeof valid);
      valid_ok = kc < DEAD;
    }
    if (mode == 1 && mask != 0) {
      if (at % 60 < 12) iv[at % 12] ^= mask;
      else valid[at % 48] ^= mask;
      valid_ok = 0;
    }
    ct_len = 48;
    ct = fuzz_dup(valid, 48);
  }

  unsigned char buf[60];
  memset(buf, 0xA5, sizeof buf);
  uint32_t out = 0;
  int rc, gives_handle = 0, ku = scc_key_usage(h[kc]);
  switch (op) {
    case 0:
      rc = scc_gcm_open_key_for(h[kc], iv, aad, aad_len, ct, ct_len, usage, &out);
      gives_handle = 1;
      if (rc == SCC_OK) FUZZ_CHECK(allowed(ku, usage) && scc_key_usage(out) == usage, "a handle only with a usage wrap_allowed permits");
      if (mode == 2 && valid_ok && allowed(ku, usage)) FUZZ_CHECK(rc == SCC_OK, "a valid wrap under an allowed KEK opens");
      break;
    case 1:
      rc = scc_rewrap_key(h[kc], iv, aad, aad_len, ct, ct_len, h[sc], aad, aad_len, buf, buf + 12);
      if (rc == SCC_OK) FUZZ_CHECK(ku == SCC_USE_PASSWORD && scc_key_usage(h[sc]) == SCC_USE_PASSWORD, "rewrap moves only between password-class KEKs");
      if (mode == 2 && valid_ok && ku == SCC_USE_PASSWORD && scc_key_usage(h[sc]) == SCC_USE_PASSWORD) FUZZ_CHECK(rc == SCC_OK, "a valid rewrap succeeds");
      break;
    case 2:
      rc = scc_history_seal(h[kc], iv, aad, aad_len, ct, ct_len, h[sc], ctx, ctx_len, aad, aad_len, buf, buf + 12);
      if (rc == SCC_OK) FUZZ_CHECK(ku == SCC_USE_PASSWORD && scc_key_usage(h[sc]) == SCC_USE_MASTER && ctx_len == 20, "history_seal: a password proof into a master's history");
      break;
    case 3: {
      /* The entry: the 0xAA.. key in MK's history under ctx 0x77.., unless the input's own bytes stand in. */
      unsigned char hctx[20], proof[48], entry[60];
      memset(hctx, 0x77, sizeof hctx);
      wrap_under(P1, 0xAA, iv, aad, aad_len, proof);
      FUZZ_CHECK(scc_history_seal(h[P1], iv, aad, aad_len, proof, 48, h[MK], hctx, 20, aad, aad_len, entry, entry + 12) == SCC_OK, "make a history entry");
      rc = scc_history_rewrap(h[kc], iv, aad, aad_len, ct, ct_len, hctx, 20, entry, aad, aad_len, entry + 12, 48, h[sc], ctx, ctx_len, aad, aad_len, buf, buf + 12);
      if (rc == SCC_OK) FUZZ_CHECK(ku == SCC_USE_PASSWORD && scc_key_usage(h[sc]) == SCC_USE_MASTER, "history_rewrap: a password proof into a master's history");
      if (mode == 2 && valid_ok && ku == SCC_USE_PASSWORD && sc == M2 && ctx_len == 20) FUZZ_CHECK(rc == SCC_OK, "a valid history rewrap succeeds");
      break;
    }
    default:
      rc = scc_history_open(h[kc], ctx, ctx_len, iv, aad, aad_len, ct, ct_len, &out);
      gives_handle = 1;
      if (rc == SCC_OK) FUZZ_CHECK(ku == SCC_USE_MASTER && scc_key_usage(out) == SCC_USE_MASTER, "history_open gives only a MASTER key");
      if (mode == 2 && valid_ok) FUZZ_CHECK(rc == SCC_OK, "a valid history entry opens");
      break;
  }
  FUZZ_CHECK(fuzz_is_scc_code(rc), "an SCC_* return code");
  if (rc != SCC_OK) {
    FUZZ_CHECK(scc_live_handles() == live, "no output handle on a failure");
    if (gives_handle) FUZZ_CHECK(out == 0 || scc_key_usage(out) == 0, "the failed call's handle names no key");
    FUZZ_CHECK(fuzz_all_bytes(buf, sizeof buf, 0xA5), "the 60-byte output is untouched on a failure");
  } else if (gives_handle) {
    FUZZ_CHECK(scc_live_handles() == live + 1, "one new handle on success");
    FUZZ_CHECK(scc_key_destroy(out) == SCC_OK, "destroy the output");
  }
  free(iv);
  free(aad);
  free(ctx);
  free(ct);
  for (int i = 0; i < DEAD; i++) FUZZ_CHECK(scc_key_destroy(h[i]) == SCC_OK, "destroy a fixture");
  FUZZ_CHECK(scc_key_destroy(h[DEAD]) == SCC_ERR_HANDLE, "a dead handle stays dead");
  FUZZ_CHECK(scc_live_handles() == g_live0, "no handle outlives the input");
  return 0;
}

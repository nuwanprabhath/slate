/* scc_gcm_open over caller-chosen key, IV, AAD, ciphertext and tag.
 * Input: mode (1 byte), key (32), IV (12), AAD (length-prefixed), body (length-prefixed), then for mode 1
 * an index and an XOR mask.
 *   mode 0  the body is ciphertext||tag as it came
 *   mode 1  the body is sealed first (KAT build: the caller's IV), then one byte of the sealed text is XORed
 *   mode 2  the body is sealed first and opened unchanged
 * Oracles: only SCC_OK or SCC_ERR_AUTH; on SCC_ERR_AUTH the plaintext buffer (pre-filled with 0xA5) is all
 * zero; on SCC_OK, sealing the plaintext under the same key, IV and AAD gives back the input bytes; a
 * changed byte (mode 1, mask != 0) never opens; mode 2 always opens; no handle outlives the input. */
#include "harness.h"

static size_t g_live0;

int LLVMFuzzerInitialize(int *argc, char ***argv) {
  fuzz_init(*argc, *argv);
  g_live0 = scc_live_handles();
  return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  uint8_t mode = (uint8_t)(take_u8(&data, &size) % 3);
  const uint8_t *key = take(&data, &size, 32), *iv_in = take(&data, &size, 12);
  if (key == NULL || iv_in == NULL) return 0;
  size_t aad_len = 0, body_len = 0;
  const uint8_t *aad_p = take_field(&data, &size, 255, &aad_len);
  const uint8_t *body_p = take_field(&data, &size, 255, &body_len);
  uint8_t at = take_u8(&data, &size), mask = take_u8(&data, &size);
  unsigned char *aad = fuzz_dup(aad_p, aad_len), *iv = fuzz_dup(iv_in, 12);

  uint32_t k = 0;
  FUZZ_CHECK(scc_key_import_for(key, 32, SCC_USE_DATA, &k) == SCC_OK, "import a data key");

  unsigned char *ct;
  size_t ct_len;
  int changed = 0;
  if (mode == 0) {
    ct = fuzz_dup(body_p, body_len);
    ct_len = body_len;
  } else {
    ct_len = body_len + 16;
    ct = malloc(ct_len);
    FUZZ_CHECK(ct != NULL, "malloc");
    unsigned char iv_out[12], *pt = fuzz_dup(body_p, body_len);
    FUZZ_CHECK(scc_gcm_seal(k, iv, aad, aad_len, pt, body_len, iv_out, ct) == SCC_OK, "seal under a caller IV");
    FUZZ_CHECK(memcmp(iv_out, iv, 12) == 0, "seal used the caller IV");
    free(pt);
    if (mode == 1 && mask != 0) {
      ct[at % ct_len] ^= mask;
      changed = 1;
    }
  }

  size_t pt_len = ct_len >= 16 ? ct_len - 16 : 0;
  unsigned char *pt = malloc(pt_len);
  FUZZ_CHECK(pt != NULL || pt_len == 0, "malloc");
  if (pt_len > 0) memset(pt, 0xA5, pt_len);
  int rc = scc_gcm_open(k, iv, aad, aad_len, ct, ct_len, pt);
  FUZZ_CHECK(rc == SCC_OK || rc == SCC_ERR_AUTH, "gcm_open returns only OK or AUTH");
  if (rc == SCC_ERR_AUTH) FUZZ_CHECK(fuzz_all_bytes(pt, pt_len, 0), "plaintext released after a failed tag");
  if (changed) FUZZ_CHECK(rc == SCC_ERR_AUTH, "a changed byte never opens");
  if (mode == 2) FUZZ_CHECK(rc == SCC_OK, "what was sealed opens");
  if (rc == SCC_OK) {
    unsigned char *again = malloc(ct_len), iv_out[12];
    FUZZ_CHECK(again != NULL, "malloc");
    FUZZ_CHECK(scc_gcm_seal(k, iv, aad, aad_len, pt, pt_len, iv_out, again) == SCC_OK, "reseal");
    FUZZ_CHECK(memcmp(again, ct, ct_len) == 0, "resealing the plaintext gives back the input");
    free(again);
  }
  free(pt);
  free(ct);
  free(aad);
  free(iv);
  FUZZ_CHECK(scc_key_destroy(k) == SCC_OK, "destroy the data key");
  FUZZ_CHECK(scc_live_handles() == g_live0, "no handle outlives the input");
  return 0;
}

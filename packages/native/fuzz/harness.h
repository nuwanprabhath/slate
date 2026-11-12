/* Shared by the libFuzzer harnesses of slate_crypto_core.c (KAT build). Each harness is one
 * LLVMFuzzerInitialize plus one LLVMFuzzerTestOneInput, so the same file links against libFuzzer
 * (Linux) or standalone.c (every OS). An oracle that fails prints its name and aborts, which both
 * drivers report as a crash with the input that caused it. */
#ifndef SLATE_FUZZ_HARNESS_H
#define SLATE_FUZZ_HARNESS_H
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "slate_crypto_core.h"

/* KAT-build only symbols; the shipped addon has none of them. */
unsigned char *scc__slot_bytes_for_kat(uint32_t h);

int LLVMFuzzerInitialize(int *argc, char ***argv);
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

#define FUZZ_CHECK(cond, name)                                                         \
  do {                                                                                 \
    if (!(cond)) {                                                                     \
      fprintf(stderr, "FUZZ_CHECK failed: %s (%s:%d)\n", (name), __FILE__, __LINE__); \
      abort();                                                                         \
    }                                                                                  \
  } while (0)

/* The fips provider config and modules folder, when fuzz.mjs --fips passes them as -slate_fips_*= words. */
static const char *g_fuzz_fips_config = NULL;
static const char *g_fuzz_fips_modules = NULL;

/* As kat.c: scc_preinit, then scc_init without the provider unless fuzz.mjs --fips named one. */
static inline void fuzz_init(int argc, char **argv) {
  static const char CONFIG[] = "-slate_fips_config=", MODULES[] = "-slate_fips_modules=";
  for (int i = 1; i < argc; i++) {
    if (strncmp(argv[i], CONFIG, sizeof CONFIG - 1) == 0) g_fuzz_fips_config = argv[i] + sizeof CONFIG - 1;
    if (strncmp(argv[i], MODULES, sizeof MODULES - 1) == 0) g_fuzz_fips_modules = argv[i] + sizeof MODULES - 1;
  }
  FUZZ_CHECK(scc_preinit() == SCC_OK, "scc_preinit");
  int fips = g_fuzz_fips_config != NULL && g_fuzz_fips_modules != NULL;
  FUZZ_CHECK(scc_init(g_fuzz_fips_config, g_fuzz_fips_modules, fips) == SCC_OK, "scc_init");
  if (fips) FUZZ_CHECK(scc_require_approved_keys() == SCC_OK, "scc_require_approved_keys");
}

/* Consumes n bytes from the front of the input; NULL (and nothing consumed) when fewer remain. */
static inline const uint8_t *take(const uint8_t **data, size_t *len, size_t n) {
  if (*len < n) return NULL;
  const uint8_t *p = *data;
  *data += n;
  *len -= n;
  return p;
}

/* One byte, or 0 once the input is spent: a harness never branches on uninitialised memory. */
static inline uint8_t take_u8(const uint8_t **data, size_t *len) {
  const uint8_t *p = take(data, len, 1);
  return p == NULL ? 0 : *p;
}

/* A length-prefixed field (one byte, at most `cap`), clipped to what remains. */
static inline const uint8_t *take_field(const uint8_t **data, size_t *len, size_t cap, size_t *out_len) {
  size_t n = take_u8(data, len);
  if (n > cap) n = cap;
  if (n > *len) n = *len;
  *out_len = n;
  return take(data, len, n);
}

/* Every return code the module defines (slate_crypto_core.h). */
static inline int fuzz_is_scc_code(int rc) { return rc <= SCC_OK && rc >= SCC_ERR_USAGE; }

static inline int fuzz_all_bytes(const unsigned char *p, size_t n, unsigned char v) {
  for (size_t i = 0; i < n; i++)
    if (p[i] != v) return 0;
  return 1;
}

/* A copy of exactly n bytes on the C heap, so ASan traps a read one past the end of a field. */
static inline unsigned char *fuzz_dup(const uint8_t *p, size_t n) {
  unsigned char *b = malloc(n); /* malloc(0) under ASan is a zero-byte region: any read of it traps */
  FUZZ_CHECK(b != NULL || n == 0, "malloc");
  if (n > 0) memcpy(b, p, n);
  return b;
}
#endif

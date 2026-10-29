/* packages/native/src/slate_crypto_core.c — the only C file that touches key material.
 * Every CSP lives in OpenSSL's secure heap; JavaScript only ever sees uint32 handles. */
#include "slate_crypto_core.h"
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/provider.h>
#include <openssl/rand.h>
#include <openssl/self_test.h>
#include <openssl/x509.h>
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <sys/resource.h>

/* The provider's SHA-256, compiled in from the committed packages/native/fips-digest.json (review M4).
 * A build without a pin for its target gets "" and can never start the FIPS provider. */
#if defined(__has_include)
#if __has_include("slate_fips_pin.h")
#include "slate_fips_pin.h"
#endif
#endif
#ifndef SLATE_FIPS_SHA256
#define SLATE_FIPS_SHA256 ""
#endif
#ifndef SLATE_FIPS_CNF_SHA256
#define SLATE_FIPS_CNF_SHA256 ""
#endif
#if defined(__APPLE__)
#define FIPS_MODULE_FILE "fips.dylib"
#else
#define FIPS_MODULE_FILE "fips.so"
#endif
#define MAX_PROVIDER_BYTES ((size_t)64 * 1024 * 1024)

/* binding.gyp defines SCC_RELEASE; a KAT flag smuggled into that build (CFLAGS, CPPFLAGS) stops it. */
#if defined(SCC_KAT_BUILD) && defined(SCC_RELEASE)
#error "SCC_KAT_BUILD in a release build"
#endif

/* A marker check:exports requires in the shipped binary. A string literal, so strip cannot remove it. */
#ifdef SCC_KAT_BUILD
#define SCC_BUILD_KIND "slate-native-build:kat"
#else
#define SCC_BUILD_KIND "slate-native-build:release"
#endif
const char *scc_build_kind(void) { return SCC_BUILD_KIND; }

#define MAX_HANDLES 64
#define KEY_LEN 32

/* Handle layout: bit 31 = non-approved namespace (review N8), bits 8..30 = generation, bits 0..7 = slot.
 * A generation is never reused: a slot that reaches GEN_MAX is retired (review notes: no wrap). */
#define NON_APPROVED_BIT 0x80000000u
#define GEN_MAX 0x7fffffu

typedef struct {
  unsigned char *bytes; /* OPENSSL_secure_zalloc'd, KEY_LEN bytes; NULL = free slot */
  uint32_t generation;  /* of the last handle issued; 0 = never used */
  int approved;         /* created only by approved services in the FIPS context, from approved inputs */
  int usage;            /* SCC_USE_*: what the key may do (C4); fixed for the life of the handle */
  int fresh;            /* made by keyRandom and never used since: the only master or database key a KEK may wrap */
} slot_t;

static slot_t g_slots[MAX_HANDLES];

/* The one narrowing of a length in this file: every size_t is checked against SCC_MAX_INPUT (far below
 * INT_MAX) first, so EVP_*Update never sees a truncated or negative length (review H1). */
/* A label that could collide with another after truncation or at a NUL is refused, never shortened. */
static int label_ok(const char *label, size_t len) {
  return label != NULL && len >= 1 && len <= SCC_MAX_LABEL && memchr(label, '\0', len) == NULL;
}

static int int_len(size_t n, int *out) {
  if (n > SCC_MAX_INPUT) return 0;
  *out = (int)n;
  return 1;
}
/* The global default context, so SQLCipher (compiled into this addon, using NULL contexts) is served by the
 * same FIPS provider. It holds only fips + base: every algorithm it can reach is an approved one. */
static OSSL_LIB_CTX *g_fips_ctx = NULL;
static OSSL_LIB_CTX *g_std_ctx = NULL;   /* default provider: Argon2id for the standard profile */
static OSSL_PROVIDER *g_fips = NULL, *g_base = NULL, *g_default = NULL;
/* sticky: once set, every service refuses (ISO/IEC 19790 §7.10). Atomic because an Argon2id job reads it
 * on a libuv thread (review C4 L2); only the main thread ever sets it. */
static atomic_int g_error_state = 0;
static int g_selftest_events = 0, g_selftest_failures = 0;
static int g_heap_locked = 0;
static atomic_int g_ready = 0;           /* latched by a successful scc_init; services refuse until then */
static int g_approved_only = 0;          /* one-way: SQLCipher refuses non-approved keys (fips-140-3 profile, C5) */
/* C6 (audit S-1, S-2): the app gates the module before init, and from then on no service runs until its
 * power-up self-test passed. The self-test itself runs inside a session (scc_post_begin .. scc_post_end); a
 * passed session opens the services for the process, a failed one enters the error state. A process that
 * never gates (the KATs, the tests, the CLIs) keeps the services open after init. */
static int g_post_gated = 0, g_post_open = 0, g_post_ok = 0;

/* C5 criterion 2: a fips-140-3 vault latched approved-only, so the non-approved services (suite 0x01's HKDF
 * and AES-ECB names, the standard profile's Argon2id) refuse for the rest of the process. */
#define NOT_AFTER_LATCH()                                    \
  do {                                                       \
    if (g_approved_only) return SCC_ERR_NOT_APPROVED;        \
  } while (0)

/* First statement of every service (review M1): nothing reaches OpenSSL before scc_init has set up the
 * contexts, and nothing runs once the module is in the error state. */
#define SERVICE_GATE()                                       \
  do {                                                       \
    if (scc_in_error_state()) return SCC_ERR_ERROR_STATE;    \
    if (!g_ready) return SCC_ERR_STATE;                      \
    if (g_post_gated && !g_post_open && !g_post_ok)          \
      return SCC_ERR_STATE;                                  \
  } while (0)

static int on_self_test(const OSSL_PARAM params[], void *arg) {
  (void)arg;
  const OSSL_PARAM *p = OSSL_PARAM_locate_const(params, OSSL_PROV_PARAM_SELF_TEST_PHASE);
  const char *phase = NULL;
  if (p == NULL || !OSSL_PARAM_get_utf8_ptr(p, &phase)) return 1;
  g_selftest_events++;
  if (strcmp(phase, OSSL_SELF_TEST_PHASE_FAIL) == 0) {
    g_selftest_failures++;
    g_error_state = 1;
  }
  return 1;
}

typedef struct { int fips, base, other; } provider_census_t;

static int census(OSSL_PROVIDER *prov, void *arg) {
  provider_census_t *c = arg;
  const char *name = OSSL_PROVIDER_get0_name(prov);
  if (strcmp(name, "fips") == 0) c->fips++;
  else if (strcmp(name, "base") == 0) c->base++;
  else c->other++;
  return 1;
}

static int only_fips_and_base(void) {
  provider_census_t c = {0, 0, 0};
  return OSSL_PROVIDER_do_all(g_fips_ctx, census, &c) && c.fips == 1 && c.base == 1 && c.other == 0;
}

/* Hashes <modules_dir>/<file> and compares it with a compiled-in pin BEFORE OpenSSL reads it: the
 * provider binary (so a substituted provider's constructors never run) and fipsmodule.cnf (so a
 * `module = <other.dylib>` line cannot make OpenSSL load something else; review R3). The loader reads
 * the files again afterwards; a same-user attacker who can swap them in that window can also patch
 * this process, and is outside the threat model (code signing, C12/D-1, is the anchor). */
static int verify_file_digest(const char *modules_dir, const char *file, const char *pin) {
  static const char HEX[] = "0123456789abcdef";
  char path[4096], hex[65];
  unsigned char md[32], buf[65536];
  unsigned int md_len = 0;
  size_t total = 0, r;
  if (strlen(pin) != 64) return SCC_ERR_MODULE_DIGEST;
  int n = snprintf(path, sizeof path, "%s/%s", modules_dir, file);
  if (n < 0 || (size_t)n >= sizeof path) return SCC_ERR_ARG;
  FILE *f = fopen(path, "rb");
  if (f == NULL) return SCC_ERR_MODULE_DIGEST;
  EVP_MD *sha = EVP_MD_fetch(g_std_ctx, "SHA2-256", NULL);
  EVP_MD_CTX *c = EVP_MD_CTX_new();
  int ok = sha != NULL && c != NULL && EVP_DigestInit_ex2(c, sha, NULL) == 1;
  while (ok && (r = fread(buf, 1, sizeof buf, f)) > 0) {
    total += r;
    ok = total <= MAX_PROVIDER_BYTES && EVP_DigestUpdate(c, buf, r) == 1;
  }
  ok = ok && ferror(f) == 0 && EVP_DigestFinal_ex(c, md, &md_len) == 1 && md_len == 32;
  fclose(f);
  EVP_MD_CTX_free(c);
  EVP_MD_free(sha);
  if (!ok) return SCC_ERR_MODULE_DIGEST;
  for (size_t i = 0; i < 32; i++) {
    hex[2 * i] = HEX[md[i] >> 4];
    hex[2 * i + 1] = HEX[md[i] & 0x0f];
  }
  hex[64] = '\0';
  return CRYPTO_memcmp(hex, pin, 64) == 0 ? SCC_OK : SCC_ERR_MODULE_DIGEST;
}

static int verify_provider_digest(const char *modules_dir) {
  static const char provider_pin[] = SLATE_FIPS_SHA256;
  static const char config_pin[] = SLATE_FIPS_CNF_SHA256;
  int rc = verify_file_digest(modules_dir, FIPS_MODULE_FILE, provider_pin);
  return rc == SCC_OK ? verify_file_digest(modules_dir, "fipsmodule.cnf", config_pin) : rc;
}

/* The runtime config (written by fipsConfig.ts at every start) never names a module path itself; one
 * that does was edited by someone else and is refused (review R3). */
static int config_names_module(const char *config_path) {
  char line[4096];
  FILE *f = fopen(config_path, "r");
  if (f == NULL) return 1;
  int found = 0;
  while (!found && fgets(line, sizeof line, f) != NULL) {
    const char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (strncmp(p, "module", 6) == 0) {
      p += 6;
      while (*p == ' ' || *p == '\t') p++;
      found = *p == '=';
    }
  }
  fclose(f);
  return found;
}

int scc_harden_process(void) {
  struct rlimit none = {0, 0};
  int rc = setrlimit(RLIMIT_CORE, &none);
#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) rc = -1;
#endif
  return rc == 0 ? SCC_OK : SCC_ERR_HARDEN;
}

int scc_init(const char *fips_config_path, const char *modules_dir, int require_fips) {
  if (g_fips_ctx != NULL) return SCC_ERR_STATE;
  /* libcrypto would otherwise read openssl.cnf from OPENSSL_CONF or the compiled-in OPENSSLDIR on
   * first use; the only config this module ever reads is fips_config_path (criterion 2). */
  if (OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, NULL) != 1) return SCC_ERR_INIT;
  /* 1 MiB secure heap, 32-byte minimum allocation: mlock'd, guard pages, MADV_DONTDUMP on Linux.
   * 2 = allocated but not locked (RLIMIT_MEMLOCK too low): usable, reported as degraded. */
  int sh = CRYPTO_secure_malloc_init(1 << 20, 32);
  if (sh == 0) return SCC_ERR_SECURE_HEAP;
  g_heap_locked = sh == 1;
  g_fips_ctx = OSSL_LIB_CTX_get0_global_default();
  g_std_ctx = OSSL_LIB_CTX_new();
  if (g_fips_ctx == NULL || g_std_ctx == NULL) return SCC_ERR_INIT;
  g_default = OSSL_PROVIDER_load(g_std_ctx, "default");
  if (g_default == NULL) return SCC_ERR_INIT;
  OSSL_SELF_TEST_set_callback(g_fips_ctx, on_self_test, NULL);
  if (require_fips) {
    if (fips_config_path == NULL || modules_dir == NULL) return SCC_ERR_ARG;
    int drc = verify_provider_digest(modules_dir);
    if (drc != SCC_OK) { g_error_state = 1; return drc; }
    if (config_names_module(fips_config_path)) { g_error_state = 1; return SCC_ERR_MODULE_CONFIG; }
    /* fips.so / fips.dylib is looked up here, never on the system's OPENSSLDIR. A config the module
     * refuses (a tampered module-mac, a failed integrity test) leaves the module unusable: error state. */
    if (!OSSL_PROVIDER_set_default_search_path(g_fips_ctx, modules_dir)) { g_error_state = 1; return SCC_ERR_MODULE_CONFIG; }
    if (!OSSL_LIB_CTX_load_config(g_fips_ctx, fips_config_path)) { g_error_state = 1; return SCC_ERR_MODULE_CONFIG; }
    g_fips = OSSL_PROVIDER_load(g_fips_ctx, "fips");   /* runs the module's integrity test + CASTs */
    g_base = OSSL_PROVIDER_load(g_fips_ctx, "base");
    if (g_fips == NULL || g_base == NULL || !OSSL_PROVIDER_self_test(g_fips)) { g_error_state = 1; return SCC_ERR_MODULE_SELFTEST; }
    if (!EVP_set_default_properties(g_fips_ctx, "fips=yes")) { g_error_state = 1; return SCC_ERR_INIT; }
  } else {
    /* Development and the standard profile on platforms without a module build: same API, no claim. */
    if (OSSL_PROVIDER_load(g_fips_ctx, "default") == NULL) return SCC_ERR_INIT;
  }
  if (g_error_state) return SCC_ERR_MODULE_SELFTEST;
  /* Criterion 3, checked rather than assumed: the note-data context holds exactly fips + base. */
  if (require_fips && !only_fips_and_base()) { g_error_state = 1; return SCC_ERR_MODULE_CONFIG; }
  g_ready = 1;
  return SCC_OK;
}

int scc_preinit(void) {
  /* Called when the addon loads, before anything else can touch OpenSSL: libcrypto never reads
   * OPENSSL_CONF or the compiled-in OPENSSLDIR (review M1, criterion 2). */
  return OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, NULL) == 1 ? SCC_OK : SCC_ERR_INIT;
}

#ifdef SCC_KAT_BUILD
void scc__set_generation_for_kat(uint32_t slot, uint32_t generation) {
  if (slot < MAX_HANDLES) g_slots[slot].generation = generation;
}
static int g_kat_provider_error = 0;
void scc__force_provider_error_for_kat(void) { g_kat_provider_error = 1; }
#endif

/* Review L4: a conditional self-test failing after load (DRBG health test, pairwise test) puts the FIPS
 * provider in its own error state. Its OSSL_PROV_PARAM_STATUS is then 0, and the module latches too. */
static int provider_in_error(void) {
#ifdef SCC_KAT_BUILD
  if (g_kat_provider_error) return 1;
#endif
  if (g_fips == NULL) return 0;
  int status = 1;
  OSSL_PARAM p[] = {OSSL_PARAM_construct_int(OSSL_PROV_PARAM_STATUS, &status), OSSL_PARAM_construct_end()};
  return !OSSL_PROVIDER_get_params(g_fips, p) || status == 0;
}

int scc_fips_active(void) {
  return g_fips_ctx != NULL && g_fips != NULL && EVP_default_properties_is_fips_enabled(g_fips_ctx) && !scc_in_error_state();
}

void scc_enter_error_state(void) { g_error_state = 1; g_post_open = 0; scc_zeroize_all(); }

void scc_post_gate(void) { g_post_gated = 1; }

/* A module that never initialised has passed nothing. */
int scc_post_passed(void) { return g_ready && !g_error_state && (!g_post_gated || g_post_ok); }

int scc_post_begin(void) {
  if (scc_in_error_state()) return SCC_ERR_ERROR_STATE;
  if (!g_ready || g_post_open) return SCC_ERR_STATE;
  g_post_open = 1;
  return SCC_OK;
}

/* ISO/IEC 19790 §7.10: a failed self-test leaves the module refusing every service until the process ends. */
int scc_post_end(int passed) {
  if (!g_post_open) return SCC_ERR_STATE;
  g_post_open = 0;
  if (!passed || scc_in_error_state()) {
    scc_enter_error_state();
    return SCC_ERR_ERROR_STATE;
  }
  g_post_ok = 1;
  return SCC_OK;
}
/* The latch alone, without asking the provider: cheap enough for SQLite's authorizer, which runs for
 * every column of every statement (review M3). scc_in_error_state also notices a provider failure. */
int scc_error_latched(void) { return g_error_state; }

int scc_in_error_state(void) {
  if (!g_error_state && provider_in_error()) scc_enter_error_state();
  return g_error_state;
}

/* A DRBG failure is a module failure, not a retryable error: latch it (review L4). */
static int drbg_failed(void) {
  scc_enter_error_state();
  return SCC_ERR_DRBG;
}

static int alloc_slot(unsigned char **out, uint32_t *handle, int approved, int usage) {
  for (uint32_t i = 0; i < MAX_HANDLES; i++) {
    if (g_slots[i].bytes == NULL && g_slots[i].generation < GEN_MAX) {
      g_slots[i].bytes = OPENSSL_secure_zalloc(KEY_LEN);
      if (g_slots[i].bytes == NULL) return SCC_ERR_SECURE_HEAP;
      g_slots[i].generation++; /* 1..GEN_MAX: no handle is 0, none repeats */
      g_slots[i].approved = approved && g_fips != NULL;
      g_slots[i].usage = usage;
      g_slots[i].fresh = 0;
      *out = g_slots[i].bytes;
      *handle = (g_slots[i].approved ? 0u : NON_APPROVED_BIT) | (g_slots[i].generation << 8) | i;
      return SCC_OK;
    }
  }
  return SCC_ERR_HANDLES;
}

static slot_t *slot_of(uint32_t handle) {
  uint32_t i = handle & 0xff;
  if (i >= MAX_HANDLES) return NULL;
  slot_t *s = &g_slots[i];
  if (s->bytes == NULL || s->generation != ((handle >> 8) & GEN_MAX)) return NULL;
  if ((handle & NON_APPROVED_BIT) != (s->approved ? 0u : NON_APPROVED_BIT)) return NULL;
  return s;
}

static unsigned char *slot_bytes(uint32_t handle) {
  slot_t *s = slot_of(handle);
  return s == NULL ? NULL : s->bytes;
}

static int slot_approved(uint32_t handle) {
  slot_t *s = slot_of(handle);
  return s != NULL && s->approved;
}

static int slot_usage(uint32_t handle) {
  slot_t *s = slot_of(handle);
  return s == NULL ? 0 : s->usage;
}

static int slot_fresh(uint32_t handle) {
  slot_t *s = slot_of(handle);
  return s != NULL && s->fresh;
}

/* A key's first use (a derivation from a master key, a database keyed) ends its freshness for good. */
static void slot_used(uint32_t handle) {
  slot_t *s = slot_of(handle);
  if (s != NULL) s->fresh = 0;
}

/* SCC_ERR_HANDLE for a handle that names no key, SCC_ERR_USAGE for a key used outside its usage. */
static int need_usage(uint32_t handle, int a, int b) {
  int u = slot_usage(handle);
  if (u == 0) return SCC_ERR_HANDLE;
  return u == a || u == b ? SCC_OK : SCC_ERR_USAGE;
}

int scc_key_usage(uint32_t handle) { return slot_usage(handle); }
int scc_approved_keys_required(void) { return g_approved_only; }

int scc_require_approved_keys(void) {
  SERVICE_GATE();
  g_approved_only = 1;
  return SCC_OK;
}

int scc_key_random(uint32_t *handle) {
  SERVICE_GATE();
  return scc_key_random_for(SCC_USE_DATA, handle);
}

/* A password-class key is never random: that class means "reproducible from caller bytes". A random
 * master or database key is fresh: it may be wrapped (once a vault or a device is created) until its
 * first use; a key that was ever unwrapped never is (review C4 M1). */
int scc_key_random_for(int usage, uint32_t *handle) {
  SERVICE_GATE();
  if (usage != SCC_USE_DATA && usage != SCC_USE_MASTER && usage != SCC_USE_DB && usage != SCC_USE_KEK) return SCC_ERR_ARG;
  unsigned char *k;
  int rc = alloc_slot(&k, handle, 1, usage);
  if (rc != SCC_OK) return rc;
  g_slots[*handle & 0xff].fresh = usage == SCC_USE_MASTER || usage == SCC_USE_DB;
  if (RAND_priv_bytes_ex(g_fips_ctx, k, KEY_LEN, 256) != 1) { scc_key_destroy(*handle); return drbg_failed(); }
  return SCC_OK;
}

#ifdef SCC_KAT_BUILD
/* Raw key import exists only in KAT builds (review M3): in the shipped addon every key is created
 * inside the module, so no caller can choose a KEK and unwrap a victim key with it. */
int scc_key_import(const unsigned char *bytes, size_t len, uint32_t *handle) {
  SERVICE_GATE();
  return scc_key_import_for(bytes, len, SCC_USE_DATA, handle);
}

int scc_key_import_for(const unsigned char *bytes, size_t len, int usage, uint32_t *handle) {
  SERVICE_GATE();
  unsigned char *k;
  if (len != KEY_LEN) return SCC_ERR_ARG;
  int rc = alloc_slot(&k, handle, 1, usage);
  if (rc != SCC_OK) return rc;
  memcpy(k, bytes, KEY_LEN);
  return SCC_OK;
}
#endif

int scc_key_destroy(uint32_t handle) {
  unsigned char *k = slot_bytes(handle);
  if (k == NULL) return SCC_ERR_HANDLE;
  OPENSSL_cleanse(k, KEY_LEN);
  OPENSSL_secure_clear_free(k, KEY_LEN);
  g_slots[handle & 0xff].bytes = NULL;
  return SCC_OK;
}

size_t scc_zeroize_all(void) {
  size_t n = 0;
  for (uint32_t i = 0; i < MAX_HANDLES; i++) {
    if (g_slots[i].bytes != NULL) {
      OPENSSL_cleanse(g_slots[i].bytes, KEY_LEN);
      OPENSSL_secure_clear_free(g_slots[i].bytes, KEY_LEN);
      g_slots[i].bytes = NULL;
      n++;
    }
  }
  return n;
}

size_t scc_live_handles(void) {
  size_t n = 0;
  for (uint32_t i = 0; i < MAX_HANDLES; i++) n += g_slots[i].bytes != NULL;
  return n;
}

/* Callable in every init state (audit §4.2, C2 M2): before CRYPTO_secure_malloc_init has run (no init, or an
 * init that failed before it) OpenSSL's secure-heap lock is NULL and CRYPTO_secure_used would dereference it. */
size_t scc_secure_heap_used(void) { return CRYPTO_secure_malloc_initialized() ? CRYPTO_secure_used() : 0; }
int scc_ready(void) { return g_ready && !g_error_state; }
int scc_heap_locked(void) { return g_heap_locked; }
int scc_selftest_failures(void) { return g_selftest_failures; }

typedef struct { char *buf; size_t len, used; } names_t;

static int add_provider_name(OSSL_PROVIDER *prov, void *arg) {
  names_t *n = arg;
  int w = snprintf(n->buf + n->used, n->len - n->used, "%s%s", n->used ? "," : "", OSSL_PROVIDER_get0_name(prov));
  if (w < 0 || (size_t)w >= n->len - n->used) return 0;
  n->used += (size_t)w;
  return 1;
}

/* Criterion 3: the providers active in the default (note-data) context, comma-separated. */
int scc_default_ctx_providers(char *buf, size_t len) {
  names_t n = {buf, len, 0};
  if (g_fips_ctx == NULL || len == 0) return SCC_ERR_STATE;
  buf[0] = '\0';
  return OSSL_PROVIDER_do_all(g_fips_ctx, add_provider_name, &n) ? SCC_OK : SCC_ERR_ARG;
}

/* F-FIPS-08: the module's own name and version, as the loaded provider reports them. */
int scc_fips_module_info(char *name, size_t name_len, char *version, size_t version_len) {
  const char *n = NULL, *v = NULL;
  OSSL_PARAM p[] = {OSSL_PARAM_construct_utf8_ptr(OSSL_PROV_PARAM_NAME, (char **)&n, 0),
                    OSSL_PARAM_construct_utf8_ptr(OSSL_PROV_PARAM_VERSION, (char **)&v, 0), OSSL_PARAM_construct_end()};
  if (g_fips == NULL || name_len == 0 || version_len == 0 || !OSSL_PROVIDER_get_params(g_fips, p) || n == NULL || v == NULL) return SCC_ERR_STATE;
  snprintf(name, name_len, "%s", n);
  snprintf(version, version_len, "%s", v);
  return SCC_OK;
}

/* RFC 5869 HKDF-SHA-256 in the standard context (suite 0x01 only): `ko` receives KEY_LEN bytes. */
static int hkdf_std(const unsigned char *ikm, size_t ikm_len, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, unsigned char *ko) {
  /* An empty Uint8Array reaches here as (NULL, 0), which OpenSSL refuses as a salt; RFC 5869's absent salt
   * (HashLen zero bytes) is what an empty one means, and suite 0x01's subkeys use it. */
  static const unsigned char no_salt[1] = {0};
  EVP_KDF *kdf = EVP_KDF_fetch(g_std_ctx, "HKDF", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-256", 0),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, (void *)ikm, ikm_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)(salt_len == 0 ? no_salt : salt), salt_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)info, info_len),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  return ok;
}

/* Review C9 M1: labels of module-internal keys, which no public KDF may derive: K_hist (derived only inside the
 * history calls). A data key under one of them would open (export) or forge what that key protects. */
static int label_reserved(const char *label, size_t label_len) {
  static const char HIST[] = "slate/v2/history";
  return label_len == sizeof HIST - 1 && memcmp(label, HIST, label_len) == 0;
}

static int is_local_wrap(const char *label, size_t label_len) {
  static const char WRAP[] = "/local-wrap";
  size_t w = sizeof WRAP - 1;
  return label_len >= w && memcmp(label + label_len - w, WRAP, w) == 0;
}

/* What a derivation may produce (review C4 M1): a data key, or, from a master key and for the local-wrap
 * purpose only, a KEK (which wraps database keys and does nothing else). Review C9 M1: a local-wrap label gives
 * that KEK and nothing else (as a data key it would hand database keys out), and a reserved label nothing. */
static int kdf_output_ok(uint32_t key, const char *label, size_t label_len, int usage) {
  if (label_reserved(label, label_len)) return SCC_ERR_USAGE;
  if (usage == SCC_USE_DATA) return is_local_wrap(label, label_len) ? SCC_ERR_USAGE : SCC_OK;
  if (usage != SCC_USE_KEK) return SCC_ERR_ARG;
  if (slot_usage(key) != SCC_USE_MASTER || !is_local_wrap(label, label_len)) return SCC_ERR_USAGE;
  return SCC_OK;
}

/* SP 800-108r1 KDF in counter mode, HMAC-SHA-256, r = 32, L = 256, into `ko` (KEY_LEN bytes), in the FIPS context. */
static int kbkdf_derive(const unsigned char *ki, size_t ki_len, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, unsigned char *ko) {
  EVP_KDF *kdf = EVP_KDF_fetch(g_fips_ctx, "KBKDF", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_MODE, "COUNTER", 0),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_MAC, "HMAC", 0),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-256", 0),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, (void *)ki, ki_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)label, label_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)ctx, ctx_len),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  return ok;
}

/* SP 800-108r1 KDF in counter mode, HMAC-SHA-256, r = 32, L = 256: label = purpose, context = binding. */
int scc_kbkdf(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, uint32_t *out) {
  SERVICE_GATE();
  return scc_kbkdf_for(key, label, label_len, ctx, ctx_len, SCC_USE_DATA, out);
}

int scc_kbkdf_for(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int usage, uint32_t *out) {
  SERVICE_GATE();
  if (!label_ok(label, label_len)) return SCC_ERR_ARG;
  if (ctx_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  int rc = need_usage(key, SCC_USE_MASTER, SCC_USE_DATA);
  if (rc != SCC_OK) return rc;
  rc = kdf_output_ok(key, label, label_len, usage);
  if (rc != SCC_OK) return rc;
  slot_used(key);
  unsigned char *ko;
  rc = alloc_slot(&ko, out, slot_approved(key), usage);
  if (rc != SCC_OK) return rc;
  if (!kbkdf_derive(slot_bytes(key), KEY_LEN, label, label_len, ctx, ctx_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* KBKDF over caller bytes: suite 0x02's recovery and quick-unlock KEKs (audit §4.5.2). Whoever knows the
 * secret can recompute the key, so it is a password-class KEK; the binding cleanses the secret. */
int scc_kbkdf_secret(const unsigned char *secret, size_t len, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int approved, uint32_t *out) {
  SERVICE_GATE();
  if (!label_ok(label, label_len) || secret == NULL || len < 16) return SCC_ERR_ARG;
  if (label_reserved(label, label_len)) return SCC_ERR_USAGE;
  if (len > SCC_MAX_INPUT || ctx_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  unsigned char *ko;
  int rc = alloc_slot(&ko, out, approved != 0, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  if (!kbkdf_derive(secret, len, label, label_len, ctx, ctx_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* RFC 5869 HKDF-SHA-256: legacy suite 0x01 only (vaults created before suite 0x02). Runs in the
 * standard context, so the FIPS context only ever serves the suite-0x02 key schedule. */
int scc_hkdf_legacy(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out) {
  SERVICE_GATE();
  return scc_hkdf_legacy_for(key, salt, salt_len, info, info_len, SCC_USE_DATA, out);
}

int scc_hkdf_legacy_for(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, int usage, uint32_t *out) {
  SERVICE_GATE();
  NOT_AFTER_LATCH();
  if (!label_ok(info, info_len)) return SCC_ERR_ARG;
  if (salt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  int rc = need_usage(key, SCC_USE_MASTER, SCC_USE_DATA);
  if (rc != SCC_OK) return rc;
  rc = kdf_output_ok(key, info, info_len, usage);
  if (rc != SCC_OK) return rc;
  slot_used(key);
  unsigned char *ko;
  rc = alloc_slot(&ko, out, 0, usage); /* RFC 5869 HKDF from a stored key: not approved */
  if (rc != SCC_OK) return rc;
  if (!hkdf_std(slot_bytes(key), KEY_LEN, salt, salt_len, info, info_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* RFC 5869 HKDF-SHA-256 over caller bytes (a recovery or quick-unlock secret, suite 0x01). Whoever knows
 * the bytes can recompute the key, so it is a password-class KEK (C2 review R2), and not approved. */
int scc_hkdf_secret(const unsigned char *secret, size_t len, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out) {
  SERVICE_GATE();
  NOT_AFTER_LATCH();
  if (!label_ok(info, info_len) || secret == NULL || len == 0) return SCC_ERR_ARG;
  if (label_reserved(info, info_len)) return SCC_ERR_USAGE;
  if (len > SCC_MAX_INPUT || salt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  unsigned char *ko;
  int rc = alloc_slot(&ko, out, 0, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  if (!hkdf_std(secret, len, salt, salt_len, info, info_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* A recovery-key character's value in the alphabet 0-9 A-Z without I L O U; lower case is upper case, O is 0,
 * I and L are 1 (vault/recovery.ts encodes with the same alphabet). -1 for anything else. */
static int recovery_digit(unsigned char c) {
  static const char alphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  if (c >= 'a' && c <= 'z') c = (unsigned char)(c - 'a' + 'A');
  if (c == 'O') c = '0';
  if (c == 'I' || c == 'L') c = '1';
  for (int i = 0; i < 32; i++)
    if (alphabet[i] == (char)c) return i;
  return -1;
}

/* How many bytes of `text` at `i` are a separator: '-', or a character JavaScript's \s matches (ASCII
 * whitespace, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) in UTF-8, as
 * the JavaScript decoder this replaces accepted (a key pasted through a word processor has NBSPs). 0 for
 * anything else. */
static size_t recovery_separator(const unsigned char *t, size_t i, size_t len) {
  unsigned char c = t[i];
  if (c == ' ' || c == '-' || (c >= 0x09 && c <= 0x0d)) return 1;
  if (c == 0xc2 && i + 1 < len && t[i + 1] == 0xa0) return 2;
  if (i + 2 >= len) return 0;
  unsigned char b = t[i + 1], d = t[i + 2];
  if (c == 0xe1 && b == 0x9a && d == 0x80) return 3;
  if (c == 0xe2 && b == 0x80 && ((d >= 0x80 && d <= 0x8a) || d == 0xa8 || d == 0xa9 || d == 0xaf)) return 3;
  if (c == 0xe2 && b == 0x81 && d == 0x9f) return 3;
  if (c == 0xe3 && b == 0x80 && d == 0x80) return 3;
  if (c == 0xef && b == 0xbb && d == 0xbf) return 3;
  return 0;
}

/* C7: the typed recovery key, decoded here so its 32 bytes never reach JavaScript. The text is 52 base32
 * characters (256 bits and 4 zero bits) and 4 characters of SHA-256(key)'s first 20 bits; whitespace and
 * dashes are ignored. Every bad text is SCC_ERR_ARG. The result is a RECOVERY handle; every temporary is
 * cleansed on every path (the binding cleanses `text`). */
int scc_recovery_decode(const unsigned char *text, size_t len, uint32_t *out) {
  SERVICE_GATE();
  enum { DATA_CHARS = 52, CHECK_CHARS = 4 };
  unsigned char digits[DATA_CHARS + CHECK_CHARS], key[KEY_LEN], digest[32];
  uint32_t acc = 0, check = 0, diff = 0, d0 = 0, d1 = 0, d2 = 0;
  unsigned int bits = 0;
  unsigned char *ko = NULL;
  size_t n = 0, k = 0;
  int rc = SCC_ERR_ARG;
  if (text == NULL || len > SCC_RECOVERY_MAX_TEXT) goto done;
  for (size_t i = 0; i < len;) {
    size_t skip = recovery_separator(text, i, len);
    if (skip > 0) {
      i += skip;
      continue;
    }
    int v = recovery_digit(text[i++]);
    if (v < 0 || n == sizeof digits) goto done;
    digits[n++] = (unsigned char)v;
  }
  if (n != sizeof digits) goto done;
  for (size_t i = 0; i < DATA_CHARS; i++) {
    acc = (acc << 5) | digits[i];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key[k++] = (unsigned char)(acc >> bits);
      acc &= (1u << bits) - 1u;
    }
  }
  if (k != KEY_LEN || acc != 0) goto done; /* the 4 padding bits are zero */
  rc = scc_sha256(key, KEY_LEN, digest);
  if (rc != SCC_OK) goto done;
  d0 = digest[0];
  d1 = digest[1];
  d2 = digest[2];
  check = (d0 << 12) | (d1 << 4) | (d2 >> 4);
  for (unsigned int i = 0; i < CHECK_CHARS; i++) diff |= digits[DATA_CHARS + i] ^ ((check >> (15u - 5u * i)) & 31u);
  if (diff != 0) { rc = SCC_ERR_ARG; goto done; }
  rc = alloc_slot(&ko, out, 0, SCC_USE_RECOVERY); /* a KEK from it is HKDF over caller bytes: not approved */
  if (rc == SCC_OK) memcpy(ko, key, KEY_LEN);
done:
  OPENSSL_cleanse(digits, sizeof digits);
  OPENSSL_cleanse(key, sizeof key);
  OPENSSL_cleanse(digest, sizeof digest);
  OPENSSL_cleanse(&acc, sizeof acc);
  OPENSSL_cleanse(&check, sizeof check);
  OPENSSL_cleanse(&diff, sizeof diff);
  OPENSSL_cleanse(&d0, sizeof d0);
  OPENSSL_cleanse(&d1, sizeof d1);
  OPENSSL_cleanse(&d2, sizeof d2);
  return rc;
}

/* KEK_rc from a RECOVERY handle: the same RFC 5869 derivation as scc_hkdf_secret over the secret's bytes. */
int scc_hkdf_recovery(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out) {
  SERVICE_GATE();
  NOT_AFTER_LATCH();
  if (!label_ok(info, info_len)) return SCC_ERR_ARG;
  if (label_reserved(info, info_len)) return SCC_ERR_USAGE;
  if (salt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  int rc = need_usage(key, SCC_USE_RECOVERY, SCC_USE_RECOVERY);
  if (rc != SCC_OK) return rc;
  unsigned char *ko;
  rc = alloc_slot(&ko, out, 0, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  if (!hkdf_std(slot_bytes(key), KEY_LEN, salt, salt_len, info, info_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* KEK_rc of suite 0x02 from a typed recovery key decoded in the module (C7): KBKDF over the handle's bytes,
 * the same derivation as scc_kbkdf_secret, so the 32-byte secret never reaches JavaScript. */
int scc_kbkdf_recovery(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int approved, uint32_t *out) {
  SERVICE_GATE();
  if (!label_ok(label, label_len)) return SCC_ERR_ARG;
  if (label_reserved(label, label_len)) return SCC_ERR_USAGE;
  if (ctx_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  int rc = need_usage(key, SCC_USE_RECOVERY, SCC_USE_RECOVERY);
  if (rc != SCC_OK) return rc;
  unsigned char *ko;
  rc = alloc_slot(&ko, out, approved != 0, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  if (!kbkdf_derive(slot_bytes(key), KEY_LEN, label, label_len, ctx, ctx_len, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* SP 800-132 PBKDF2-HMAC-SHA-512 into `ko` (KEY_LEN bytes), in the FIPS context. */
static int pbkdf2_derive(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, unsigned char *ko) {
  EVP_KDF *kdf = EVP_KDF_fetch(g_fips_ctx, "PBKDF2", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void *)pw, pw_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, salt_len),
      OSSL_PARAM_construct_uint64(OSSL_KDF_PARAM_ITER, &iter),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-512", 0),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  return ok;
}

/* SP 800-132 PBKDF2-HMAC-SHA-512 (fips-140-3 profile). The password buffer is cleansed by the caller. */
int scc_pbkdf2(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, uint32_t *out) {
  SERVICE_GATE();
  if (iter < SCC_PBKDF2_MIN_ITER || iter > SCC_PBKDF2_MAX_ITER) return SCC_ERR_ARG;
  if (pw_len > SCC_MAX_INPUT || salt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  unsigned char *ko;
  int rc = alloc_slot(&ko, out, 1, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  if (!pbkdf2_derive(pw, pw_len, salt, salt_len, iter, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

#define PBKDF2_PROBE_ITER 50000u

static int64_t monotonic_ns(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) != 0) return -1;
  return (int64_t)t.tv_sec * 1000000000 + (int64_t)t.tv_nsec;
}

/* Times a PBKDF2 probe over random bytes into a secure-heap buffer (cleansed, no handle), then scales it to
 * `target_ms` and clamps it to the fips-140-3 range: a slow machine gets the floor, a fast one at most the
 * ceiling the header parser accepts. */
int scc_pbkdf2_calibrate(uint32_t target_ms, uint64_t *iterations) {
  SERVICE_GATE();
  if (target_ms < 100 || target_ms > 10000) return SCC_ERR_ARG;
  unsigned char pw[16], salt[32];
  unsigned char *ko = OPENSSL_secure_zalloc(KEY_LEN);
  if (ko == NULL) return SCC_ERR_SECURE_HEAP;
  if (RAND_bytes_ex(g_fips_ctx, pw, sizeof pw, 128) != 1 || RAND_bytes_ex(g_fips_ctx, salt, sizeof salt, 128) != 1) {
    OPENSSL_secure_clear_free(ko, KEY_LEN);
    return drbg_failed();
  }
  int64_t t0 = monotonic_ns();
  int ok = pbkdf2_derive(pw, sizeof pw, salt, sizeof salt, PBKDF2_PROBE_ITER, ko);
  int64_t t1 = monotonic_ns();
  OPENSSL_cleanse(pw, sizeof pw);
  OPENSSL_secure_clear_free(ko, KEY_LEN);
  if (!ok || t0 < 0 || t1 < 0) return SCC_ERR_CRYPTO;
  uint64_t elapsed = t1 > t0 ? (uint64_t)(t1 - t0) : 1u;
  uint64_t n = (uint64_t)PBKDF2_PROBE_ITER * target_ms * 1000000u / elapsed;
  *iterations = n < SCC_PBKDF2_FIPS_MIN_ITER ? SCC_PBKDF2_FIPS_MIN_ITER : n > SCC_PBKDF2_MAX_ITER ? SCC_PBKDF2_MAX_ITER : n;
  return SCC_OK;
}

static int argon2_cost_ok(uint32_t memory_kib, uint32_t passes) {
  return memory_kib >= SCC_ARGON2_MIN_KIB && memory_kib <= SCC_ARGON2_MAX_KIB && passes >= SCC_ARGON2_MIN_PASSES && passes <= SCC_ARGON2_MAX_PASSES;
}

/* RFC 9106 Argon2id into `ko` (KEY_LEN bytes): standard profile only, non-approved, in g_std_ctx (never
 * g_fips_ctx). Touches no handle, so a job may run it on another thread. */
static int argon2_derive(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, unsigned char *ko) {
  uint32_t lanes = 1, threads = 1;
  EVP_KDF *kdf = EVP_KDF_fetch(g_std_ctx, "ARGON2ID", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void *)pw, pw_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, salt_len),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ITER, &passes),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_MEMCOST, &memory_kib),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_LANES, &lanes),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_THREADS, &threads),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  return ok;
}

int scc_argon2id(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, uint32_t *out) {
  SERVICE_GATE();
  NOT_AFTER_LATCH();
  if (!argon2_cost_ok(memory_kib, passes)) return SCC_ERR_ARG;
  if (pw_len > SCC_MAX_INPUT || salt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  unsigned char *ko;
  int rc = alloc_slot(&ko, out, 0, SCC_USE_PASSWORD); /* Argon2id is not an approved function */
  if (rc != SCC_OK) return rc;
  if (!argon2_derive(pw, pw_len, salt, salt_len, memory_kib, passes, ko)) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

#define ARGON2_MAX_SALT 64u

struct scc_argon2_job {
  unsigned char *pw;      /* secure heap, max(pw_len, 1) bytes */
  size_t pw_len;
  unsigned char salt[ARGON2_MAX_SALT];
  size_t salt_len;
  uint32_t memory_kib, passes;
  int pbkdf2;             /* a PBKDF2-HMAC-SHA-512 job (fips-140-3, review C5 L1); Argon2id otherwise */
  uint64_t iter;
  unsigned char *derived; /* secure heap, KEY_LEN bytes */
  int rc;                 /* of run; SCC_ERR_STATE until it ran */
};

static size_t job_pw_alloc(size_t pw_len) { return pw_len == 0 ? 1 : pw_len; }

int scc_argon2id_job_new(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, scc_argon2_job **job) {
  SERVICE_GATE();
  *job = NULL;
  NOT_AFTER_LATCH();
  if (!argon2_cost_ok(memory_kib, passes) || salt_len > ARGON2_MAX_SALT) return SCC_ERR_ARG;
  if (pw_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  scc_argon2_job *j = OPENSSL_zalloc(sizeof *j);
  if (j == NULL) return SCC_ERR_SECURE_HEAP;
  j->pw_len = pw_len;
  j->pw = OPENSSL_secure_zalloc(job_pw_alloc(pw_len));
  j->derived = OPENSSL_secure_zalloc(KEY_LEN);
  if (j->pw == NULL || j->derived == NULL) {
    scc_argon2id_job_free(j);
    return SCC_ERR_SECURE_HEAP;
  }
  if (pw_len > 0) memcpy(j->pw, pw, pw_len);
  if (salt_len > 0) memcpy(j->salt, salt, salt_len);
  j->salt_len = salt_len;
  j->memory_kib = memory_kib;
  j->passes = passes;
  j->rc = SCC_ERR_STATE;
  *job = j;
  return SCC_OK;
}

/* PBKDF2 as the same kind of job (review C5 L1): a count of up to 10^7, chosen by a header that is not yet
 * verified, must not stall the main thread. Approved, in the FIPS context; the latch does not refuse it. */
int scc_pbkdf2_job_new(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, scc_argon2_job **job) {
  SERVICE_GATE();
  *job = NULL;
  if (iter < SCC_PBKDF2_MIN_ITER || iter > SCC_PBKDF2_MAX_ITER || salt_len > ARGON2_MAX_SALT) return SCC_ERR_ARG;
  if (pw_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  scc_argon2_job *j = OPENSSL_zalloc(sizeof *j);
  if (j == NULL) return SCC_ERR_SECURE_HEAP;
  j->pw_len = pw_len;
  j->pw = OPENSSL_secure_zalloc(job_pw_alloc(pw_len));
  j->derived = OPENSSL_secure_zalloc(KEY_LEN);
  if (j->pw == NULL || j->derived == NULL) {
    scc_argon2id_job_free(j);
    return SCC_ERR_SECURE_HEAP;
  }
  if (pw_len > 0) memcpy(j->pw, pw, pw_len);
  if (salt_len > 0) memcpy(j->salt, salt, salt_len);
  j->salt_len = salt_len;
  j->pbkdf2 = 1;
  j->iter = iter;
  j->rc = SCC_ERR_STATE;
  *job = j;
  return SCC_OK;
}

/* Any thread: no handle and no slot table. The password copy is wiped as soon as the derivation ends. */
/* Runs on a libuv thread (review C4 L2): it reads the error and ready flags only. The full gate (which
 * consults the provider and may latch the error state, zeroizing the slot table) runs on the main thread
 * in scc_argon2id_job_new and scc_argon2id_job_finish, before and after. */
int scc_argon2id_job_run(scc_argon2_job *job) {
  if (atomic_load(&g_error_state) || !atomic_load(&g_ready)) {
    job->rc = SCC_ERR_ERROR_STATE;
    OPENSSL_cleanse(job->pw, job_pw_alloc(job->pw_len));
    return job->rc;
  }
  int ok = job->pbkdf2 ? pbkdf2_derive(job->pw, job->pw_len, job->salt, job->salt_len, job->iter, job->derived)
                       : argon2_derive(job->pw, job->pw_len, job->salt, job->salt_len, job->memory_kib, job->passes, job->derived);
  job->rc = ok ? SCC_OK : SCC_ERR_CRYPTO;
  OPENSSL_cleanse(job->pw, job_pw_alloc(job->pw_len));
  return job->rc;
}

/* Main thread: the derived key moves into a password-class handle (approved for PBKDF2, not for Argon2id). */
int scc_argon2id_job_finish(scc_argon2_job *job, uint32_t *out) {
  SERVICE_GATE();
  if (!job->pbkdf2 && g_approved_only) return SCC_ERR_NOT_APPROVED;
  if (job->rc != SCC_OK) return job->rc;
  unsigned char *ko;
  int rc = alloc_slot(&ko, out, job->pbkdf2, SCC_USE_PASSWORD);
  if (rc != SCC_OK) return rc;
  memcpy(ko, job->derived, KEY_LEN);
  OPENSSL_cleanse(job->derived, KEY_LEN);
  return SCC_OK;
}

/* Always callable, also in the error state: it only wipes and frees. */
void scc_argon2id_job_free(scc_argon2_job *job) {
  if (job == NULL) return;
  if (job->pw != NULL) OPENSSL_secure_clear_free(job->pw, job_pw_alloc(job->pw_len));
  if (job->derived != NULL) OPENSSL_secure_clear_free(job->derived, KEY_LEN);
  OPENSSL_clear_free(job, sizeof *job);
}

/* AES-256-GCM, 96-bit IV, 128-bit tag. iv == NULL: a fresh IV from the module DRBG (IG C.H). */
/* AES-256-GCM encryption under `iv` (12 bytes), the IV policy already applied by the caller. */
static int gcm_encrypt(const unsigned char *k, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                       const unsigned char *pt, size_t pt_len, unsigned char *ct_tag) {
  int aad_n, pt_n;
  if (!int_len(aad_len, &aad_n) || !int_len(pt_len, &pt_n)) return SCC_ERR_TOO_LARGE;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-GCM", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_EncryptInit_ex2(x, c, k, iv, NULL) == 1 &&
                    (aad_n == 0 || EVP_EncryptUpdate(x, NULL, &len, aad, aad_n) == 1) &&
                    EVP_EncryptUpdate(x, ct_tag, &len, pt, pt_n) == 1 && len == pt_n &&
                    EVP_EncryptFinal_ex(x, ct_tag + pt_len, &len) == 1 &&
                    EVP_CIPHER_CTX_ctrl(x, EVP_CTRL_GCM_GET_TAG, 16, ct_tag + pt_len) == 1;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

static int gcm_seal_with(const unsigned char *k, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len,
                         const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag) {
  if (aad_len > SCC_MAX_INPUT || pt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
#ifndef SCC_KAT_BUILD
  /* IG C.H (review N7): in approved mode the GCM IV comes from the module's DRBG. Known-answer tests,
   * which need a fixed IV, exist only in KAT builds. */
  if (iv_in != NULL && g_fips != NULL) return SCC_ERR_NOT_APPROVED;
#endif
  if (iv_in != NULL) memcpy(iv_out, iv_in, 12);
  else if (RAND_bytes_ex(g_fips_ctx, iv_out, 12, 128) != 1) return drbg_failed();
  return gcm_encrypt(k, iv_out, aad, aad_len, pt, pt_len, ct_tag);
}

int scc_gcm_seal(uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len,
                 const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag) {
  SERVICE_GATE();
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  return rc != SCC_OK ? rc : gcm_seal_with(slot_bytes(key), iv_in, aad, aad_len, pt, pt_len, iv_out, ct_tag);
}

/* GCM for a format whose AAD holds its own nonce (the SLE envelopes authenticate their header, nonce
 * included): the module draws the IV from its DRBG, writes it into its own copy of `aad` at `iv_offset`
 * and seals under it. The caller's 12 bytes at that offset are ignored. IG C.H holds: the IV never comes
 * from the caller. */
int scc_gcm_seal_iv_in_aad(uint32_t key, const unsigned char *aad, size_t aad_len, size_t iv_offset,
                           const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag) {
  SERVICE_GATE();
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  if (rc != SCC_OK) return rc;
  if (aad_len > SCC_MAX_INPUT || pt_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  if (iv_offset > aad_len || aad_len - iv_offset < 12) return SCC_ERR_ARG;
  unsigned char *a = OPENSSL_malloc(aad_len);
  if (a == NULL) return SCC_ERR_CRYPTO;
  memcpy(a, aad, aad_len);
  if (RAND_bytes_ex(g_fips_ctx, iv_out, 12, 128) != 1) {
    OPENSSL_free(a);
    return drbg_failed();
  }
  memcpy(a + iv_offset, iv_out, 12);
  rc = gcm_encrypt(slot_bytes(key), iv_out, a, aad_len, pt, pt_len, ct_tag);
  OPENSSL_free(a);
  return rc;
}

static int gcm_open_with(const unsigned char *k, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                         const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *pt) {
  if (ct_tag_len < 16) return SCC_ERR_AUTH;
  size_t ct_len = ct_tag_len - 16;
  int aad_n, ct_n;
  if (!int_len(aad_len, &aad_n) || !int_len(ct_len, &ct_n)) return SCC_ERR_TOO_LARGE;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-GCM", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_DecryptInit_ex2(x, c, k, iv, NULL) == 1 &&
                    (aad_n == 0 || EVP_DecryptUpdate(x, NULL, &len, aad, aad_n) == 1) &&
                    EVP_DecryptUpdate(x, pt, &len, ct_tag, ct_n) == 1 && len == ct_n &&
                    EVP_CIPHER_CTX_ctrl(x, EVP_CTRL_GCM_SET_TAG, 16, (void *)(ct_tag + ct_len)) == 1 &&
                    EVP_DecryptFinal_ex(x, pt + ct_len, &len) == 1;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  if (!ok) OPENSSL_cleanse(pt, ct_len); /* never release unauthenticated plaintext */
  return ok ? SCC_OK : SCC_ERR_AUTH;
}

int scc_gcm_open(uint32_t key, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                 const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *pt) {
  SERVICE_GATE();
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  return rc != SCC_OK ? rc : gcm_open_with(slot_bytes(key), iv, aad, aad_len, ct_tag, ct_tag_len, pt);
}

/* Which keys a KEK may wrap or unwrap (C4, review C4 M1): a password-class KEK only a master key, a KEK
 * only a database key. A data key wraps and unwraps nothing: what it decrypts is data, handed to the
 * caller, so a key wrapped under it would be a key exported. */
static int wrap_allowed(int kek_usage, int key_usage) {
  if (kek_usage == SCC_USE_PASSWORD) return key_usage == SCC_USE_MASTER;
  if (kek_usage == SCC_USE_KEK) return key_usage == SCC_USE_DB;
  return 0;
}

/* Unwraps a 32-byte key straight into the secure heap: the plaintext key never reaches JavaScript. An
 * unwrapped key is as approved as its KEK, and never fresh: it can be used, not wrapped again. */
int scc_gcm_open_key_for(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                         const unsigned char *ct_tag, size_t ct_tag_len, int usage, uint32_t *out) {
  SERVICE_GATE();
  unsigned char *k;
  int ku = slot_usage(kek);
  if (ku == 0) return SCC_ERR_HANDLE;
  if (!wrap_allowed(ku, usage)) return SCC_ERR_USAGE;
  if (ct_tag_len != KEY_LEN + 16) return SCC_ERR_AUTH;
  int rc = alloc_slot(&k, out, slot_approved(kek), usage);
  if (rc != SCC_OK) return rc;
  rc = gcm_open_with(slot_bytes(kek), iv, aad, aad_len, ct_tag, ct_tag_len, k);
  if (rc != SCC_OK) scc_key_destroy(*out);
  return rc;
}

/* What a password-class KEK unwraps is a master key; what a KEK unwraps is a database key. */
int scc_gcm_open_key(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                     const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out) {
  SERVICE_GATE();
  int ku = slot_usage(kek);
  int usage = ku == SCC_USE_PASSWORD ? SCC_USE_MASTER : ku == SCC_USE_KEK ? SCC_USE_DB : 0;
  if (ku == 0) return SCC_ERR_HANDLE;
  if (usage == 0) return SCC_ERR_USAGE;
  return scc_gcm_open_key_for(kek, iv, aad, aad_len, ct_tag, ct_tag_len, usage, out);
}

/* A wrap of a key from a non-approved source under an approved KEK would come back approved (review C4 M1). */
static int approval_kept(uint32_t kek, int key_approved) {
  return !slot_approved(kek) || key_approved ? SCC_OK : SCC_ERR_NOT_APPROVED;
}

int scc_gcm_seal_key(uint32_t kek, uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len,
                     unsigned char *iv_out, unsigned char *ct_tag) {
  SERVICE_GATE();
  if (kek == key) return SCC_ERR_ARG; /* a key wrapped under itself is a key published in plaintext */
  int ku = slot_usage(kek), wu = slot_usage(key);
  if (ku == 0 || wu == 0) return SCC_ERR_HANDLE;
  /* Reviews C2 R2 and C4 M1: only a fresh key is wrapped, so no key already in use (a vault's master key,
   * a device's database key) can be wrapped under a KEK whose bytes the caller can reproduce. */
  if (!wrap_allowed(ku, wu) || !slot_fresh(key)) return SCC_ERR_USAGE;
  int rc = approval_kept(kek, slot_approved(key));
  if (rc != SCC_OK) return rc;
  return gcm_seal_with(slot_bytes(kek), iv_in, aad, aad_len, slot_bytes(key), KEY_LEN, iv_out, ct_tag);
}

/* Moves a master key's wrap from one password-class KEK to another (a new password, a new recovery key,
 * quick unlock): the key is unwrapped into the secure heap, rewrapped under a fresh module IV and cleansed.
 * No handle and no byte of it leaves this call, and the old KEK means the old secret. A database key is never
 * moved (review C4 M1-R, closed in C5): its KEK comes from the MK handle alone, so a move would hand LK to any
 * KEK the caller can compute. A device joining another vault makes a fresh LK and re-encrypts a copy. */
int scc_rewrap_key(uint32_t old_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                   uint32_t new_kek, const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out) {
  SERVICE_GATE();
  int ou = slot_usage(old_kek), nu = slot_usage(new_kek);
  if (ou == 0 || nu == 0) return SCC_ERR_HANDLE;
  if (ou != SCC_USE_PASSWORD || nu != SCC_USE_PASSWORD) return SCC_ERR_USAGE;
  if (ct_tag_len != KEY_LEN + 16) return SCC_ERR_AUTH;
  int rc = approval_kept(new_kek, slot_approved(old_kek));
  if (rc != SCC_OK) return rc;
  unsigned char *k = OPENSSL_secure_zalloc(KEY_LEN);
  if (k == NULL) return SCC_ERR_SECURE_HEAP;
  rc = gcm_open_with(slot_bytes(old_kek), iv, aad, aad_len, ct_tag, ct_tag_len, k);
  if (rc == SCC_OK) rc = gcm_seal_with(slot_bytes(new_kek), NULL, new_aad, new_aad_len, k, KEY_LEN, iv_out, ct_out);
  OPENSSL_secure_clear_free(k, KEY_LEN);
  return rc;
}

/* C9: the history KEK's purpose; K_hist is derived inside each call and cleansed before it returns. */
static const char HISTORY_LABEL[] = "slate/v2/history";
#define HISTORY_CTX_LEN 20 /* vid (16) || uint32be(epoch) */

/* MK from a proof: the wrap of a master key under a password-class KEK that opens it, into `k` (secure heap). */
static int open_proof(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                      unsigned char *k) {
  int ku = slot_usage(kek);
  if (ku == 0) return SCC_ERR_HANDLE;
  if (ku != SCC_USE_PASSWORD) return SCC_ERR_USAGE;
  if (ct_tag_len != KEY_LEN + 16 || aad_len > SCC_MAX_INPUT) return SCC_ERR_AUTH;
  return gcm_open_with(slot_bytes(kek), iv, aad, aad_len, ct_tag, ct_tag_len, k);
}

/* `key` (KEY_LEN bytes) sealed under KBKDF(mk_new, HISTORY_LABEL, ctx), with a fresh module IV. */
static int history_seal_bytes(const unsigned char *key, int key_approved, uint32_t mk_new, const unsigned char *ctx, size_t ctx_len,
                              const unsigned char *aad, size_t aad_len, unsigned char *iv_out, unsigned char *ct_out) {
  if (ctx_len != HISTORY_CTX_LEN || aad_len > SCC_MAX_INPUT) return SCC_ERR_ARG;
  int rc = need_usage(mk_new, SCC_USE_MASTER, SCC_USE_MASTER);
  if (rc != SCC_OK) return rc;
  if (CRYPTO_memcmp(slot_bytes(mk_new), key, KEY_LEN) == 0) return SCC_ERR_ARG; /* never a key into its own history */
  rc = approval_kept(mk_new, key_approved);
  if (rc != SCC_OK) return rc;
  unsigned char *kh = OPENSSL_secure_zalloc(KEY_LEN);
  if (kh == NULL) return SCC_ERR_SECURE_HEAP;
  slot_used(mk_new);
  rc = kbkdf_derive(slot_bytes(mk_new), KEY_LEN, HISTORY_LABEL, sizeof HISTORY_LABEL - 1, ctx, ctx_len, kh) ? SCC_OK : SCC_ERR_CRYPTO;
  if (rc == SCC_OK) rc = gcm_seal_with(kh, NULL, aad, aad_len, key, KEY_LEN, iv_out, ct_out);
  OPENSSL_secure_clear_free(kh, KEY_LEN);
  return rc;
}

/* An entry under KBKDF(mk_bytes, HISTORY_LABEL, ctx) opened into `k`. */
static int history_open_bytes(const unsigned char *mk_bytes, const unsigned char *ctx, size_t ctx_len, const unsigned char *iv,
                              const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *k) {
  if (ctx_len != HISTORY_CTX_LEN) return SCC_ERR_ARG;
  if (ct_tag_len != KEY_LEN + 16 || aad_len > SCC_MAX_INPUT) return SCC_ERR_AUTH;
  unsigned char *kh = OPENSSL_secure_zalloc(KEY_LEN);
  if (kh == NULL) return SCC_ERR_SECURE_HEAP;
  int rc = kbkdf_derive(mk_bytes, KEY_LEN, HISTORY_LABEL, sizeof HISTORY_LABEL - 1, ctx, ctx_len, kh) ? SCC_OK : SCC_ERR_CRYPTO;
  if (rc == SCC_OK) rc = gcm_open_with(kh, iv, aad, aad_len, ct_tag, ct_tag_len, k);
  OPENSSL_secure_clear_free(kh, KEY_LEN);
  return rc;
}

int scc_history_seal(uint32_t proof_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                     uint32_t mk_new, const unsigned char *ctx, size_t ctx_len, const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out) {
  SERVICE_GATE();
  if (slot_usage(mk_new) == 0) return SCC_ERR_HANDLE;
  unsigned char *k = OPENSSL_secure_zalloc(KEY_LEN);
  if (k == NULL) return SCC_ERR_SECURE_HEAP;
  int rc = open_proof(proof_kek, iv, aad, aad_len, ct_tag, ct_tag_len, k);
  /* The moved key is as approved as the KEK it came from, exactly as gcm_open_key would hand it out. */
  if (rc == SCC_OK) rc = history_seal_bytes(k, slot_approved(proof_kek), mk_new, ctx, ctx_len, new_aad, new_aad_len, iv_out, ct_out);
  OPENSSL_secure_clear_free(k, KEY_LEN);
  return rc;
}

int scc_history_rewrap(uint32_t proof_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                       const unsigned char *ctx_cur, size_t ctx_cur_len, const unsigned char *e_iv, const unsigned char *e_aad, size_t e_aad_len,
                       const unsigned char *e_ct, size_t e_ct_len, uint32_t mk_new, const unsigned char *ctx_new, size_t ctx_new_len,
                       const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out) {
  SERVICE_GATE();
  if (slot_usage(mk_new) == 0) return SCC_ERR_HANDLE;
  unsigned char *cur = OPENSSL_secure_zalloc(KEY_LEN), *k = OPENSSL_secure_zalloc(KEY_LEN);
  int rc = cur == NULL || k == NULL ? SCC_ERR_SECURE_HEAP : open_proof(proof_kek, iv, aad, aad_len, ct_tag, ct_tag_len, cur);
  if (rc == SCC_OK) rc = history_open_bytes(cur, ctx_cur, ctx_cur_len, e_iv, e_aad, e_aad_len, e_ct, e_ct_len, k);
  /* The entry was sealed only under a K_hist at least as approved as itself, and that K_hist is the proof's MK's. */
  if (rc == SCC_OK) rc = history_seal_bytes(k, slot_approved(proof_kek), mk_new, ctx_new, ctx_new_len, new_aad, new_aad_len, iv_out, ct_out);
  if (cur != NULL) OPENSSL_secure_clear_free(cur, KEY_LEN);
  if (k != NULL) OPENSSL_secure_clear_free(k, KEY_LEN);
  return rc;
}

int scc_history_open(uint32_t mk, const unsigned char *ctx, size_t ctx_len, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                     const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out) {
  SERVICE_GATE();
  int rc = need_usage(mk, SCC_USE_MASTER, SCC_USE_MASTER);
  if (rc != SCC_OK) return rc;
  if (ctx_len != HISTORY_CTX_LEN) return SCC_ERR_ARG;
  slot_used(mk);
  unsigned char *k;
  rc = alloc_slot(&k, out, slot_approved(mk), SCC_USE_MASTER);
  if (rc != SCC_OK) return rc;
  rc = history_open_bytes(slot_bytes(mk), ctx, ctx_len, iv, aad, aad_len, ct_tag, ct_tag_len, k);
  if (rc != SCC_OK) scc_key_destroy(*out);
  return rc;
}

/* HMAC-SHA-256 under `k` (KEY_LEN bytes), in the FIPS context. */
static int hmac_with(const unsigned char *k, const unsigned char *data, size_t len, unsigned char out[32]) {
  size_t out_len = 0;
  EVP_MAC *mac = EVP_MAC_fetch(g_fips_ctx, "HMAC", NULL);
  EVP_MAC_CTX *m = mac ? EVP_MAC_CTX_new(mac) : NULL;
  OSSL_PARAM p[] = {OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, "SHA2-256", 0), OSSL_PARAM_construct_end()};
  int ok = m != NULL && EVP_MAC_init(m, k, KEY_LEN, p) == 1 && EVP_MAC_update(m, data, len) == 1 &&
           EVP_MAC_final(m, out, &out_len, 32) == 1 && out_len == 32;
  EVP_MAC_CTX_free(m);
  EVP_MAC_free(mac);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

int scc_hmac_sha256(uint32_t key, const unsigned char *data, size_t len, unsigned char out[32]) {
  SERVICE_GATE();
  if (len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  return rc != SCC_OK ? rc : hmac_with(slot_bytes(key), data, len, out);
}

/* One AES-256 block, no padding: the remote-name PRP (§15 N1). */
int scc_aes_ecb_block(uint32_t key, const unsigned char in[16], int encrypt, unsigned char out[16]) {
  SERVICE_GATE();
  NOT_AFTER_LATCH();
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  if (rc != SCC_OK) return rc;
  unsigned char *k = slot_bytes(key);
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-ECB", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_CipherInit_ex2(x, c, k, NULL, encrypt, NULL) == 1 &&
                    EVP_CIPHER_CTX_set_padding(x, 0) == 1 && EVP_CipherUpdate(x, out, &len, in, 16) == 1 && len == 16;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

/* AES-256-CTR (SP 800-38A) with a caller-chosen initial counter block: the suite-0x02 name SIV. */
/* AES-256-CTR under `k` from the initial counter block `icb`, in the FIPS context. */
static int ctr_with(const unsigned char *k, const unsigned char icb[16], const unsigned char *in, size_t len, unsigned char *out) {
  int in_n;
  if (!int_len(len, &in_n)) return SCC_ERR_TOO_LARGE;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-CTR", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int n = 0, ok = c != NULL && x != NULL && EVP_EncryptInit_ex2(x, c, k, icb, NULL) == 1 &&
                  EVP_EncryptUpdate(x, out, &n, in, in_n) == 1 && n == in_n;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

int scc_aes_ctr(uint32_t key, const unsigned char icb[16], const unsigned char *in, size_t len, unsigned char *out) {
  SERVICE_GATE();
  int rc = need_usage(key, SCC_USE_DATA, SCC_USE_DATA);
  return rc != SCC_OK ? rc : ctr_with(slot_bytes(key), icb, in, len, out);
}

/* "slate-name/v2" 0x00 || p (audit §4.6): the SIV's domain-separated input. */
static int name_siv(const unsigned char *mac_key, const unsigned char p[16], unsigned char siv[16]) {
  static const unsigned char DOMAIN[14] = {'s', 'l', 'a', 't', 'e', '-', 'n', 'a', 'm', 'e', '/', 'v', '2', 0};
  unsigned char msg[sizeof DOMAIN + 16], mac[32];
  memcpy(msg, DOMAIN, sizeof DOMAIN);
  memcpy(msg + sizeof DOMAIN, p, 16);
  int rc = hmac_with(mac_key, msg, sizeof msg, mac);
  if (rc == SCC_OK) memcpy(siv, mac, 16);
  OPENSSL_cleanse(msg, sizeof msg);
  OPENSSL_cleanse(mac, sizeof mac);
  return rc;
}

/* Both name keys are distinct data keys: the SIV's MAC key never doubles as the CTR key. */
static int name_keys_ok(uint32_t enc, uint32_t mac) {
  int rc = need_usage(enc, SCC_USE_DATA, SCC_USE_DATA);
  if (rc == SCC_OK) rc = need_usage(mac, SCC_USE_DATA, SCC_USE_DATA);
  if (rc == SCC_OK && enc == mac) rc = SCC_ERR_ARG;
  return rc;
}

/* Suite 0x02 remote names: deterministic (the inputs are unique uuids), reversible and authenticated. */
int scc_name_siv_encode(uint32_t enc, uint32_t mac, const unsigned char p[16], unsigned char out[32]) {
  SERVICE_GATE();
  int rc = name_keys_ok(enc, mac);
  if (rc != SCC_OK) return rc;
  rc = name_siv(slot_bytes(mac), p, out);
  return rc != SCC_OK ? rc : ctr_with(slot_bytes(enc), out, p, 16, out + 16);
}

/* A name that is not ours fails the SIV (probability 1 - 2^-128) and releases nothing. */
int scc_name_siv_decode(uint32_t enc, uint32_t mac, const unsigned char in[32], unsigned char p_out[16]) {
  SERVICE_GATE();
  int rc = name_keys_ok(enc, mac);
  if (rc != SCC_OK) return rc;
  unsigned char want[16];
  rc = ctr_with(slot_bytes(enc), in, in + 16, 16, p_out);
  if (rc == SCC_OK) rc = name_siv(slot_bytes(mac), p_out, want);
  if (rc == SCC_OK && CRYPTO_memcmp(want, in, 16) != 0) rc = SCC_ERR_AUTH;
  if (rc != SCC_OK) OPENSSL_cleanse(p_out, 16);
  OPENSSL_cleanse(want, sizeof want);
  return rc;
}

int scc_sha256(const unsigned char *data, size_t len, unsigned char out[32]) {
  SERVICE_GATE();
  if (len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  unsigned int n = 0;
  EVP_MD *md = EVP_MD_fetch(g_fips_ctx, "SHA2-256", NULL);
  int ok = md != NULL && EVP_Digest(data, len, out, &n, md, NULL) == 1 && n == 32;
  EVP_MD_free(md);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

/* PQ-A1: the DER every ML-DSA SubjectPublicKeyInfo of a level starts with (RFC 9881: SEQUENCE { AlgorithmIdentifier
 * { id-ml-dsa-65 | id-ml-dsa-87 }, BIT STRING { 0 unused bits, pk } }), so the OID and every length are fixed. */
#define MLDSA_SPKI_PREFIX_LEN 22
static const unsigned char MLDSA65_SPKI_PREFIX[MLDSA_SPKI_PREFIX_LEN] = {0x30, 0x82, 0x07, 0xb2, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48,
                                                                         0x01, 0x65, 0x03, 0x04, 0x03, 0x12, 0x03, 0x82, 0x07, 0xa1, 0x00};
static const unsigned char MLDSA87_SPKI_PREFIX[MLDSA_SPKI_PREFIX_LEN] = {0x30, 0x82, 0x0a, 0x32, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48,
                                                                         0x01, 0x65, 0x03, 0x04, 0x03, 0x13, 0x03, 0x82, 0x0a, 0x21, 0x00};

int scc_mldsa_verify(int level, const unsigned char *spki_der, size_t spki_len, const unsigned char *msg, size_t msg_len,
                     const unsigned char *ctx, size_t ctx_len, const unsigned char *sig, size_t sig_len) {
  SERVICE_GATE();
  static const unsigned char empty[1] = {0};
  const unsigned char *prefix;
  const char *name;
  size_t pk_len, want_sig;
  if (level == 65) { prefix = MLDSA65_SPKI_PREFIX; name = "ML-DSA-65"; pk_len = 1952; want_sig = 3309; }
  else if (level == 87) { prefix = MLDSA87_SPKI_PREFIX; name = "ML-DSA-87"; pk_len = 2592; want_sig = 4627; }
  else return SCC_ERR_ARG;
  if (msg_len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  if (spki_der == NULL || spki_len != MLDSA_SPKI_PREFIX_LEN + pk_len || memcmp(spki_der, prefix, MLDSA_SPKI_PREFIX_LEN) != 0) return SCC_ERR_ARG;
  if (sig == NULL || sig_len != want_sig || ctx_len > SCC_MLDSA_MAX_CONTEXT || (ctx == NULL && ctx_len > 0) || (msg == NULL && msg_len > 0)) return SCC_ERR_ARG;
  int der_n;
  if (!int_len(spki_len, &der_n)) return SCC_ERR_ARG;
  const unsigned char *p = spki_der;
  EVP_PKEY *pkey = d2i_PUBKEY_ex(NULL, &p, der_n, g_std_ctx, NULL);
  EVP_PKEY_CTX *pctx = NULL;
  EVP_SIGNATURE *alg = NULL;
  int rc = SCC_ERR_ARG;
  if (pkey != NULL && p == spki_der + spki_len && EVP_PKEY_is_a(pkey, name)) {
    /* An empty context is FIPS 204's default; OpenSSL refuses a NULL octet string, so it is simply not set. */
    OSSL_PARAM params[] = {OSSL_PARAM_construct_octet_string(OSSL_SIGNATURE_PARAM_CONTEXT_STRING, (void *)ctx, ctx_len), OSSL_PARAM_construct_end()};
    pctx = EVP_PKEY_CTX_new_from_pkey(g_std_ctx, pkey, NULL);
    alg = EVP_SIGNATURE_fetch(g_std_ctx, name, NULL);
    if (pctx == NULL || alg == NULL || EVP_PKEY_verify_message_init(pctx, alg, ctx_len > 0 ? params : NULL) != 1) rc = SCC_ERR_CRYPTO;
    else {
      int v = EVP_PKEY_verify(pctx, sig, sig_len, msg_len > 0 ? msg : empty, msg_len);
      rc = v == 1 ? SCC_OK : v == 0 ? SCC_ERR_AUTH : SCC_ERR_CRYPTO;
    }
  }
  EVP_SIGNATURE_free(alg);
  EVP_PKEY_CTX_free(pctx);
  EVP_PKEY_free(pkey);
  ERR_clear_error();
  return rc;
}

static const char *const PQ_ALGORITHMS[] = {"ML-KEM-768", "ML-KEM-1024", "ML-DSA-65", "ML-DSA-87", "SLH-DSA-SHA2-256s"};

int scc_pq_algorithms(char *buf, size_t len) {
  if (g_std_ctx == NULL || len == 0) return SCC_ERR_STATE;
  size_t used = 0;
  buf[0] = '\0';
  for (size_t i = 0; i < sizeof PQ_ALGORITHMS / sizeof PQ_ALGORITHMS[0]; i++) {
    EVP_PKEY_CTX *c = EVP_PKEY_CTX_new_from_name(g_std_ctx, PQ_ALGORITHMS[i], NULL);
    if (c == NULL) continue;
    EVP_PKEY_CTX_free(c);
    int w = snprintf(buf + used, len - used, "%s%s", used ? "," : "", PQ_ALGORITHMS[i]);
    if (w < 0 || (size_t)w >= len - used) { buf[0] = '\0'; ERR_clear_error(); return SCC_ERR_ARG; }
    used += (size_t)w;
  }
  ERR_clear_error();
  return SCC_OK;
}

/* Inside the boundary only if the FIPS provider itself implements the operation ("provider=fips"), not the base
 * provider or a default provider loaded beside it. */
int scc_pq_in_fips_boundary(void) {
  if (g_fips == NULL || g_fips_ctx == NULL) return 0;
  EVP_KEM *kem = EVP_KEM_fetch(g_fips_ctx, "ML-KEM-768", "provider=fips");
  EVP_SIGNATURE *sig = EVP_SIGNATURE_fetch(g_fips_ctx, "ML-DSA-65", "provider=fips");
  int ok = kem != NULL && sig != NULL;
  EVP_KEM_free(kem);
  EVP_SIGNATURE_free(sig);
  ERR_clear_error();
  return ok;
}

int scc_random(unsigned char *out, size_t len) {
  SERVICE_GATE();
  if (len > SCC_MAX_INPUT) return SCC_ERR_TOO_LARGE;
  return RAND_bytes_ex(g_fips_ctx, out, len, 256) == 1 ? SCC_OK : drbg_failed();
}

/* SQLCipher's raw-key syntax, "x'<64 lowercase hex>'" (67 bytes + NUL), written into the caller's stack buffer.
 * Only the SQLCipher binding in this addon calls it (B.3), and it cleanses `out` right after sqlite3_key_v2. */
int scc_sqlcipher_raw_key(uint32_t key, char out[68]) {
  SERVICE_GATE();
  static const char HEX[] = "0123456789abcdef";
  int rc = need_usage(key, SCC_USE_DB, SCC_USE_DB); /* only a database key ever reaches SQLCipher (C4) */
  if (rc != SCC_OK) return rc;
  slot_used(key);
  unsigned char *k = slot_bytes(key);
  out[0] = 'x';
  out[1] = '\'';
  for (int i = 0; i < KEY_LEN; i++) {
    out[2 + 2 * i] = HEX[k[i] >> 4];
    out[3 + 2 * i] = HEX[k[i] & 0x0f];
  }
  out[66] = '\'';
  out[67] = '\0';
  return SCC_OK;
}

#ifdef SCC_KAT_BUILD
unsigned char *scc__slot_bytes_for_kat(uint32_t h) { return slot_bytes(h); }
#endif

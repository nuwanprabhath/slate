/* packages/native/src/binding.c — N-API surface. Keys cross this line only as uint32 handles. */
#include <node_api.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "slate_crypto_core.h"
#include "sqlite_key.h"

/* The KAT build exists to expose raw key access and fixed IVs; it never gets an N-API surface. */
#ifdef SCC_KAT_BUILD
#error "binding.c must never be compiled with SCC_KAT_BUILD"
#endif

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, "SLATE_NATIVE", #call); return NULL; } } while (0)

static napi_value throw_code(napi_env env, int rc) {
  char code[32];
  snprintf(code, sizeof code, "SCC_%d", -rc);
  napi_throw_error(env, code, rc == SCC_ERR_ERROR_STATE ? "Cryptographic module is in the error state" : rc == SCC_ERR_AUTH ? "Authentication failed" : rc == SCC_ERR_TOO_LARGE ? "Input exceeds the 256 MiB limit" : rc == SCC_ERR_NOT_APPROVED ? "Not allowed in approved mode" : rc == SCC_ERR_USAGE ? "This key may not be used for that" : "Cryptographic operation failed");
  return NULL;
}

/* Review C3 (C6): the module can enter its error state on its own (a DRBG failure, the provider's own error
 * state), not only through enterErrorState. The first service that answers SCC_12 then closes every SQLCipher
 * connection too, so none stays open with its key. Poisoning defers while a statement runs, and the SQLite
 * binding itself reports through throw_code, so this never closes a connection under its own call. */
static napi_value throw_rc(napi_env env, int rc) {
  if (rc == SCC_ERR_ERROR_STATE) slate_sqlite_close_all();
  return throw_code(env, rc);
}

static napi_value u32(napi_env env, uint32_t v) { napi_value r; napi_create_uint32(env, v, &r); return r; }

static int get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < want) return 0;
  return 1;
}

/* A Uint8Array over a plain ArrayBuffer. A view of a SharedArrayBuffer is refused (review N1): another
 * thread could change the bytes while a KDF or GCM call is reading them. */
static int get_bytes(napi_env env, napi_value v, unsigned char **data, size_t *len) {
  bool is_typed, is_plain;
  if (napi_is_typedarray(env, v, &is_typed) != napi_ok || !is_typed) return 0;
  napi_typedarray_type t; napi_value ab; size_t off;
  if (napi_get_typedarray_info(env, v, &t, len, (void **)data, &ab, &off) != napi_ok || t != napi_uint8_array) return 0;
  return napi_is_arraybuffer(env, ab, &is_plain) == napi_ok && is_plain;
}

/* A key handle: a JS number that is exactly an integer in [1, 2^32 - 1] (review N2). napi_get_value_uint32
 * would reduce 2^32 + h to h, or truncate 1.5 to 1. */
static int get_handle(napi_env env, napi_value v, uint32_t *out) {
  napi_valuetype t;
  double d;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number || napi_get_value_double(env, v, &d) != napi_ok) return 0;
  if (!(d >= 1.0 && d <= 4294967295.0)) return 0;
  uint32_t u = (uint32_t)d;
  if ((double)u != d) return 0;
  *out = u;
  return 1;
}

/* The SQLite binding (src/sqlite) reads key handles and reports module errors exactly as this file does. */
int slate_napi_key_handle(napi_env env, napi_value v, uint32_t *out) { return get_handle(env, v, out); }
void slate_throw_scc(napi_env env, int rc) { (void)throw_code(env, rc); }

/* The only way this file reads a string (review L1): the whole string must fit `cap - 1` bytes and hold
 * no NUL, so a label is never silently shortened at 127 bytes or at an embedded U+0000. */
static int get_string(napi_env env, napi_value v, char *buf, size_t cap, size_t *len) {
  size_t need = 0, got = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &need) != napi_ok || need >= cap) return 0;
  if (napi_get_value_string_utf8(env, v, buf, cap, &got) != napi_ok || got != need || memchr(buf, '\0', got) != NULL) return 0;
  *len = got;
  return 1;
}

/* An integer in [min, max] from a JS number (review L2). NaN, Infinity, fractions and non-numbers are
 * refused before any conversion, so there is no undefined double-to-integer cast. */
static int get_uint_in(napi_env env, napi_value v, uint32_t min, uint32_t max, uint32_t *out) {
  napi_valuetype t;
  double d;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number || napi_get_value_double(env, v, &d) != napi_ok) return 0;
  if (!(d >= (double)min && d <= (double)max)) return 0;
  uint32_t u = (uint32_t)d;
  if ((double)u != d) return 0;
  *out = u;
  return 1;
}

/* A key usage named by JavaScript: "data", "master", "db" or "kek" (C4). A password-class key is never
 * named: only the password KDFs make one. */
static int get_usage(napi_env env, napi_value v, int *usage) {
  char name[8];
  size_t n;
  if (!get_string(env, v, name, sizeof name, &n)) return 0;
  if (strcmp(name, "data") == 0) *usage = SCC_USE_DATA;
  else if (strcmp(name, "master") == 0) *usage = SCC_USE_MASTER;
  else if (strcmp(name, "db") == 0) *usage = SCC_USE_DB;
  else if (strcmp(name, "kek") == 0) *usage = SCC_USE_KEK;
  else return 0;
  return 1;
}

/* An optional trailing argument is absent when the caller passed fewer, or passed undefined. */
static int is_absent(napi_env env, size_t argc, size_t index, napi_value *argv) {
  napi_valuetype t;
  return argc <= index || (napi_typeof(env, argv[index], &t) == napi_ok && t == napi_undefined);
}

static napi_value Init(napi_env env, napi_callback_info info) {
  napi_value argv[3]; char path[4096], dir[4096]; size_t n; bool require_fips;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  /* A path that would not fit, or holds a NUL, is refused rather than shortened into some other file. */
  if (!get_string(env, argv[0], path, sizeof path, &n) || !get_string(env, argv[1], dir, sizeof dir, &n)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_bool(env, argv[2], &require_fips));
  int rc = scc_init(path, dir, require_fips);
  return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

/* C6 (audit S-1, S-2): postGate() before init makes every service refuse until a self-test passed;
 * postBegin() opens a self-test session; postEnd(passed) closes it, and a failure enters the error state
 * (closing every SQLCipher connection as enterErrorState does). */
static napi_value PostGate(napi_env env, napi_callback_info info) { (void)info; scc_post_gate(); return u32(env, 0); }

static napi_value PostBegin(napi_env env, napi_callback_info info) {
  (void)info; int rc = scc_post_begin(); return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

static napi_value PostEnd(napi_env env, napi_callback_info info) {
  napi_value argv[1]; bool passed;
  if (!get_args(env, info, 1, argv) || napi_get_value_bool(env, argv[0], &passed) != napi_ok) return throw_rc(env, SCC_ERR_ARG);
  if (!passed) slate_sqlite_close_all();
  int rc = scc_post_end(passed);
  return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

static napi_value HardenProcess(napi_env env, napi_callback_info info) {
  (void)info; napi_value r; napi_get_boolean(env, scc_harden_process() == SCC_OK, &r); return r;
}

static napi_value Status(napi_env env, napi_callback_info info) {
  (void)info; napi_value o, v;
  CHECK(napi_create_object(env, &o));
  /* Safe in every init state (C2 M2): before init, or after an init that failed, it reports, never crashes. */
  napi_get_boolean(env, scc_ready(), &v); napi_set_named_property(env, o, "ready", v);
  napi_get_boolean(env, scc_fips_active(), &v); napi_set_named_property(env, o, "fipsActive", v);
  napi_get_boolean(env, scc_in_error_state(), &v); napi_set_named_property(env, o, "errorState", v);
  napi_create_uint32(env, (uint32_t)scc_live_handles(), &v); napi_set_named_property(env, o, "liveHandles", v);
  napi_create_uint32(env, (uint32_t)scc_secure_heap_used(), &v); napi_set_named_property(env, o, "secureHeapUsed", v);
  napi_get_boolean(env, scc_heap_locked(), &v); napi_set_named_property(env, o, "secureHeapLocked", v);
  napi_get_boolean(env, scc_approved_keys_required(), &v); napi_set_named_property(env, o, "approvedKeysOnly", v);
  napi_get_boolean(env, scc_post_passed(), &v); napi_set_named_property(env, o, "postPassed", v);
  napi_create_uint32(env, (uint32_t)scc_selftest_failures(), &v); napi_set_named_property(env, o, "moduleSelfTestFailures", v);
  napi_create_string_utf8(env, OpenSSL_version(OPENSSL_VERSION), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "libcrypto", v);
  napi_create_string_utf8(env, scc_build_kind(), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "buildKind", v);
  char providers[256];
  if (scc_default_ctx_providers(providers, sizeof providers) != SCC_OK) providers[0] = '\0';
  napi_create_string_utf8(env, providers, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "defaultContextProviders", v);
  char name[128], version[64];
  if (scc_fips_module_info(name, sizeof name, version, sizeof version) == SCC_OK) {
    napi_value m;
    CHECK(napi_create_object(env, &m));
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, m, "name", v);
    napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, m, "version", v);
    napi_set_named_property(env, o, "fipsModule", m);
  } else {
    napi_get_null(env, &v); napi_set_named_property(env, o, "fipsModule", v);
  }
  return o;
}

/* Review M3: SQLCipher keeps its own derived keys, so both also close every open connection (SQLCipher
 * wipes a codec context when its connection closes); the authorizer refuses new statements after. */
static napi_value EnterErrorState(napi_env env, napi_callback_info info) { (void)info; slate_sqlite_close_all(); scc_enter_error_state(); return u32(env, 0); }
static napi_value ZeroizeAll(napi_env env, napi_callback_info info) { (void)info; slate_sqlite_close_all(); return u32(env, (uint32_t)scc_zeroize_all()); }

/* keyRandom(usage = "data") */
static napi_value KeyRandom(napi_env env, napi_callback_info info) {
  napi_value argv[1]; size_t argc = 1; uint32_t h; int usage = SCC_USE_DATA;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return throw_rc(env, SCC_ERR_ARG);
  if (!is_absent(env, argc, 0, argv) && !get_usage(env, argv[0], &usage)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_key_random_for(usage, &h);
  return rc == SCC_OK ? u32(env, h) : throw_rc(env, rc);
}

static napi_value RequireApprovedKeys(napi_env env, napi_callback_info info) {
  (void)info; int rc = scc_require_approved_keys(); return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

static napi_value KeyDestroy(napi_env env, napi_callback_info info) {
  napi_value argv[1]; uint32_t h;
  if (!get_args(env, info, 1, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &h)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_key_destroy(h);
  return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

/* kbkdf(key, label, context, usage = "data") */
static napi_value Kbkdf(napi_env env, napi_callback_info info) {
  napi_value argv[4]; size_t argc = 4; uint32_t key, out; char label[SCC_MAX_LABEL + 1]; size_t n, ctx_len; unsigned char *ctx; int usage = SCC_USE_DATA;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_string(env, argv[1], label, sizeof label, &n)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &ctx, &ctx_len)) return throw_rc(env, SCC_ERR_ARG);
  if (!is_absent(env, argc, 3, argv) && !get_usage(env, argv[3], &usage)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_kbkdf_for(key, label, n, ctx, ctx_len, usage, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* Reads up to `want` arguments and the password in argv[0], if it is one. Review L3: from here on every
 * exit, success or any argument error, goes through `out`, which wipes the password. */
static int get_password_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv, unsigned char **pw, size_t *pw_len) {
  size_t argc = want;
  *pw = NULL;
  *pw_len = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc == 0) return 0;
  if (!get_bytes(env, argv[0], pw, pw_len)) {
    /* Refused (a SharedArrayBuffer view, or not a Uint8Array): still wipe any password bytes it holds. */
    bool is_typed = false;
    napi_typedarray_type t;
    napi_value ab;
    size_t n = 0, off;
    void *data = NULL;
    if (napi_is_typedarray(env, argv[0], &is_typed) == napi_ok && is_typed &&
        napi_get_typedarray_info(env, argv[0], &t, &n, &data, &ab, &off) == napi_ok && t == napi_uint8_array && data != NULL)
      OPENSSL_cleanse(data, n);
    *pw = NULL;
    *pw_len = 0;
    return 0;
  }
  return argc >= want;
}

/* Password bytes are cleansed on every path; the renderer sent them as a Uint8Array, never a string. */
static napi_value Pbkdf2(napi_env env, napi_callback_info info) {
  napi_value argv[3], result = NULL; unsigned char *pw, *salt; size_t pw_len, salt_len; uint32_t iter, out; int rc = SCC_ERR_ARG;
  if (!get_password_args(env, info, 3, argv, &pw, &pw_len)) goto out;
  if (!get_bytes(env, argv[1], &salt, &salt_len)) goto out;
  if (!get_uint_in(env, argv[2], SCC_PBKDF2_MIN_ITER, SCC_PBKDF2_MAX_ITER, &iter)) goto out;
  rc = scc_pbkdf2(pw, pw_len, salt, salt_len, iter, &out);
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc == SCC_OK) result = u32(env, out);
  else throw_rc(env, rc);
  return result;
}

/* hkdfFromSecret(secret, salt, info) -> a password-class KEK. The secret is cleansed on every path. */
static napi_value HkdfFromSecret(napi_env env, napi_callback_info info) {
  napi_value argv[3], result = NULL; unsigned char *pw, *salt; size_t pw_len, salt_len, n; char label[SCC_MAX_LABEL + 1]; uint32_t out; int rc = SCC_ERR_ARG;
  if (!get_password_args(env, info, 3, argv, &pw, &pw_len)) goto out;
  if (!get_bytes(env, argv[1], &salt, &salt_len)) goto out;
  if (!get_string(env, argv[2], label, sizeof label, &n)) goto out;
  rc = scc_hkdf_secret(pw, pw_len, salt, salt_len, label, n, &out);
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc == SCC_OK) result = u32(env, out);
  else throw_rc(env, rc);
  return result;
}

/* kbkdfFromSecret(secret, label, context, approved) -> a password-class KEK (suite 0x02's recovery and
 * quick-unlock KEKs). The secret is cleansed on every path. */
static napi_value KbkdfFromSecret(napi_env env, napi_callback_info info) {
  napi_value argv[4], result = NULL; unsigned char *pw, *ctx; size_t pw_len, ctx_len, n; char label[SCC_MAX_LABEL + 1]; uint32_t out; bool approved = false; int rc = SCC_ERR_ARG;
  if (!get_password_args(env, info, 4, argv, &pw, &pw_len)) goto out;
  if (!get_string(env, argv[1], label, sizeof label, &n)) goto out;
  if (!get_bytes(env, argv[2], &ctx, &ctx_len)) goto out;
  if (napi_get_value_bool(env, argv[3], &approved) != napi_ok) goto out;
  rc = scc_kbkdf_secret(pw, pw_len, label, n, ctx, ctx_len, approved, &out);
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc == SCC_OK) result = u32(env, out);
  else throw_rc(env, rc);
  return result;
}

/* C7: recoveryDecode(text) -> a recovery-class handle. The typed text is cleansed on every path. */
static napi_value RecoveryDecode(napi_env env, napi_callback_info info) {
  napi_value argv[1], result = NULL; unsigned char *pw; size_t pw_len; uint32_t out; int rc = SCC_ERR_ARG;
  if (!get_password_args(env, info, 1, argv, &pw, &pw_len)) goto out;
  rc = scc_recovery_decode(pw, pw_len, &out);
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc == SCC_OK) result = u32(env, out);
  else throw_rc(env, rc);
  return result;
}

/* pbkdf2Calibrate(targetMs) -> iterations in [600000, 10^7] (an integer below 2^53). */
static napi_value Pbkdf2Calibrate(napi_env env, napi_callback_info info) {
  napi_value argv[1], r; uint32_t ms; uint64_t iter = 0;
  if (!get_args(env, info, 1, argv) || !get_uint_in(env, argv[0], 100, 10000, &ms)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_pbkdf2_calibrate(ms, &iter);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_uint32(env, iter > SCC_PBKDF2_MAX_ITER ? SCC_PBKDF2_MAX_ITER : (uint32_t)iter, &r));
  return r;
}

/* nameSivEncode(enc, mac, packed16) -> Uint8Array SIV(16) || C(16) */
static napi_value NameSivEncode(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t enc, mac; unsigned char *p, *out; size_t len;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &enc) || !get_handle(env, argv[1], &mac)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &p, &len) || len != 16) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 32, (void **)&out, &ab));
  int rc = scc_name_siv_encode(enc, mac, p, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 32, ab, 0, &res));
  return res;
}

/* nameSivDecode(enc, mac, name32) -> Uint8Array packed(16), or null when the SIV does not match. */
static napi_value NameSivDecode(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t enc, mac; unsigned char *in, *out; size_t len;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &enc) || !get_handle(env, argv[1], &mac)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &in, &len) || len != 32) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 16, (void **)&out, &ab));
  int rc = scc_name_siv_decode(enc, mac, in, out);
  if (rc == SCC_ERR_AUTH) {
    CHECK(napi_get_null(env, &res));
    return res;
  }
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 16, ab, 0, &res));
  return res;
}

/* kbkdfFromRecovery(handle, label, context, approved) -> a password-class KEK (suite 0x02's KEK_rc). */
static napi_value KbkdfFromRecovery(napi_env env, napi_callback_info info) {
  napi_value argv[4]; uint32_t key, out; char label[SCC_MAX_LABEL + 1]; size_t n, ctx_len; unsigned char *ctx; bool approved = false;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_string(env, argv[1], label, sizeof label, &n)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &ctx, &ctx_len)) return throw_rc(env, SCC_ERR_ARG);
  if (napi_get_value_bool(env, argv[3], &approved) != napi_ok) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_kbkdf_recovery(key, label, n, ctx, ctx_len, approved, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* hkdfFromRecovery(handle, salt, info) -> a password-class KEK (KEK_rc). */
static napi_value HkdfFromRecovery(napi_env env, napi_callback_info info) {
  napi_value argv[3]; uint32_t key, out; char label[SCC_MAX_LABEL + 1]; size_t n, salt_len; unsigned char *salt;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &salt, &salt_len)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_string(env, argv[2], label, sizeof label, &n)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_hkdf_recovery(key, salt, salt_len, label, n, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  scc_argon2_job *job;
} argon2_async;

static void argon2_execute(napi_env env, void *data) {
  (void)env;
  argon2_async *a = data;
  (void)scc_argon2id_job_run(a->job);
}

static void argon2_complete(napi_env env, napi_status status, void *data) {
  argon2_async *a = data;
  uint32_t out = 0;
  int rc = status == napi_ok ? scc_argon2id_job_finish(a->job, &out) : SCC_ERR_STATE;
  scc_argon2id_job_free(a->job);
  napi_value v = NULL;
  if (rc == SCC_OK) {
    napi_create_uint32(env, out, &v);
    napi_resolve_deferred(env, a->deferred, v);
  } else {
    char code[32];
    napi_value c, m;
    snprintf(code, sizeof code, "SCC_%d", -rc);
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c);
    napi_create_string_utf8(env, rc == SCC_ERR_ERROR_STATE ? "Cryptographic module is in the error state" : "Cryptographic operation failed", NAPI_AUTO_LENGTH, &m);
    napi_create_error(env, c, m, &v);
    napi_reject_deferred(env, a->deferred, v);
  }
  napi_delete_async_work(env, a->work);
  free(a);
}

/* argon2idAsync(password, salt, memoryKiB, passes) -> Promise<KeyHandle>. The password is copied into the
 * secure heap and cleansed here before the derivation starts on a libuv thread (Z-7: no worker thread
 * ever holds it as a JavaScript value). Argument errors reject; nothing throws synchronously. */
static napi_value Argon2idAsync(napi_env env, napi_callback_info info) {
  napi_value argv[4], promise = NULL, name; unsigned char *pw, *salt; size_t pw_len, salt_len; uint32_t mem, passes; int rc = SCC_ERR_ARG;
  napi_deferred deferred = NULL;
  scc_argon2_job *job = NULL;
  argon2_async *a = NULL;
  if (!get_password_args(env, info, 4, argv, &pw, &pw_len)) goto out;
  if (!get_bytes(env, argv[1], &salt, &salt_len)) goto out;
  if (!get_uint_in(env, argv[2], SCC_ARGON2_MIN_KIB, SCC_ARGON2_MAX_KIB, &mem)) goto out;
  if (!get_uint_in(env, argv[3], SCC_ARGON2_MIN_PASSES, SCC_ARGON2_MAX_PASSES, &passes)) goto out;
  rc = scc_argon2id_job_new(pw, pw_len, salt, salt_len, mem, passes, &job);
  if (rc != SCC_OK) goto out;
  a = calloc(1, sizeof *a);
  rc = SCC_ERR_STATE;
  if (a == NULL || napi_create_promise(env, &deferred, &promise) != napi_ok) goto out;
  a->deferred = deferred;
  a->job = job;
  if (napi_create_string_utf8(env, "slate-argon2id", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, argon2_execute, argon2_complete, a, &a->work) != napi_ok) goto out;
  if (napi_queue_async_work(env, a->work) != napi_ok) { napi_delete_async_work(env, a->work); goto out; }
  rc = SCC_OK;
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc != SCC_OK) {
    scc_argon2id_job_free(job);
    free(a);
    if (deferred == NULL && napi_create_promise(env, &deferred, &promise) != napi_ok) return throw_rc(env, rc);
    char code[32];
    napi_value c, m, err;
    snprintf(code, sizeof code, "SCC_%d", -rc);
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c);
    napi_create_string_utf8(env, "Cryptographic operation failed", NAPI_AUTO_LENGTH, &m);
    napi_create_error(env, c, m, &err);
    napi_reject_deferred(env, deferred, err);
  }
  return promise;
}

/* pbkdf2Async(password, salt, iterations) -> Promise<KeyHandle>: PBKDF2 on a libuv thread (review C5 L1). The
 * password is copied into the job's secure heap and cleansed here before this returns. */
static napi_value Pbkdf2Async(napi_env env, napi_callback_info info) {
  napi_value argv[3], promise = NULL, name; unsigned char *pw, *salt; size_t pw_len, salt_len; uint32_t iter; int rc = SCC_ERR_ARG;
  napi_deferred deferred = NULL;
  scc_argon2_job *job = NULL;
  argon2_async *a = NULL;
  if (!get_password_args(env, info, 3, argv, &pw, &pw_len)) goto out;
  if (!get_bytes(env, argv[1], &salt, &salt_len)) goto out;
  if (!get_uint_in(env, argv[2], SCC_PBKDF2_MIN_ITER, SCC_PBKDF2_MAX_ITER, &iter)) goto out;
  rc = scc_pbkdf2_job_new(pw, pw_len, salt, salt_len, iter, &job);
  if (rc != SCC_OK) goto out;
  a = calloc(1, sizeof *a);
  rc = SCC_ERR_STATE;
  if (a == NULL || napi_create_promise(env, &deferred, &promise) != napi_ok) goto out;
  a->deferred = deferred;
  a->job = job;
  if (napi_create_string_utf8(env, "slate-pbkdf2", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, argon2_execute, argon2_complete, a, &a->work) != napi_ok) goto out;
  if (napi_queue_async_work(env, a->work) != napi_ok) { napi_delete_async_work(env, a->work); goto out; }
  rc = SCC_OK;
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc != SCC_OK) {
    scc_argon2id_job_free(job);
    free(a);
    if (deferred == NULL && napi_create_promise(env, &deferred, &promise) != napi_ok) return throw_rc(env, rc);
    char code[32];
    napi_value c, m, err;
    snprintf(code, sizeof code, "SCC_%d", -rc);
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c);
    napi_create_string_utf8(env, "Cryptographic operation failed", NAPI_AUTO_LENGTH, &m);
    napi_create_error(env, c, m, &err);
    napi_reject_deferred(env, deferred, err);
  }
  return promise;
}

static napi_value Argon2id(napi_env env, napi_callback_info info) {
  napi_value argv[4], result = NULL; unsigned char *pw, *salt; size_t pw_len, salt_len; uint32_t mem, passes, out; int rc = SCC_ERR_ARG;
  if (!get_password_args(env, info, 4, argv, &pw, &pw_len)) goto out;
  if (!get_bytes(env, argv[1], &salt, &salt_len)) goto out;
  if (!get_uint_in(env, argv[2], SCC_ARGON2_MIN_KIB, SCC_ARGON2_MAX_KIB, &mem)) goto out;
  if (!get_uint_in(env, argv[3], SCC_ARGON2_MIN_PASSES, SCC_ARGON2_MAX_PASSES, &passes)) goto out;
  rc = scc_argon2id(pw, pw_len, salt, salt_len, mem, passes, &out);
out:
  if (pw != NULL) OPENSSL_cleanse(pw, pw_len);
  if (rc == SCC_OK) result = u32(env, out);
  else throw_rc(env, rc);
  return result;
}

/* gcmSeal(key, ivOrNull, aad, plaintext) -> Uint8Array iv(12) || ct || tag(16) */
static napi_value GcmSeal(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; napi_valuetype t; uint32_t key; unsigned char *iv = NULL, *aad, *pt, *out; size_t iv_len = 0, aad_len, pt_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_typeof(env, argv[1], &t));
  if (t != napi_null && (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &pt, &pt_len)) return throw_rc(env, SCC_ERR_ARG);
  if (aad_len > SCC_MAX_INPUT || pt_len > SCC_MAX_INPUT) return throw_rc(env, SCC_ERR_TOO_LARGE);
  CHECK(napi_create_arraybuffer(env, 12 + pt_len + 16, (void **)&out, &ab));
  int rc = scc_gcm_seal(key, iv, aad, aad_len, pt, pt_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 12 + pt_len + 16, ab, 0, &res));
  return res;
}

/* gcmSealIvInAad(key, aad, ivOffset, plaintext) -> Uint8Array iv(12) || ct || tag(16). The module draws the
 * IV and writes it into its copy of `aad` at `ivOffset` before sealing (formats whose header holds the nonce). */
static napi_value GcmSealIvInAad(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; uint32_t key, off; unsigned char *aad, *pt, *out; size_t aad_len, pt_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &aad, &aad_len) || !get_bytes(env, argv[3], &pt, &pt_len)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_uint_in(env, argv[2], 0, 4096, &off)) return throw_rc(env, SCC_ERR_ARG);
  if (aad_len > SCC_MAX_INPUT || pt_len > SCC_MAX_INPUT) return throw_rc(env, SCC_ERR_TOO_LARGE);
  CHECK(napi_create_arraybuffer(env, 12 + pt_len + 16, (void **)&out, &ab));
  int rc = scc_gcm_seal_iv_in_aad(key, aad, aad_len, off, pt, pt_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 12 + pt_len + 16, ab, 0, &res));
  return res;
}

/* gcmOpen(key, iv, aad, ctAndTag) -> Uint8Array plaintext; throws SCC_11 on a bad tag. */
static napi_value GcmOpen(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; uint32_t key; unsigned char *iv, *aad, *ct, *out; size_t iv_len, aad_len, ct_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len) || ct_len < 16) return throw_rc(env, SCC_ERR_AUTH);
  if (aad_len > SCC_MAX_INPUT || ct_len - 16 > SCC_MAX_INPUT) return throw_rc(env, SCC_ERR_TOO_LARGE);
  CHECK(napi_create_arraybuffer(env, ct_len - 16, (void **)&out, &ab));
  int rc = scc_gcm_open(key, iv, aad, aad_len, ct, ct_len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, ct_len - 16, ab, 0, &res));
  return res;
}

/* gcmOpenKey(kek, iv, aad, ctAndTag, usage?) -> KeyHandle: an unwrapped key goes straight into the secure
 * heap. Without `usage`, a password KEK yields a master key and a data key a data key. */
static napi_value GcmOpenKey(napi_env env, napi_callback_info info) {
  napi_value argv[5]; size_t argc = 5; uint32_t kek, out; unsigned char *iv, *aad, *ct; size_t iv_len, aad_len, ct_len; int usage = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &kek)) return throw_rc(env, SCC_ERR_ARG);
  if (!is_absent(env, argc, 4, argv) && !get_usage(env, argv[4], &usage)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  int rc = usage == 0 ? scc_gcm_open_key(kek, iv, aad, aad_len, ct, ct_len, &out) : scc_gcm_open_key_for(kek, iv, aad, aad_len, ct, ct_len, usage, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* gcmSealKey(kek, key, ivOrNull, aad) -> Uint8Array iv(12) || wrapped(32) || tag(16) */
static napi_value GcmSealKey(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; napi_valuetype t; uint32_t kek, key; unsigned char *iv = NULL, *aad, *out; size_t iv_len = 0, aad_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &kek)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[1], &key)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_typeof(env, argv[2], &t));
  if (t != napi_null && (!get_bytes(env, argv[2], &iv, &iv_len) || iv_len != 12)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[3], &aad, &aad_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 12 + 32 + 16, (void **)&out, &ab));
  int rc = scc_gcm_seal_key(kek, key, iv, aad, aad_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 60, ab, 0, &res));
  return res;
}

/* rewrapKey(oldKek, iv, aad, ctAndTag, newKek, newAad) -> Uint8Array iv(12) || wrapped(32) || tag(16) */
static napi_value RewrapKey(napi_env env, napi_callback_info info) {
  napi_value argv[6], ab, res; uint32_t old_kek, new_kek; unsigned char *iv, *aad, *ct, *new_aad, *out; size_t iv_len, aad_len, ct_len, new_aad_len;
  if (!get_args(env, info, 6, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &old_kek) || !get_handle(env, argv[4], &new_kek)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  if (!get_bytes(env, argv[5], &new_aad, &new_aad_len)) return throw_rc(env, SCC_ERR_ARG);
  if (aad_len > SCC_MAX_INPUT || new_aad_len > SCC_MAX_INPUT) return throw_rc(env, SCC_ERR_TOO_LARGE);
  CHECK(napi_create_arraybuffer(env, 12 + 32 + 16, (void **)&out, &ab));
  int rc = scc_rewrap_key(old_kek, iv, aad, aad_len, ct, ct_len, new_kek, new_aad, new_aad_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 60, ab, 0, &res));
  return res;
}

/* C9: a 60-byte iv(12) || wrapped(32) || tag(16) result. */
static napi_value wrap60(napi_env env, napi_value ab) {
  napi_value res;
  CHECK(napi_create_typedarray(env, napi_uint8_array, 60, ab, 0, &res));
  return res;
}

/* historySeal(proofKek, iv, aad, ctAndTag, mkNew, ctx, newAad) -> Uint8Array iv(12) || wrapped(32) || tag(16) */
static napi_value HistorySeal(napi_env env, napi_callback_info info) {
  napi_value argv[7], ab; uint32_t kek, mk; unsigned char *iv, *aad, *ct, *ctx, *new_aad, *out; size_t iv_len, aad_len, ct_len, ctx_len, new_aad_len;
  if (!get_args(env, info, 7, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &kek) || !get_handle(env, argv[4], &mk)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  if (!get_bytes(env, argv[5], &ctx, &ctx_len) || !get_bytes(env, argv[6], &new_aad, &new_aad_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 60, (void **)&out, &ab));
  int rc = scc_history_seal(kek, iv, aad, aad_len, ct, ct_len, mk, ctx, ctx_len, new_aad, new_aad_len, out, out + 12);
  return rc == SCC_OK ? wrap60(env, ab) : throw_rc(env, rc);
}

/* historyRewrap(proofKek, iv, aad, ctAndTag, ctxCur, entryIv, entryAad, entryCt, mkNew, ctxNew, newAad) -> 60 bytes */
static napi_value HistoryRewrap(napi_env env, napi_callback_info info) {
  napi_value argv[11], ab; uint32_t kek, mk;
  unsigned char *iv, *aad, *ct, *cc, *eiv, *eaad, *ect, *cn, *naad, *out;
  size_t iv_len, aad_len, ct_len, cc_len, eiv_len, eaad_len, ect_len, cn_len, naad_len;
  if (!get_args(env, info, 11, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &kek) || !get_handle(env, argv[8], &mk)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  if (!get_bytes(env, argv[5], &eiv, &eiv_len) || eiv_len != 12 || !get_bytes(env, argv[6], &eaad, &eaad_len) || !get_bytes(env, argv[7], &ect, &ect_len)) return throw_rc(env, SCC_ERR_AUTH);
  if (!get_bytes(env, argv[4], &cc, &cc_len) || !get_bytes(env, argv[9], &cn, &cn_len) || !get_bytes(env, argv[10], &naad, &naad_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 60, (void **)&out, &ab));
  int rc = scc_history_rewrap(kek, iv, aad, aad_len, ct, ct_len, cc, cc_len, eiv, eaad, eaad_len, ect, ect_len, mk, cn, cn_len, naad, naad_len, out, out + 12);
  return rc == SCC_OK ? wrap60(env, ab) : throw_rc(env, rc);
}

/* historyOpen(mk, ctx, iv, aad, ctAndTag) -> KeyHandle (a master key of an earlier epoch) */
static napi_value HistoryOpen(napi_env env, napi_callback_info info) {
  napi_value argv[5]; uint32_t mk, out; unsigned char *ctx, *iv, *aad, *ct; size_t ctx_len, iv_len, aad_len, ct_len;
  if (!get_args(env, info, 5, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &mk) || !get_bytes(env, argv[1], &ctx, &ctx_len)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[3], &aad, &aad_len) || !get_bytes(env, argv[4], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  int rc = scc_history_open(mk, ctx, ctx_len, iv, aad, aad_len, ct, ct_len, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

static napi_value HmacSha256(napi_env env, napi_callback_info info) {
  napi_value argv[2], ab, res; uint32_t key; unsigned char *data, *out; size_t len;
  if (!get_args(env, info, 2, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &data, &len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 32, (void **)&out, &ab));
  int rc = scc_hmac_sha256(key, data, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 32, ab, 0, &res));
  return res;
}

static napi_value AesEcbBlock(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t key; unsigned char *in, *out; size_t len; bool enc;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &in, &len) || len != 16) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_bool(env, argv[2], &enc));
  CHECK(napi_create_arraybuffer(env, 16, (void **)&out, &ab));
  int rc = scc_aes_ecb_block(key, in, enc, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 16, ab, 0, &res));
  return res;
}

static napi_value AesCtr(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t key; unsigned char *icb, *in, *out; size_t icb_len, len;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &icb, &icb_len) || icb_len != 16 || !get_bytes(env, argv[2], &in, &len) || len == 0 || len > 4096) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, len, (void **)&out, &ab));
  int rc = scc_aes_ctr(key, icb, in, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, len, ab, 0, &res));
  return res;
}

static napi_value Sha256(napi_env env, napi_callback_info info) {
  napi_value argv[1], ab, res; unsigned char *data, *out; size_t len;
  if (!get_args(env, info, 1, argv) || !get_bytes(env, argv[0], &data, &len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 32, (void **)&out, &ab));
  int rc = scc_sha256(data, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 32, ab, 0, &res));
  return res;
}

static napi_value RandomBytes(napi_env env, napi_callback_info info) {
  napi_value argv[1], ab, res; uint32_t n; unsigned char *out;
  if (!get_args(env, info, 1, argv)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &n)) return throw_rc(env, SCC_ERR_ARG);
  if (n == 0 || n > 4096) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, n, (void **)&out, &ab));
  int rc = scc_random(out, n);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, n, ab, 0, &res));
  return res;
}

/* hkdfLegacy(key, salt, info, usage = "data") */
static napi_value HkdfLegacy(napi_env env, napi_callback_info info) {
  napi_value argv[4]; size_t argc = 4; uint32_t key, out; char label[SCC_MAX_LABEL + 1]; size_t n, salt_len; unsigned char *salt; int usage = SCC_USE_DATA;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) return throw_rc(env, SCC_ERR_ARG);
  if (!get_handle(env, argv[0], &key)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[1], &salt, &salt_len)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_string(env, argv[2], label, sizeof label, &n)) return throw_rc(env, SCC_ERR_ARG);
  if (!is_absent(env, argc, 3, argv) && !get_usage(env, argv[3], &usage)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_hkdf_legacy_for(key, salt, salt_len, label, n, usage, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

static napi_value Register(napi_env env, napi_value exports) {
  /* The handle table and error state are process-wide and unsynchronised, so exactly one environment (the
   * main thread) may use them (review N3): a worker or a second context is refused. */
  static int registered = 0;
  if (registered) {
    napi_throw_error(env, "SCC_2", "slate_native.node serves one environment per process (the main thread)");
    return NULL;
  }
  registered = 1;
  /* Before any other OpenSSL call: libcrypto must never load OPENSSL_CONF (review M1). */
  if (scc_preinit() != SCC_OK) { napi_throw_error(env, "SCC_3", "Cryptographic module failed to initialise"); return NULL; }
  napi_property_descriptor d[] = {
      {"init", NULL, Init, NULL, NULL, NULL, napi_default, NULL},
      {"hardenProcess", NULL, HardenProcess, NULL, NULL, NULL, napi_default, NULL},
      {"postGate", NULL, PostGate, NULL, NULL, NULL, napi_default, NULL},
      {"postBegin", NULL, PostBegin, NULL, NULL, NULL, napi_default, NULL},
      {"postEnd", NULL, PostEnd, NULL, NULL, NULL, napi_default, NULL},
      {"status", NULL, Status, NULL, NULL, NULL, napi_default, NULL},
      {"enterErrorState", NULL, EnterErrorState, NULL, NULL, NULL, napi_default, NULL},
      {"zeroizeAll", NULL, ZeroizeAll, NULL, NULL, NULL, napi_default, NULL},
      {"keyRandom", NULL, KeyRandom, NULL, NULL, NULL, napi_default, NULL},
      {"requireApprovedKeys", NULL, RequireApprovedKeys, NULL, NULL, NULL, napi_default, NULL},
      {"hkdfFromSecret", NULL, HkdfFromSecret, NULL, NULL, NULL, napi_default, NULL},
      {"kbkdfFromSecret", NULL, KbkdfFromSecret, NULL, NULL, NULL, napi_default, NULL},
      {"pbkdf2Calibrate", NULL, Pbkdf2Calibrate, NULL, NULL, NULL, napi_default, NULL},
      {"nameSivEncode", NULL, NameSivEncode, NULL, NULL, NULL, napi_default, NULL},
      {"nameSivDecode", NULL, NameSivDecode, NULL, NULL, NULL, napi_default, NULL},
      {"recoveryDecode", NULL, RecoveryDecode, NULL, NULL, NULL, napi_default, NULL},
      {"hkdfFromRecovery", NULL, HkdfFromRecovery, NULL, NULL, NULL, napi_default, NULL},
      {"kbkdfFromRecovery", NULL, KbkdfFromRecovery, NULL, NULL, NULL, napi_default, NULL},
      {"argon2idAsync", NULL, Argon2idAsync, NULL, NULL, NULL, napi_default, NULL},
      {"keyDestroy", NULL, KeyDestroy, NULL, NULL, NULL, napi_default, NULL},
      {"kbkdf", NULL, Kbkdf, NULL, NULL, NULL, napi_default, NULL},
      {"hkdfLegacy", NULL, HkdfLegacy, NULL, NULL, NULL, napi_default, NULL},
      {"pbkdf2", NULL, Pbkdf2, NULL, NULL, NULL, napi_default, NULL},
      {"pbkdf2Async", NULL, Pbkdf2Async, NULL, NULL, NULL, napi_default, NULL},
      {"argon2id", NULL, Argon2id, NULL, NULL, NULL, napi_default, NULL},
      {"gcmSeal", NULL, GcmSeal, NULL, NULL, NULL, napi_default, NULL},
      {"gcmSealIvInAad", NULL, GcmSealIvInAad, NULL, NULL, NULL, napi_default, NULL},
      {"gcmOpen", NULL, GcmOpen, NULL, NULL, NULL, napi_default, NULL},
      {"gcmOpenKey", NULL, GcmOpenKey, NULL, NULL, NULL, napi_default, NULL},
      {"gcmSealKey", NULL, GcmSealKey, NULL, NULL, NULL, napi_default, NULL},
      {"rewrapKey", NULL, RewrapKey, NULL, NULL, NULL, napi_default, NULL},
      {"historySeal", NULL, HistorySeal, NULL, NULL, NULL, napi_default, NULL},
      {"historyRewrap", NULL, HistoryRewrap, NULL, NULL, NULL, napi_default, NULL},
      {"historyOpen", NULL, HistoryOpen, NULL, NULL, NULL, napi_default, NULL},
      {"hmacSha256", NULL, HmacSha256, NULL, NULL, NULL, napi_default, NULL},
      {"aesEcbBlock", NULL, AesEcbBlock, NULL, NULL, NULL, napi_default, NULL},
      {"aesCtr", NULL, AesCtr, NULL, NULL, NULL, napi_default, NULL},
      {"sha256", NULL, Sha256, NULL, NULL, NULL, napi_default, NULL},
      {"randomBytes", NULL, RandomBytes, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof d / sizeof d[0], d) != napi_ok) return NULL;
  /* SQLCipher and its better-sqlite3 binding live in this addon (audit §4.9, C3): one boundary, one libcrypto. */
  napi_value sqlite = slate_sqlite_exports(env);
  if (sqlite == NULL || napi_set_named_property(env, exports, "sqlite", sqlite) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Register)

/* packages/native/src/sqlite_key.c: how a key reaches SQLCipher, and what SQL text may ask of it
 * (audit B.3, C3 criteria 1 and 2, review M1-M3, L2). Compiled with the module's own flags
 * (-Wconversion -Werror), unlike the vendored sources. */
#include <openssl/crypto.h>
#include <string.h>
#include "slate_crypto_core.h"
#include "sqlite_key.h"

/* "x'<64 hex>'": SQLCipher's raw-key syntax, so it uses the 32 bytes as the key (no PBKDF2 on them). */
#define RAW_KEY_LEN 67
/* Bit 31 of a handle: a key from a non-approved function (index.ts isApprovedKey). Refused once the vault's
 * profile requires approved keys (requireApprovedKeys, fips-140-3): a policy against accidental non-approved
 * keys, not a boundary against in-process code until C5 (review C4 M1-R); a standard-profile vault's LK is wrapped
 * under an HKDF subkey of an Argon2id-wrapped master key, so it is non-approved even on the FIPS provider. */
#define NOT_APPROVED_BIT 0x80000000u

int slate_sqlcipher_key(sqlite3 *db, slate_conn *conn, uint32_t handle, int rekey, int *sqlite_rc) {
  char raw[RAW_KEY_LEN + 1];
  int rc = (handle & NOT_APPROVED_BIT) != 0 && scc_approved_keys_required() ? SCC_ERR_NOT_APPROVED : scc_sqlcipher_raw_key(handle, raw);
  if (rc == SCC_OK) {
    *sqlite_rc = rekey ? sqlite3_rekey_v2(db, "main", raw, RAW_KEY_LEN) : sqlite3_key_v2(db, "main", raw, RAW_KEY_LEN);
    if (*sqlite_rc == SQLITE_OK) conn->keyed = 1;
  }
  OPENSSL_cleanse(raw, sizeof raw);
  return rc;
}

static int read_user_version(sqlite3 *db, int *out) {
  sqlite3_stmt *stmt = NULL;
  int rc = sqlite3_prepare_v2(db, "PRAGMA slate_plain.user_version", -1, &stmt, NULL);
  if (rc == SQLITE_OK) {
    rc = sqlite3_step(stmt) == SQLITE_ROW ? SQLITE_OK : sqlite3_errcode(db);
    if (rc == SQLITE_OK) *out = sqlite3_column_int(stmt, 0);
  }
  sqlite3_finalize(stmt);
  return rc;
}

static int main_is_empty(sqlite3 *db) {
  sqlite3_stmt *stmt = NULL;
  int empty = 0;
  if (sqlite3_prepare_v2(db, "SELECT count(*) FROM main.sqlite_master", -1, &stmt, NULL) == SQLITE_OK && sqlite3_step(stmt) == SQLITE_ROW) {
    empty = sqlite3_column_int(stmt, 0) == 0;
  }
  sqlite3_finalize(stmt);
  return empty;
}

/* `file:<path>?mode=ro` with the URI-significant characters percent-encoded (re-review R-N1): the source
 * opens read-only, and a missing source is SQLITE_CANTOPEN instead of a new empty file. */
static char *read_only_uri(const char *path) {
  sqlite3_str *uri = sqlite3_str_new(NULL);
  sqlite3_str_appendall(uri, "file:");
  for (const unsigned char *p = (const unsigned char *)path; *p != 0; p++) {
    if (*p == '%' || *p == '?' || *p == '#' || *p < 0x21 || *p == 0x7f) sqlite3_str_appendf(uri, "%%%02X", (unsigned)*p);
    else sqlite3_str_appendchar(uri, 1, (char)*p);
  }
  sqlite3_str_appendall(uri, "?mode=ro");
  return sqlite3_str_finish(uri);
}

int slate_sqlcipher_import_plaintext(sqlite3 *db, slate_conn *conn, const char *plain_path, int *sqlite_rc) {
  if (scc_error_latched()) return SCC_ERR_ERROR_STATE;
  /* Into a keyed, empty database only: anything else would merge into existing notes. */
  if (!conn->keyed || !main_is_empty(db)) return SCC_ERR_STATE;
  char *uri = read_only_uri(plain_path);
  char *attach = uri == NULL ? NULL : sqlite3_mprintf("ATTACH DATABASE %Q AS slate_plain KEY ''", uri);
  sqlite3_free(uri);
  if (attach == NULL) {
    *sqlite_rc = SQLITE_NOMEM;
    return SCC_OK;
  }
  int user_version = 0;
  conn->internal = 1;
  int rc = sqlite3_exec(db, attach, NULL, NULL, NULL);
  sqlite3_free(attach);
  if (rc == SQLITE_OK) {
    rc = read_user_version(db, &user_version);
    if (rc == SQLITE_OK) rc = sqlite3_exec(db, "SELECT sqlcipher_export('main', 'slate_plain')", NULL, NULL, NULL);
    if (rc == SQLITE_OK) {
      char *set = sqlite3_mprintf("PRAGMA main.user_version = %d", user_version);
      rc = set == NULL ? SQLITE_NOMEM : sqlite3_exec(db, set, NULL, NULL, NULL);
      sqlite3_free(set);
    }
    int detached = sqlite3_exec(db, "DETACH DATABASE slate_plain", NULL, NULL, NULL);
    if (rc == SQLITE_OK) rc = detached;
  }
  conn->internal = 0;
  *sqlite_rc = rc;
  return SCC_OK;
}

int slate_sqlite_usable(void) { return scc_error_latched() ? SCC_ERR_ERROR_STATE : SCC_OK; }

/* Every spelling SQLCipher accepts for setting a key through SQL. */
static const char *const KEY_PRAGMAS[] = {"key", "rekey", "hexkey", "hexrekey", "textkey", "textrekey"};
/* SQLCipher's pragmas that do not start with "cipher". */
static const char *const OTHER_CODEC_PRAGMAS[] = {"kdf_iter", "fast_kdf_iter", "rekey_kdf_iter", "rekey_cipher"};
/* The codec queries the app reads (openDatabase.ts checkCipher); queries only, never settings. */
static const char *const READ_ONLY[] = {"cipher_version", "cipher_provider", "cipher_provider_version", "cipher_fips_status",
                                        "cipher_memory_security", "cipher_use_hmac", "cipher_page_size", "cipher_plaintext_header_size",
                                        "cipher_hmac_algorithm", "cipher_kdf_algorithm", "kdf_iter"};

#define IN_LIST(name, list) in_list(name, list, sizeof list / sizeof list[0])

static int in_list(const char *name, const char *const *list, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (sqlite3_stricmp(name, list[i]) == 0) return 1;
  }
  return 0;
}

static int is_on(const char *v) {
  return sqlite3_stricmp(v, "on") == 0 || sqlite3_stricmp(v, "1") == 0 || sqlite3_stricmp(v, "true") == 0 || sqlite3_stricmp(v, "yes") == 0;
}

/* An allowlist for SQL from JavaScript:
 *  - nothing at all once the module is in its error state (review M3);
 *  - no ATTACH or DETACH, and no sqlcipher_* function (review M1): a key or a decrypting export
 *    could otherwise come from SQL text; slate_sqlcipher_import_plaintext is the one way;
 *  - no key pragma in any spelling, and of SQLCipher's own pragmas only the read-only queries in
 *    READ_ONLY plus `cipher_memory_security = ON` (review M2: the cipher_default_* settings are
 *    process-wide and would weaken every database keyed later).
 * Everything else (ordinary reads, writes, schema, other pragmas) is SQLite's business. */
int slate_sqlite_authorizer(void *user, int action, const char *a, const char *b, const char *c, const char *d) {
  const slate_conn *conn = (const slate_conn *)user;
  (void)c;
  (void)d;
  if (scc_error_latched()) return SQLITE_DENY;
  switch (action) {
    case SQLITE_ATTACH:
    case SQLITE_DETACH:
      return conn->internal ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_FUNCTION:
      return b != NULL && sqlite3_strnicmp(b, "sqlcipher", 9) == 0 && !conn->internal ? SQLITE_DENY : SQLITE_OK;
    case SQLITE_PRAGMA:
      if (a == NULL) return SQLITE_OK;
      if (IN_LIST(a, KEY_PRAGMAS)) return SQLITE_DENY;
      /* Re-review R-L1: on a keyed connection SQLCipher treats page_size as cipher_page_size. */
      if (conn->keyed && sqlite3_stricmp(a, "page_size") == 0) return b == NULL ? SQLITE_OK : SQLITE_DENY;
      if (sqlite3_strnicmp(a, "cipher", 6) != 0 && !IN_LIST(a, OTHER_CODEC_PRAGMAS)) return SQLITE_OK;
      if (b == NULL) return IN_LIST(a, READ_ONLY) ? SQLITE_OK : SQLITE_DENY;
      return sqlite3_stricmp(a, "cipher_memory_security") == 0 && is_on(b) ? SQLITE_OK : SQLITE_DENY;
    default:
      return SQLITE_OK;
  }
}

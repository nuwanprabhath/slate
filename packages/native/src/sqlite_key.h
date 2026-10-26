/* The seam between the vendored SQLite binding (src/sqlite, C++) and the module core (audit B.3). */
#ifndef SLATE_SQLITE_KEY_H
#define SLATE_SQLITE_KEY_H
#include <node_api.h>
#include <sqlite3.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Per-connection state the authorizer reads. `internal` is set only while slate_sqlcipher_import_plaintext
 * runs its own statements; SQL from JavaScript always sees it 0. */
typedef struct slate_conn {
  int internal;
  int keyed;
} slate_conn;

/* Keys (rekey = 0) or rekeys (rekey = 1) `db` from a key handle. Returns an SCC_* code; on SCC_OK the
 * SQLite status is in *sqlite_rc. On any SCC error nothing reached SQLCipher. */
int slate_sqlcipher_key(sqlite3 *db, slate_conn *conn, uint32_t handle, int rekey, int *sqlite_rc);
/* Copies the plaintext database at `plain_path` into this keyed connection's (empty) main database:
 * ATTACH … KEY '' and sqlcipher_export, run here so neither is ever reachable from SQL text. */
int slate_sqlcipher_import_plaintext(sqlite3 *db, slate_conn *conn, const char *plain_path, int *sqlite_rc);
/* SCC_OK, or SCC_ERR_ERROR_STATE once the module is in its error state (no new connection then). */
int slate_sqlite_usable(void);
/* Installed on every connection with its slate_conn: an allowlist (see sqlite_key.c). */
int slate_sqlite_authorizer(void *user, int action, const char *a, const char *b, const char *c, const char *d);
/* binding.c's handle reader (review N2) and error convention (`code` = "SCC_<n>"), shared with the C++. */
int slate_napi_key_handle(napi_env env, napi_value v, uint32_t *out);
void slate_throw_scc(napi_env env, int rc);
/* src/sqlite/better_sqlite3.cpp: the Database/Statement classes, exported by binding.c as `sqlite`. */
napi_value slate_sqlite_exports(napi_env env);
/* src/sqlite/better_sqlite3.cpp: closes every open connection (review M3); binding.c calls it when
 * JavaScript enters the error state or zeroises. */
void slate_sqlite_close_all(void);
#ifdef __cplusplus
}
#endif
#endif

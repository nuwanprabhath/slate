// Vendored from better-sqlite3-multiple-ciphers 13.0.3 (MIT, see LICENSE) and compiled into
// slate_native.node against SQLCipher (audit §4.9, C3). Slate's changes, and nothing else:
//  - registration: slate_sqlite_exports() below instead of NODE_API_MODULE, so binding.c exposes this
//    as `native.sqlite` and the addon keeps exactly its two N-API exports;
//  - keys only from a native key handle (keyWithHandle/rekeyWithHandle, ../sqlite_key.c); the
//    Buffer-taking key/rekey methods are gone, and an authorizer refuses key pragmas in SQL text;
//  - loadExtension, serialize, backup, function, aggregate, table and unsafeMode are not exposed:
//    nothing may load native code, run JavaScript inside SQLite or hand out the decrypted image;
//  - importPlaintextDatabase (migration) does ATTACH + sqlcipher_export natively; SQL text may not;
//  - every connection closes when the module enters its error state (slate_sqlite_close_all).
#include <cassert>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <set>
#include <random>
#include <unordered_map>
#include <algorithm>
#include <mutex>
#include <sqlite3.h>
#include <napi.h>
#include "../slate_crypto_core.h"
#include "../sqlite_key.h"

struct Addon;
// binding.c refuses a second environment, so there is one Addon per process.
static Addon* slate_addon = NULL;
class Database;
class Statement;
class StatementIterator;
class Backup;

#include "util/macros.cpp"
#include "util/helpers.cpp"
#include "util/constants.cpp"
#include "util/bind-map.cpp"
#include "util/data-converter.cpp"

#include "util/row-builder.hpp"
#include "objects/backup.hpp"
#include "objects/statement.hpp"
#include "objects/database.hpp"
#include "addon.cpp"
#include "objects/statement-iterator.hpp"

#include "util/data.cpp"
#include "util/row-builder.cpp"
#include "util/query-macros.cpp"
#include "util/custom-function.cpp"
#include "util/custom-aggregate.cpp"
#include "util/custom-table.cpp"
#include "util/binder.cpp"

#include "objects/backup.cpp"
#include "objects/statement.cpp"
#include "objects/database.cpp"
#include "objects/statement-iterator.cpp"

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
	Napi::HandleScope scope(env);
	Addon::ConfigureURI();

	// Initialize addon instance. The addon is bound to each native-backed class
	// as callback data (rather than per-environment instance data) so that
	// multiple copies of the addon can be loaded into a single environment.
	Addon* addon = new Addon(env);
	slate_addon = addon;
	env.AddCleanupHook(Addon::Cleanup, addon);

	// Create and export native-backed classes and functions.
	exports.Set("Database", Database::Init(env, addon));
	exports.Set("Statement", Statement::Init(env, addon));
	exports.Set("StatementIterator", StatementIterator::Init(env, addon));
	exports.Set("Backup", Backup::Init(env, addon));
	exports.Set("initialize", Napi::Function::New(env, Addon::JS_initialize, "initialize", addon));

	// Store addon instance data.
	addon->Statement = Napi::Persistent(exports.Get("Statement").As<Napi::Function>());
	addon->StatementIterator = Napi::Persistent(exports.Get("StatementIterator").As<Napi::Function>());
	addon->Backup = Napi::Persistent(exports.Get("Backup").As<Napi::Function>());

	return exports;
}

extern "C" void slate_sqlite_close_all(void) {
	if (slate_addon == NULL) return;
	// Poison may close (and erase) a connection, so walk a copy of the set.
	std::vector<Database*> all(slate_addon->dbs.begin(), slate_addon->dbs.end());
	for (Database* db : all) db->Poison();
}

extern "C" napi_value slate_sqlite_exports(napi_env env) {
	napi_value exports;
	if (napi_create_object(env, &exports) != napi_ok) return NULL;
	return Napi::RegisterModule(env, exports, InitAll);
}

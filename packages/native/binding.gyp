# slate_native.node: the N-API addon around slate_crypto_core.c (audit §4.9, listing B.2a), with SQLCipher
# and its better-sqlite3 binding inside the same boundary (C3).
# libcrypto is linked statically from .build/openssl/<platform>-<arch> (scripts/build-openssl.mjs),
# with hidden visibility, and the addon exports only the two N-API entry points (criterion 1,
# checked by scripts/check-exports.mjs). Review H1: no implicit narrowing anywhere in Slate's own C
# (-Wconversion, -Wshorten-64-to-32, -Werror); the core's only length cast is int_len(). The vendored
# third-party sources (the SQLCipher amalgamation, src/sqlite) build in their own targets with their
# upstream warning level, so the relaxation stops at their files.
{
  "variables": {
    # better-sqlite3's deps/defines.gypi (13.0.3), plus what SQLCipher's README requires and
    # SQLITE_OMIT_LOAD_EXTENSION: nothing may load native code into the module boundary.
    # SQLCIPHER_OMIT_LOG: no codec logging (review M2: its TRACE level corrupts memory in 4.19.0).
    "sqlite_defines": [
      "HAVE_INT16_T=1", "HAVE_INT32_T=1", "HAVE_INT8_T=1", "HAVE_STDINT_H=1", "HAVE_UINT16_T=1",
      "HAVE_UINT32_T=1", "HAVE_UINT8_T=1", "HAVE_USLEEP=1",
      "SQLITE_DEFAULT_CACHE_SIZE=-16000", "SQLITE_DEFAULT_FOREIGN_KEYS=1", "SQLITE_DEFAULT_MEMSTATUS=0",
      "SQLITE_DEFAULT_WAL_SYNCHRONOUS=1", "SQLITE_DQS=0", "SQLITE_ENABLE_COLUMN_METADATA",
      "SQLITE_ENABLE_DBSTAT_VTAB", "SQLITE_ENABLE_DESERIALIZE", "SQLITE_ENABLE_FTS3",
      "SQLITE_ENABLE_FTS3_PARENTHESIS", "SQLITE_ENABLE_FTS4", "SQLITE_ENABLE_FTS5", "SQLITE_ENABLE_GEOPOLY",
      "SQLITE_ENABLE_JSON1", "SQLITE_ENABLE_MATH_FUNCTIONS", "SQLITE_ENABLE_PERCENTILE", "SQLITE_ENABLE_RTREE",
      "SQLITE_ENABLE_STAT4", "SQLITE_ENABLE_UPDATE_DELETE_LIMIT", "SQLITE_LIKE_DOESNT_MATCH_BLOBS",
      "SQLITE_OMIT_DEPRECATED", "SQLITE_OMIT_PROGRESS_CALLBACK", "SQLITE_OMIT_SHARED_CACHE",
      "SQLITE_OMIT_TCL_VARIABLE", "SQLITE_SOUNDEX", "SQLITE_THREADSAFE=2", "SQLITE_TRACE_SIZE_LIMIT=32",
      "SQLITE_USER_AUTHENTICATION=0", "SQLITE_USE_URI=0",
      "SQLITE_HAS_CODEC", "SQLCIPHER_CRYPTO_OPENSSL", "SQLITE_TEMP_STORE=3",
      "SQLITE_EXTRA_INIT=sqlcipher_extra_init", "SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown",
      "SQLITE_OMIT_LOAD_EXTENSION", "SQLCIPHER_OMIT_LOG"
    ]
  },
  "target_defaults": {
    "include_dirs": ["src", "<(module_root_dir)/.build/sqlcipher"],
    "defines": ["NAPI_VERSION=10", "<@(sqlite_defines)"],
    "conditions": [
      ["OS=='mac'", {
        "include_dirs": ["<(module_root_dir)/.build/openssl/darwin-<(target_arch)/include"],
        "xcode_settings": { "MACOSX_DEPLOYMENT_TARGET": "12.0", "GCC_SYMBOLS_PRIVATE_EXTERN": "YES" }
      }],
      ["OS=='linux'", {
        "include_dirs": ["<(module_root_dir)/.build/openssl/linux-<(target_arch)/include"]
      }]
    ]
  },
  "targets": [
    {
      "target_name": "sqlcipher",
      "type": "static_library",
      "sources": [".build/sqlcipher/sqlite3.c"],
      "cflags": ["-fvisibility=hidden", "-w"],
      "xcode_settings": { "GCC_C_LANGUAGE_STANDARD": "c11", "MACOSX_DEPLOYMENT_TARGET": "12.0", "WARNING_CFLAGS": ["-w"] }
    },
    {
      "target_name": "sqlite_binding",
      "type": "static_library",
      "sources": ["src/sqlite/better_sqlite3.cpp"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS"],
      "cflags_cc": ["-std=c++20", "-fvisibility=hidden", "-fvisibility-inlines-hidden"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++20", "-stdlib=libc++"],
        "GCC_INLINES_ARE_PRIVATE_EXTERN": "YES"
      }
    },
    {
      "target_name": "slate_native",
      "dependencies": ["sqlcipher", "sqlite_binding"],
      "sources": ["src/slate_crypto_core.c", "src/binding.c", "src/sqlite_key.c"],
      "defines": ["SCC_RELEASE"],
      "cflags": ["-fvisibility=hidden", "-Wall", "-Wextra", "-Wconversion", "-Werror"],
      "cflags_c": ["-std=c11"],
      "conditions": [
        ["OS=='mac'", {
          "include_dirs": ["<(module_root_dir)/.build/pin/darwin-<(target_arch)"],
          "libraries": ["<(module_root_dir)/.build/openssl/darwin-<(target_arch)/lib/libcrypto.a"],
          "xcode_settings": {
            "GCC_C_LANGUAGE_STANDARD": "c11",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Wconversion", "-Wshorten-64-to-32"],
            "GCC_TREAT_WARNINGS_AS_ERRORS": "YES",
            "OTHER_LDFLAGS": [
              "-Wl,-exported_symbol,_napi_register_module_v1",
              "-Wl,-exported_symbol,_node_api_module_get_api_version_v1"
            ]
          }
        }],
        ["OS=='linux'", {
          "include_dirs": ["<(module_root_dir)/.build/pin/linux-<(target_arch)"],
          "libraries": ["<(module_root_dir)/.build/openssl/linux-<(target_arch)/lib/libcrypto.a", "-ldl", "-pthread"],
          "ldflags": ["-Wl,--exclude-libs,ALL", "-Wl,-Bsymbolic", "-Wl,--version-script=<(module_root_dir)/exports.map"]
        }]
      ]
    }
  ]
}

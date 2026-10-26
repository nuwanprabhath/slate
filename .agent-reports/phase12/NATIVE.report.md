# Phase 12 NATIVE: status() and read-only services fail closed in every init state (C2 M2, C6)

Branch `phase12/native` (from main a79d7fc): 8db3642 fix(native), ec261c0 test(desktop), 56b6d9e changelog.

## Root cause
A packaged build with no provider never calls `native.init` (`cryptoModule.ts`: `!withProvider && requireFips` → `fail()`),
so `CRYPTO_secure_malloc_init` never runs. `startCryptoModule` then calls `native.status()`, whose
`scc_secure_heap_used()` called `CRYPTO_secure_used()` unconditionally. That function takes OpenSSL's `sec_malloc_lock`,
which is NULL until the secure heap is initialised, so the process got SIGSEGV. The same thing happens on macOS. The desktop unit test
used a fake native, which hid the crash.

## Fix
- `slate_crypto_core.c`: `scc_secure_heap_used()` returns 0 unless `CRYPTO_secure_malloc_initialized()` (that call takes no lock).
  New `scc_ready()` (init succeeded, not in the error state). `scc_post_passed()` now also requires `g_ready`, so a module
  that never initialised no longer reports `postPassed: true`.
- `binding.c` / `index.ts`: `status()` gains `ready: boolean`.
- Audit of other OpenSSL calls reachable before a successful init: every service starts with `SERVICE_GATE`
  (returns SCC_2 or SCC_12 first). The ungated ones are `scc_fips_active`, `scc_default_ctx_providers` and `scc_fips_module_info`, which check
  for NULL ctx/provider. `provider_in_error` returns early when `g_fips == NULL`. `scc_zeroize_all` and `key_destroy` touch only non-NULL slots,
  and `OpenSSL_version` is static. No other unsafe path was found.
- Desktop: no code change was needed. With status() safe, the existing C2 M2 path (`problem` → `startupSelfTest` → `selftest-failed`
  → error screen, plus `showErrorBox` outside e2e) works as designed. The design keeps the screen up with Quit (C6), and does not exit.

## Tests (red → green)
- `packages/native/test/initState.test.ts` + `initStateChild.mjs` (4 cases: fresh, enterErrorState before init, missing
  provider, wrong pin). RED on the old addon: `fresh` and `errorBeforeInit` exited 139 (SIGSEGV), and missing/wrongPin had no `ready`.
  GREEN: native vitest reported 9 files / 100 tests passed.
- `kat.c`: 4 new pre-init checks (secure heap query, not ready/passed, no provider list or module info, zeroize/in_error_state).
  The KATs passed: plain 164/0, ASan+UBSan 164/0, FIPS 166/0. `check:exports` OK.
- `post.child.test.ts` "C2 M2: a packaged start …" (2 cases, real addon in a child, via `test/selftestChild.ts` `packaged` mode):
  On the old addon it failed with `expected 'SIGSEGV' to be null`. On the fixed addon, post.child passed 24/24.
- typecheck clean, `lint:changed` clean, guards 684 passed, `npm test` 517 passed, `test:main` 117 files / 934 passed (4 skipped),
  `npm run e2e -- selftest.spec.ts` 9 passed.

## Ubuntu 24.04 Docker (slate-e2e-ubuntu, linux-arm64, `electron-builder --dir`, provider then removed from resources/)
- Pre-fix addon: `slate --no-sandbox` exited 139, "Segmentation fault".
- After rebuilding the addon from the fixed src and repackaging, the app stays up. It shows the "Slate stopped" dialog, and after that the window
  is `app://slate/index.html?selftest-failed=POST-MODULE-LOAD`. Screenshots: `NATIVE-dialog.png`, `NATIVE-selftest-failed.png`.
  The container is removed. electron-builder's beforePack refuses to package without `fips.so`/`fipsmodule.cnf`, so stand-in files were used
  to build the package and then deleted from `resources/fips`.

## Design decisions / notes
- I added `ready` to `NativeStatus` instead of throwing from status(), because status() must always answer (the diagnostics report reads it).
- Finding: after a failed init, `defaultContextProviders` reads `default`, because OpenSSL's global ctx auto-loads it on query. Nothing
  relies on it, and every service still refuses with SCC_12, but a diagnostic reader could misread it. I left it for the maintainer.
- Check log: typecheck failed on two hand-written `NativeStatus` fixtures (cryptoModule.test.ts, report.test.ts), so I added `ready`.
- No guard files were touched, nothing was pushed, and no Electron process was left running.

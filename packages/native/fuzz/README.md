# Fuzzing the C core

Five harnesses run `src/slate_crypto_core.c`, built with `-DSCC_KAT_BUILD` (the build `test/kat.c` uses:
raw key import, `scc__slot_bytes_for_kat`, a caller-chosen GCM IV), against the static libcrypto. Each is
an `LLVMFuzzerInitialize` and an `LLVMFuzzerTestOneInput`, so the same file links against libFuzzer or
against `standalone.c`.

## Running

| What | Command |
| --- | --- |
| Every harness under ASan + UBSan, any OS: the corpus, then 20,000 seeded mutations each | `npm run -w @slate/native fuzz:smoke` |
| One harness, other run count or seed | `node scripts/fuzz.mjs --smoke --harness ops --runs 200000 --seed 7` |
| libFuzzer (Linux clang with its fuzzer runtime) | `npm run -w @slate/native fuzz -- --harness gcm --seconds 60` |
| Either, through the FIPS provider (approved-only branches) | add `--fips` |

Build libcrypto first (`npm run -w @slate/native build:openssl`). Binaries go to `build/fuzz/`. Apple's
command-line clang has no libFuzzer runtime (`libclang_rt.fuzzer_osx.a not found`); there `fuzz` says so
and exits 2, and `fuzz:smoke` is the way to run the harnesses.

## What each oracle means

Every harness: no sanitizer report, every return code is an `SCC_*` code, and no key handle outlives the
input. A failed check prints `FUZZ_CHECK failed: <name>` and aborts.

| Harness | Input | Oracles |
| --- | --- | --- |
| `fuzz_recovery` | Text for `scc_recovery_decode` | Only `SCC_OK` or `SCC_ERR_ARG`. No read past `len` (the separator lookahead). A text that decodes, written again by the harness's own base32 writer and decoded, derives the same `scc_hkdf_recovery` KEK. |
| `fuzz_gcm` | key, IV, AAD, ciphertext and tag; or a plaintext sealed first, then one byte changed or not | `scc_gcm_open` returns `SCC_OK` or `SCC_ERR_AUTH`. On `SCC_ERR_AUTH` the plaintext buffer, pre-filled with `0xA5`, is all zero (`plaintext released after a failed tag`). On `SCC_OK`, sealing the plaintext again reproduces the input. A changed byte never opens; an unchanged seal always does. |
| `fuzz_wrap` | Wraps and proofs for `scc_gcm_open_key_for`, `scc_rewrap_key`, `scc_history_seal`, `scc_history_rewrap`, `scc_history_open`, every usage, every KEK class, raw or valid-then-changed | No new handle on any failure, and the 60-byte output (IV and wrapped key) untouched. A handle only with a usage `wrap_allowed` permits; `history_open` gives only MASTER keys. A valid wrap through an allowed KEK succeeds. |
| `fuzz_ops` | A byte program over the handle table: create, destroy, KBKDF, legacy HKDF, HMAC, AES-CTR, SIV names, SQLCipher key text, `scc_zeroize_all`, with live, destroyed, stale-generation, wrong-approval-bit and out-of-range handles, labels of 0, 1, 128, 129 bytes and with a NUL | A handle that is not live gives `SCC_ERR_HANDLE` (`a stale handle named a live key`). `scc_live_handles()` equals the harness's own count after every step. A destroyed key's bytes are gone. After `scc_zeroize_all` the count is 0 and `scc_secure_heap_used()` is at its baseline. `decode(encode(p)) == p`; a changed name gives `SCC_ERR_AUTH` and a zeroed output. |
| `fuzz_mldsa` | A valid ACVP vector (`test/vectors/mldsa/sigver.h`) with level, length and byte edits; or raw fields | Only `SCC_OK`, `SCC_ERR_AUTH`, `SCC_ERR_ARG`, `SCC_ERR_TOO_LARGE`, `SCC_ERR_CRYPTO`. The unchanged vector verifies; any input whose bytes differ never returns `SCC_OK`. |

What a destroyed key's bytes are: OpenSSL's secure heap keeps its free-list links (two pointers) in the
first 16 bytes of a freed block, so the harness checks that bytes 16 to 31 are zero and that neither
8-byte word of the first 16 is still the key's.

## Limits

- libcrypto is not instrumented. An overrun inside OpenSSL is seen only where it crosses an exactly sized
  harness buffer (every field is copied into a `malloc` of exactly its length).
- The standalone driver's mutator is blind (no coverage feedback); the nightly libFuzzer run is the deep one.
- Leaks are not an oracle (`detect_leaks=0`): OpenSSL's caches and the secure heap outlive an input.

## When a harness finds something

1. The standalone driver writes the input to `build/fuzz/crashes-<harness>/crash-<round>` (or
   `crash-replay-<n>` for a corpus file); libFuzzer writes `build/fuzz/crashes-<harness>/crash-<sha1>`.
   The smoke's `FAIL` line names the seed; the same `--seed` and `--runs` reproduce it.
2. Minimise: `build/fuzz/fuzz_<harness> -minimize_crash=1 -runs=10000 <crash file>` (Linux), or by hand.
3. Commit it as a corpus file, `fuzz/corpus/<harness>/<first 16 hex of its sha256>.bin` (at most 64 KiB),
   before the fix: that commit is red, and the file is replayed by every smoke from then on.
4. A memory-safety crash file is a working reproducer: keep it off public artefacts (the fuzzing plan, §2.5).

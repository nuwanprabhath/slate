# Fuzzing Implementation Plan: Slate

Reviewed: `main` at `5aa9610` (v0.7.3), 2026-11-12. Method: direct reading of `packages/*`, the guard layer (`tools/`, `.dependency-cruiser.cjs`, `eslint.config.mjs`, `scripts/agents/`), the CI workflows and `docs/compliance/`. Five claims were checked by running code and are marked **measured** or **run**; everything else is from reading. The measurements ran under Node 22.23.3 on the maintainer's Mac, not under Electron 45, so the timings show the class of the defect, not the number a user would see. Nothing in the application, `package.json` or the workflows was changed for this audit.

**Goal.** Every boundary where Slate reads bytes it did not write gets a harness that generates hostile input and checks one stated property, deterministically on every pull request and at depth every night.

**Architecture.** Three engines, each where it is the cheapest one that can see the bug: `fast-check` properties and state-machine models inside the existing Vitest projects; byte-corpus replay and seeded mutation inside those same projects, with a worker-thread deadline for code that can hang; libFuzzer with AddressSanitizer and UndefinedBehaviorSanitizer for the C core of `@slate/native`. Jazzer.js is a gated spike, not a dependency of this plan.

**Tech stack.** `fast-check` 4.10.2 (already a root devDependency), Vitest 5, clang with `-fsanitize=fuzzer,address,undefined` on `ubuntu-24.04`, the static libcrypto that `packages/native/scripts/kat.mjs` already links.

## 1. Executive Summary & Threat/Surface Matrix

### 1.1 Where fuzzing stands today

Slate already fuzzes its vault file parsers well, and nothing else at depth.

| Existing harness | What it covers | Scale |
| --- | --- | --- |
| `packages/desktop/src/main/vault/fuzz.test.ts` (T-FUZZ-01 to -04, -10 to -12), `envelope2.test.ts` (T-FUZZ-05 to -09), `localJsonCaps.test.ts` (T-FUZZ-13) | Vault header, envelope, local key files, recovery key text, SIV names | 2,000 runs, seed `0x51a7e`; 200,000 nightly (`.github/workflows/nightly.yml`, job `fuzz-soak`) |
| `packages/sync/test/simulationFaults.test.ts` with `faultyDrive.ts` | Three devices over a drive that drops, stalls, crashes, reorders | 500 plans (`SLATE_SIM_RUNS`), in-memory `LocalStore` only |
| `packages/mcp/test/privateCanary.test.ts` | Private-box canary through every MCP tool | 60 runs, fixed seed `0x5c0a7e`, in-memory `DocSource` only |
| `packages/native/test/kat.c` under ASan and UBSan (`npm run -w @slate/native test:kat:asan`) | Fixed known-answer vectors | No generated input |

The shared kit is `packages/desktop/test/fuzz.ts` (`FUZZ_SEED`, `FUZZ_RUNS`, `fcParams`, `fuzzTimeout`, `Rng`, `forAll`, `jsonValue`, `mutation`, `apply`). This plan extends that kit and keeps its conventions: a fixed seed in CI, `SLATE_FUZZ_RUNS` and `SLATE_FUZZ_SEED` for the soak, and a shrunk counterexample that becomes a permanent case.

The gaps are the document store and save path (data loss), the native module's C entry points under generated input (memory safety), the IPC and MCP boundaries, and every text parser outside the vault.

### 1.2 Targets ranked by severity

| # | Severity class | Target (files, functions) | Vulnerability class the harness prevents | Engine | Strengthens | Task |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Data loss | `packages/desktop/src/main/store.ts`: `DocStore.append`, `compact`, `loadSince`, `changedDocs`, `remove` | Compaction or a reopen destroying an acknowledged update; an incremental reader diverging from a full load | `fast-check` model (`fc.commands`) on a real SQLCipher database | Architecture review F2 (B2, B3, B4; `T-B3-*`, `T-B4-*` in `store.test.ts`) | F2a |
| 2 | Data loss | `packages/editor/src/saveQueue.ts`: `SaveQueue` | A stored update that depends on one the store rejected; a commit left unscheduled | `fast-check` model with a failing `SaveSink` | Architecture review F1 (B1) | F2b |
| 3 | Data loss | `packages/sync/src/engine.ts` (`pushDoc`, `pull`, `compact`, `selfCheck`, `afterPull`) over `packages/desktop/src/main/sync/localStore.ts` (`docStoreLocal`) and a real `DocStore` | An edit lost when a sync fault and a local compaction interleave | `fast-check` scenarios, `faultyDrive` | Architecture review F8, F2 | F2d |
| 4 | Cryptographic and memory safety | `packages/native/src/slate_crypto_core.c`: `scc_recovery_decode`, `scc_gcm_open`, `scc_gcm_open_key_for`, `scc_rewrap_key`, `scc_history_seal`/`_rewrap`/`_open`, `scc_name_siv_decode`, `scc_mldsa_verify`, the handle table (`slot_of`, `alloc_slot`, `scc_key_destroy`, `scc_zeroize_all`) | Out-of-bounds read or write, a stale or forged handle naming a live key, plaintext left in the output buffer after a failed tag, a leaked handle | libFuzzer + ASan/UBSan (Linux, nightly); the same harnesses under a standalone driver (every OS, every PR) | T-ZERO-03 (`kat.c`), T-ZERO-01, F-FIPS-06; POAM-18 (ML-DSA verification outside the validated boundary) | F1a |
| 5 | Cryptographic and memory safety | `packages/native/src/binding.c`: `get_bytes`, `get_handle`, `get_string`, `get_uint_in`, `get_password_args`, the async Argon2id and PBKDF2 jobs | A JavaScript value that crashes the process, truncates a length, or is read while another thread changes it | `fast-check` through the real addon | T-POST-06 (`native/addon.test.ts`), the C2 boundary criteria in `packages/native/test/surface.test.ts` | F1b |
| 6 | Sandbox and IPC escape | `packages/desktop/src/main/ipc.ts`, `vaultIpc.ts`, `ipcGuard.ts` (`SECRET_CHANNELS`, `secretHandler`), `packages/desktop/src/shared/ipcValidators.ts`, `shared/settings/schema.ts` (`sanitizePatch`, `mergeSettings`) | A payload reaching a service with an unchecked shape, prototype pollution, a secret argument left unzeroed | `fast-check`, channels enumerated from the registrar | Architecture review F7 (C1); T-B-02, T-B-03; the T-ZERO-04 lineage and POAM-10 | F4a |
| 7 | Sandbox and IPC escape | `main/openExternal.ts` (`safeExternalUrl`), `main/appProtocol.ts` (`resolveAppPath`, `isAppUrl`, `isAppEntry`), `main/blobs.ts` (`blobNameFromUrl`), `shared/gitRemote.ts` (`isAllowedRemote`, `isAllowedBranch`, `isAllowedRepoName`), `packages/sync/src/transport.ts` (`remoteTransport`, `parseSshKex`, `parseCurlTls`) | Path traversal out of the renderer root or blob folder, scheme smuggling, a git argument that starts with `-`, a credential written into `transport_observations` | `fast-check` | T-B-01, T-B-04; architecture review C3 | F4b |
| 8 | AI privacy leak | `packages/mcp/src/{tools,server}.ts`, `packages/core/src/agentView.ts` (`agentBoxes`, `placeBelow`), `packages/desktop/src/main/mcp/docSource.ts` (`storeDocSource` and its cache) | A private box's content in any tool response or audit row; a tool write that changes a private box; a stale cached projection that predates a box being made private | `fast-check` stateful, real `DocStore` | Architecture review F6 (A2, D5) | F4d |
| 9 | Sandbox escape through content | `packages/editor/src/clipboard.ts` (`cleanPastedHtml`, `storeDataImages`), `staticRender.ts` (`renderStaticHtml`), `links.ts` (`normalizeLinkInput`) | Script, event-handler attributes or a `javascript:` address surviving a paste, or reaching the page from a synced or agent-written document | `fast-check` + corpus under happy-dom; a Chromium differential for parser disagreements | T-B-01, T-B-04; the CSP ratchet in `tools/guards/packaging.test.ts` | F3b, F3f |
| 10 | Hostile remote | `packages/sync/src/engine.ts` `pull`, `packages/sync/src/paths.ts` (`parseRemotePath`, `docIdFromKey`), `LoroDoc.import` on remote bytes | A remote path that makes the engine write to a document id of the attacker's choosing; a spoofed own-device file forcing a full re-push; a decoder fault that poisons the shared WebAssembly instance | `fast-check` + byte mutation of real updates | T-FUZZ-05 to -09 and T-POL-07 (the envelope layer above this one) | F2c |
| 11 | Main-thread denial of service | `packages/core/src/find.ts` (`compileQuery`, `matchAll`, `hasNestedUnboundedQuantifier`), `packages/desktop/src/main/search/searchIndex.ts` (`SearchIndex.query`), `packages/editor/src/find.ts` | A search pattern that never returns: the window freezes, and in main the idle lock cannot fire | Grammar-generated patterns with a worker-thread deadline | Architecture review F5 (B5) | F3a, F3e, FX-1 |
| 12 | Denial of service and file disclosure on import | `packages/importer/src/one2html.ts` (`normalizeOne2HtmlPage`, `parseOne2HtmlSection`), `map.ts` (`mapOneNotePage`), `packages/desktop/src/main/onenote/backup.ts` (`BackupSource`) | Stack overflow or quadratic time on a crafted page; a page file read from outside the conversion folder; the converter writing outside its output folder | `fast-check` HTML + corpus; nightly black-box mutation of a `.one` file | none today | F3c, F3d, FX-2, FX-4 |
| 13 | MCP transport | `packages/desktop/src/main/mcp/lineTransport.ts` (`LineTransport`), `proxy.ts` (`runProxy`, `lockedReply`), `socketServer.ts` | A frame boundary that changes the message, a request left unanswered, an uncaught throw from a stream handler, corrupted text | `fast-check` over every chunking of a byte stream | Architecture review F6 (A2 limits in `mcp.test.ts`) | F4c, FX-5 |
| 14 | Update integrity | `packages/desktop/src/main/update/signature.ts` (`parseSignatureFile`, `parsePqSignatureFile`, `parseManifest`, `verifyDetached`), `versions.ts` (`parseVersion`, `isNewer`), `pickInstaller.ts` | A malformed feed accepted, an error type other than the parser's own, a version order that permits a downgrade | `fast-check` | T-UPD-01, T-UPD-02, F-NIST-06; POAM-06 | F1c |
| 15 | Privacy of the diagnostic log | `packages/desktop/src/shared/redact.ts` (`redactString`, `redact`) | A credential shape that survives redaction; quadratic time on a long field | `fast-check` | `C10-redaction-test` (`packages/desktop/test/spec/redact.test.ts`) | F4e, FX-3 |

### 1.3 Defects found during the audit

These were found by hand while choosing targets. Each becomes the first regression seed of the harness named beside it, and each fix is its own branch (section 3, lane FX), because the fix is a product decision and the harness is not.

| # | Finding | Evidence |
| --- | --- | --- |
| M1 | `compileQuery` refuses only nested unbounded quantifiers. Alternation under a quantifier and a bounded repeat of an unbounded group still compile, and they backtrack without limit. `SearchIndex.query` checks `SCAN_BUDGET_MS` between rows, never inside one match, so one row is enough. v0.7.3's changelog says the in-page find no longer freezes; that holds for `(a+)+$` only. | **Measured**: `(a\|a)+$` against 26 characters took 5.1 s; `(a\|aa)+$` against 34 took 1.2 s; `(.*a){12}$` against 60 was killed after 110 s. All three passed `hasNestedUnboundedQuantifier` and compiled. |
| M2 | `linkFieldCodes` in `packages/importer/src/one2html.ts` restarts its scan of the whole outline after each field code and recurses to do it. | **Measured**: 1,000 field codes in one paragraph took 148 ms, 3,000 took 1.16 s, and 8,000 (a 320 KB page) threw `RangeError: Maximum call stack size exceeded`. |
| M3 | `redactString` runs its patterns over the whole string and truncates to 512 characters afterwards. Two inputs are quadratic. | **Measured**: 896 KB of repeated `-----BEGIN PRIVATE KEY-----` lines took 5.1 s; 704 KB of 21-character alphanumeric runs joined by `.` took 10.6 s. Not established: which rule causes the second case, and whether any log call site can pass a field that long. |
| M4 | `BackupSource.listPages` joins the page file name from the converter's index onto the conversion folder and `pageContent` reads it, with no check that it stays inside. `resource()`, forty lines below, has that check. | Code reading; not run. It is exploitable only if `one2html` 2.0.1 writes a traversing `href` for a crafted `.one` file, which was not tested. |
| M5 | `runProxy` decodes each stream chunk to text on its own (`chunk.toString('utf8')`), in both directions, so a multi-byte character split across two chunks is replaced. An agent then reads, or searches for, text the notes never held. | **Run**: a reply containing `5€` arrived as `5` followed by three U+FFFD; a request for `café` was forwarded as `caf` followed by two U+FFFD. |

### 1.4 Out of scope

- OpenSSL, SQLCipher, SQLite, Chromium and Electron internals. Their own projects fuzz them; Slate's harnesses stop at Slate's call into them.
- Loro's decoder beyond the import boundary. F2c checks what Slate does with a decoder fault and reports decoder bugs upstream.
- MemorySanitizer. It needs an instrumented libcrypto, and uninitialised output is covered more cheaply by the explicit zero checks in F1a.
- `cargo-fuzz`. The repository holds no Rust source: `one2html` 2.0.1 is installed from crates.io by `scripts/build-one2html.mjs` and run as a child process. F3d fuzzes that process from outside.

## 2. Tooling, CI Integration & Corpus Strategy

### 2.1 Engines and dependencies

| Layer | Engine | Dependency change | Where it runs |
| --- | --- | --- | --- |
| TypeScript state machines, validators, parsers | `fast-check` 4.10.2 in Vitest | None. It is already in the root `package.json` and approved in `tools/guards/allowlists/dependencies.json`. F5b rewords that approval, which today names only `vault/fuzz.test.ts`. | `npm test`, `npm run test:main` |
| Byte and text parsers that can hang or blow the stack | Corpus replay and seeded mutation in Vitest, with `regexDeadline` (a `node:worker_threads` worker the test can terminate) | None | `npm test`, `npm run test:main` |
| `slate_crypto_core.c` | libFuzzer + ASan + UBSan | No npm package. The nightly job installs clang and the package that carries its fuzzer runtime with `apt-get`; F5b confirms that package's name on the runner image. | `ubuntu-24.04`, nightly |
| The same C harnesses | Standalone driver (`packages/native/fuzz/standalone.c`) under ASan + UBSan | None | Every OS, every PR, after `test:kat:asan` |
| Coverage-guided JavaScript | `@jazzer.js/core`, only if spike F5c passes | A new `tools/fuzz/package.json` with its own lockfile, as `tools/lint` has, plus one line in `dependencies.json`. Never the root manifest. | Nightly only |

Three facts set these choices.

- **Apple's command-line clang cannot link libFuzzer.** `cc -fsanitize=fuzzer,address` fails here with `libclang_rt.fuzzer_osx.a not found` (**run**, Apple clang 21). So the libFuzzer build is Linux-only, and each harness is a plain `int LLVMFuzzerTestOneInput(const uint8_t *, size_t)` that the standalone driver also calls. The driver replays the corpus and then runs a seeded mutation loop, so macOS developers and the macOS CI legs still execute every harness under the sanitizers.
- **Coverage guidance cannot see the two parsers that most need it.** Loro's decoder is WebAssembly and the paste sanitiser's parser is the browser's. A JavaScript instrumenter gives no feedback from either. That is why mutation from a real corpus is the baseline, and why Jazzer.js is a spike with exit criteria and not a foundation.
- **Jazzer.js's state was not verified first hand.** A web search reported version 4.0.0 (April 2026) with ESM support and a move to Jest-style fuzz tests. F5c's first step is to confirm the version, its install scripts and its Node 22 support against the registry before anything is added.

No task adds a root dependency, a root script or a Vitest config change. Every new test file matches a glob that `tools/guards/testConfig.test.ts` already pins.

### 2.2 Naming

| Thing | Rule |
| --- | --- |
| Stateless property files | `<subject>Fuzz.test.ts` |
| State-machine files | `<subject>Model.test.ts` |
| Test titles | Start with `T-<task>-<nn>`, for example `T-F2A-01: …`. This form does not match `scripts/traceability.mjs`'s id pattern (`\bT-[A-Z]+-\d+\b`), so parallel branches never change `docs/compliance/traceability.yaml`. F5b promotes chosen properties to `T-FUZZ-14` onward in one serial step. |
| Byte corpora | `packages/<pkg>/test/corpus/<target>/<first 16 hex of sha256>.<ext>`; the native harnesses use `packages/native/fuzz/corpus/<harness>/` |
| Task reports | `.agent-reports/fuzz/<task>.md` in the main checkout (gitignored) |

### 2.3 Pull-request lane: fast and deterministic

- Seed `0x51a7e` and 2,000 runs through `fcParams`, as today. A property whose single run is expensive divides the count with `fcRuns(divisor)` (F5a), the way T-FUZZ-08 already does with `Math.max(300, Math.floor(fcParams.numRuns / 10))`.
- Budget: each new file finishes in under 10 s on a quiet machine at the default run count, and each task's report states the measured time. The whole plan adds at most 90 s to `npm test` and 60 s to `npm run test:main`.
- No wall-clock assertion uses an absolute number alone. The repository already learnt this: `vault/fuzz.test.ts` replaced `mean < 5 ms` with a ratio to a benign call measured in the same run, after the absolute bound failed at load average 25 to 40. F5a moves that oracle into the kit as `relativeCost`. Six agents running tests at once produce exactly that load.
- Every corpus file is replayed as its own test case by `replayCorpus`, so a past crash is a permanent unit test.
- The native smoke (`npm run -w @slate/native fuzz:smoke`) replays the native corpus and runs 20,000 seeded mutations per harness under ASan and UBSan. F5b adds it to the `native` job in `.github/workflows/ci.yml` after "Native KATs under ASan/UBSan".

### 2.4 Nightly lane: deep

F5b changes `.github/workflows/nightly.yml`; no other task touches a workflow.

| Job | What it runs | Budget |
| --- | --- | --- |
| `fuzz-soak` (existing, widened) | Every `*Fuzz.test.ts` and `*Model.test.ts` plus the three vault files it names today, with `SLATE_FUZZ_RUNS=200000`, `SLATE_SIM_RUNS=20000` and the seed set to `github.run_number` | 120 min |
| `fuzz-native` (new) | The five libFuzzer binaries, each with `-max_total_time=600 -timeout=10 -rss_limit_mb=2048`, starting from the committed corpus plus the cached one | 60 min |
| `fuzz-converter` (new) | F3d's black-box run of the real `one2html` over mutated `.one` files | 30 min |

Corpus persistence has two tiers.

- **Committed regression corpus.** Small (each file at most 64 KiB, each target folder at most 1 MiB), named by content hash, replayed on every PR. It only grows: F5b's guard refuses a deleted corpus file the way `ratchet.test.ts` refuses a lost test file.
- **Evolving nightly corpus.** Kept between runs with `actions/cache`, keyed per harness with a `restore-keys` prefix. That action is not used in the repository yet, so F5b pins it by commit SHA as every other action is pinned. CI never commits: `permissions: contents: read` stays.

`nightly.yml` does not block a release today (its own header says so). This plan does not change that; it is the maintainer's decision.

### 2.5 When a harness finds something

1. **Reproduce** from the printed seed (`SLATE_FUZZ_SEED=<n> SLATE_FUZZ_RUNS=<n> npx vitest run <file>`) or from the libFuzzer crash file.
2. **Minimise.** `fast-check` prints the shrunk counterexample; libFuzzer takes `-minimize_crash=1`; a JavaScript byte input goes through `minimizeBytes` (F5a).
3. **Commit the seed first.** A structured counterexample becomes a fixed `it('T-… (found <date>, seed <n>)')` case in the same file; a byte input becomes a corpus file. That commit is red, which satisfies the Stop hook's "seen failing on the base".
4. **Fix on the same branch**, in a `fix:` commit, through the usual review tier.
5. **Never weaken the generator to get green.** A generator may exclude a class only with a comment naming the open finding (`M1`, `FX-1`), and the branch that fixes the finding removes the exclusion.

One decision is the maintainer's: where crash inputs go. A memory-safety or private-box crash file is a working reproducer. If the GitHub repository is public, a workflow artefact is downloadable by any signed-in user. The plan's default is that `fuzz-native` uploads the sanitizer report and the input's SHA-256 only, and the input is reproduced locally from the seed; uploading the raw input is a one-line change if the repository is private.

## 3. Parallel Implementation Tracks (Sub-Agent Blueprints)

**Rules that apply to every task**

- A task owns the files it lists and edits no others. Section 4 names the owner of every shared file.
- No task except F5b and F5c edits a guard file: the root `package.json`, `.github/workflows/**`, `tools/guards/**` (the allowlist JSON files aside), `tools/eslint-rules/**`, `tools/lint/**`, any `vitest*.config.*` or `tsconfig*.json`, `eslint.config.mjs`, `.dependency-cruiser.cjs`, `.claude/**`, `.githooks/**`, `scripts/agents/**`, `packages/*/{test,e2e}/spec/**`.
- No task edits `CHANGELOG.md` or a version. Each report ends with one proposed changelog line; the lead adds it and bumps the version at merge.
- Tests are registered unconditionally and every case asserts (`expect.requireAssertions`). A new file holds no `.skip`, `.todo`, `.skipIf` or `.runIf`: `tools/guards/testConfig.test.ts` counts those per file against the base, and a new file's base is zero.
- Run counts and seeds come only from the kit (`fcParams`, `fcRuns`, `FUZZ_SEED`). No test reads `process.env` itself and none uses `Math.random` or `Date.now` as a seed.
- A harness for existing behaviour passes on `main`, so the Stop hook's "seen failing on the base" cannot be met by the harness alone. Each such commit carries `No-Red-Test-Reason: fuzz harness for existing behaviour; shown red against a seeded bug in the task report`. The proof is in the report: apply the seeded bug named in the task as a scratch edit, run the verification command, paste the failing output with its counterexample, run `git checkout -- <file>`, run again and paste the pass. The seeded bug is never committed.
- **A property that fails on `main` is a finding, not a test to bend.** Stop work on that property, write the seed and the shrunk counterexample in the report, and land the rest. The finding gets its own FX branch.
- Time oracles are ratios (`relativeCost`) or deadlines at least a hundred times the expected cost. Up to six agents run suites at the same time.
- Worktrees are made from `main` with the copy-on-write recipe in `CLAUDE.md` ("Worktrees on macOS"). F1a and F1b also clone `packages/native/.build`, which holds the static libcrypto.
- Commits are Conventional (`test(sync): …`) and carry no AI attribution.

### Track F5 (first part): the shared kit

#### F5a. Fuzz kit

- **Target Subsystem & Exclusive Modified Files:** Modify `packages/desktop/test/fuzz.ts`. Create `packages/desktop/test/fuzzBytes.ts`, `fuzzCorpus.ts`, `fuzzHtml.ts`, `fuzzDeadline.ts`, `fuzzRegexWorker.mjs`, `fuzzKit.test.ts`. Modify `packages/desktop/src/main/vault/fuzz.test.ts` only to import `relativeCost` in place of its local `parseCost`; its constants and thresholds stay byte for byte.
- **Fuzzing Target & Invariant/Oracle:** The kit is itself tested. Same seed gives the same bytes; `minimizeBytes` returns an input that still fails and is no longer than the original; `regexDeadline` reports `timeout` for `(a|a)+$` against 30 `a` and a `!` within its deadline and stays usable afterwards; `unsafeMarkup` flags each of a fixed list of twenty known script-carrying snippets and flags nothing in Slate's own copied HTML.
- **Interfaces produced** (every later task relies on these names):

  ```ts
  // packages/desktop/test/fuzz.ts — existing exports unchanged
  /** fcParams with the run count divided, for a property whose single run is expensive. */
  export function fcRuns(divisor: number, floor?: number): { numRuns: number; seed: number; endOnFailure: true }
  /** vault/fuzz.test.ts's parseCost, moved: hostile calls timed against a benign call measured in the same run. */
  export function relativeCost(benign: () => void, limits?: { meanOverBenign?: number; p99OverBenign?: number; meanCeilingMs?: number; absoluteCeilingMs?: number }): { time(fn: () => void): void; check(): void }

  // packages/desktop/test/fuzzBytes.ts
  export function mutateBytes(rng: Rng, seed: Uint8Array, maxLength?: number): Uint8Array // flip, set, insert, delete, repeat a span, truncate
  export function chunkings(bytes: Uint8Array): fc.Arbitrary<Uint8Array[]>               // every split of a stream into chunks
  export function minimizeBytes(input: Uint8Array, stillFails: (candidate: Uint8Array) => boolean): Uint8Array

  // packages/desktop/test/fuzzCorpus.ts — corpus at packages/<pkg>/test/corpus/<target>/
  export function corpusEntries(pkg: string, target: string): Array<{ name: string; bytes: Uint8Array }>
  /** Registers one it() per corpus file, in a loop, so each past crash is its own test case. */
  export function replayCorpus(pkg: string, target: string, run: (bytes: Uint8Array, name: string) => void | Promise<void>): void

  // packages/desktop/test/fuzzHtml.ts
  export const hostileHtml: fc.Arbitrary<string> // tag soup: unclosed and misnested tags, entities, foreign content (svg, math), handler attributes, comments
  export const hostileUrl: fc.Arbitrary<string>  // schemes split by tabs and newlines, entity-encoded, mixed case, userinfo, percent-encoded traversal
  /** What is wrong in a DOM tree: script-capable elements, on* attributes, and addresses whose scheme, read as a URL parser reads it, is not allowed. */
  export function unsafeMarkup(root: ParentNode, allowedSchemes?: readonly string[]): string[]

  // packages/desktop/test/fuzzDeadline.ts (worker: fuzzRegexWorker.mjs)
  export function regexDeadline(): { exec(source: string, flags: string, text: string, ms: number): Promise<'done' | 'timeout'>; close(): Promise<void> }
  ```

- **Protocol (Step-by-Step):**
  1. Write `fuzzKit.test.ts` with the four checks above; run it and see it fail on the missing imports.
  2. Add `fcRuns`; move `parseCost` out of `vault/fuzz.test.ts` as `relativeCost`, taking its four thresholds as defaults, and import it back.
  3. Write `fuzzBytes.ts`, then `fuzzCorpus.ts` (reads with `node:fs`; the kit lives outside `src/`, so no boundary rule applies).
  4. Write `fuzzHtml.ts`. `unsafeMarkup` normalises a scheme the way `urlOf` in `packages/editor/src/clipboard.ts` does before comparing.
  5. Write `fuzzRegexWorker.mjs` (receives `{ source, flags, text }`, runs the `exec` loop, posts `done`) and `fuzzDeadline.ts` (one worker, terminated and replaced on timeout). It is plain JavaScript so it loads the same way under Node and under Electron's Node.
  6. Run both suites that import the kit.
- **Verification Commands:**
  - `npx vitest run packages/desktop/test/fuzzKit.test.ts` passes.
  - `npm run test:main -- src/main/vault/fuzz.test.ts` passes with the same case count as on `main`.
  - Seeded bug: make `regexDeadline` resolve `done` without waiting for the worker. `fuzzKit.test.ts` fails on the `(a|a)+$` case.
- **Parallelization Constraints:** Wave 1. The other wave 1 tasks use only what `fuzz.ts` exports today, so they do not wait for this. Every later task imports the kit by relative path (`../../desktop/test/fuzz`); that is allowed from `packages/core` and `packages/editor` tests because the `slate/core-stays-pure` and `slate/editor-stays-in-the-renderer` rules cover `src/**` only, and it has a precedent in `packages/native/test/pq.test.ts`. After F5a merges, a change to the kit goes to the lead as a request.

### Track F1: Native Crypto & Memory Fuzzing

#### F1a. libFuzzer harnesses for the C core

- **Target Subsystem & Exclusive Modified Files:** Create `packages/native/fuzz/{harness.h,fuzz_recovery.c,fuzz_gcm.c,fuzz_wrap.c,fuzz_ops.c,fuzz_mldsa.c,standalone.c,README.md}`, `packages/native/fuzz/corpus/<harness>/`, `packages/native/scripts/fuzz.mjs`. Modify `packages/native/package.json` (two scripts: `fuzz:smoke`, `fuzz`).
- **Fuzzing Target & Invariant/Oracle:** `slate_crypto_core.c` compiled with `-DSCC_KAT_BUILD` (the build `kat.c` uses, which adds `scc_key_import_for`, `scc__slot_bytes_for_kat` and a caller-chosen IV) and linked to the static libcrypto. Every harness: no sanitizer report; every return code is a member of the `SCC_*` enum; `scc_live_handles()` is back at its starting value when the input ends.

  | Harness | Input | Property that must never be violated |
  | --- | --- | --- |
  | `fuzz_recovery` | Text for `scc_recovery_decode` | Only `SCC_OK` or `SCC_ERR_ARG`. No read past `len` (the three-byte separator lookahead in `recovery_separator` is the risk). A text that decodes, re-encoded by the harness's own base32 writer and decoded again, gives a handle whose `scc_hkdf_recovery` output is identical. |
  | `fuzz_gcm` | key, IV, AAD, ciphertext and tag | `scc_gcm_open` returns `SCC_OK` or `SCC_ERR_AUTH`. On `SCC_ERR_AUTH` the plaintext buffer, pre-filled with `0xA5`, is all zero. On `SCC_OK`, sealing the plaintext under the same key, IV and AAD reproduces the input bytes. |
  | `fuzz_wrap` | Wrapped keys and proofs for `scc_gcm_open_key_for`, `scc_rewrap_key`, `scc_history_seal`, `scc_history_rewrap`, `scc_history_open`, with every usage value | No output handle on any failure. No handle is produced with a usage `wrap_allowed` forbids. The 60-byte output buffer is untouched on failure. |
  | `fuzz_ops` | A byte-coded sequence of operations over the handle table: `scc_key_random_for`, `scc_key_destroy`, `scc_kbkdf_for`, `scc_hkdf_legacy_for`, `scc_hmac_sha256`, `scc_aes_ctr`, `scc_name_siv_encode`/`_decode`, `scc_sqlcipher_raw_key`, `scc_zeroize_all`, called with live, destroyed, stale-generation, wrong-approval-bit and out-of-range handles, and labels of 0, 1, 128 and 129 bytes with and without NUL | A handle that is not live always gives `SCC_ERR_HANDLE`. `scc_live_handles()` equals the harness's own count. After `scc_key_destroy`, the 32 bytes at the address `scc__slot_bytes_for_kat` returned beforehand are zero. After `scc_zeroize_all`, the count is 0 and `scc_secure_heap_used()` is back at its baseline. `scc_name_siv_decode(scc_name_siv_encode(p)) == p`; a mutated name gives `SCC_ERR_AUTH` with a zeroed output. |
  | `fuzz_mldsa` | level, SubjectPublicKeyInfo, message, context, signature | Only `SCC_OK`, `SCC_ERR_AUTH`, `SCC_ERR_ARG`, `SCC_ERR_TOO_LARGE` or `SCC_ERR_CRYPTO`. Starting from a valid vector in `packages/native/test/vectors/mldsa`, any input whose bytes differ from the vector's never returns `SCC_OK`. |

- **Protocol (Step-by-Step):**
  1. Write `harness.h`: `fuzz_init()` (`scc_preinit()` then `scc_init(NULL, NULL, 0)`, as `kat.c` does without the provider), a `take(&data, &len, n)` reader, and `FUZZ_CHECK(cond, "name")`, which prints the name and aborts.
  2. Write `fuzz_recovery.c` as `LLVMFuzzerInitialize` plus `LLVMFuzzerTestOneInput`, and `standalone.c`: a `main` that replays every file in a corpus folder, then runs `N` rounds of a mulberry32-seeded mutator over them, copying each input into a `malloc` of exactly its length so a one-byte overrun traps.
  3. Write `packages/native/scripts/fuzz.mjs`, modelled on `packages/native/scripts/kat.mjs` and reusing `hostTarget`, `opensslPrefix` and `writePinHeader` from `packages/native/scripts/lib.mjs`. `--smoke` builds each harness with `standalone.c` under `-g -O1 -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer` and `kat.mjs`'s warning flags, and runs it with `ASAN_OPTIONS=detect_leaks=0`. `--harness <name> --seconds <n>` builds with `-fsanitize=fuzzer,address,undefined` and runs libFuzzer; where the fuzzer runtime is missing it says so and exits 2. `--fips` passes the provider config and modules folder as `kat.mjs --fips` does, so the approved-mode branches (`SCC_ERR_NOT_APPROVED`) are reached.
  4. Run the smoke for `fuzz_recovery` and see it pass. Seed its corpus with one valid key text, one with separators, one a character short.
  5. Add the other four harnesses one at a time, each with its seed corpus, each run before the next is started.
  6. Write `README.md`: how to run, what each oracle means, how a crash file becomes a corpus file.
- **Verification Commands:**
  - `npm run -w @slate/native fuzz:smoke` prints one `PASS fuzz_<name>` line per harness and exits 0.
  - On Linux: `npm run -w @slate/native fuzz -- --harness gcm --seconds 60` ends with no crash file.
  - Seeded bug 1: in `gcm_open_with`, delete `if (!ok) OPENSSL_cleanse(pt, ct_len);`. The smoke fails in `fuzz_gcm` with `plaintext released after a failed tag`.
  - Seeded bug 2: in `recovery_separator`, change `if (i + 2 >= len) return 0;` to `if (i + 2 > len) return 0;`. The smoke fails in `fuzz_recovery` with a heap-buffer-overflow read.
  - Seeded bug 3: in `slot_of`, delete the generation comparison. The smoke fails in `fuzz_ops` with `a stale handle named a live key`.
- **Parallelization Constraints:** Wave 1; uses no kit code. `packages/native/**` is a security path, so the branch needs the security review. It does not edit `binding.gyp`, `index.ts`, `src/**` or `test/**`. libcrypto is not instrumented, so an overrun inside OpenSSL is seen only where it crosses an exactly sized harness buffer; the README says so. The CI steps that run these are F5b's.

#### F1b. The N-API boundary under generated values

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/native/addonFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:** Every function the loaded addon exports, called with generated JavaScript values: wrong types, `Uint8Array` views with an offset, views over a `SharedArrayBuffer`, zero-length and detached buffers, other typed-array kinds, handles such as `2 ** 32 + h`, `1.5`, `NaN`, `-0` and a destroyed handle, strings with an embedded U+0000 and of 127, 128 and 129 bytes. Properties: a call returns the documented type or throws an error whose `nativeErrorCode` is an `SCC_` code, never anything else; the process survives; `status().liveHandles` returns to its starting value once the test destroys what it was given; `status().errorState` stays false; a view over a `SharedArrayBuffer` is always refused.
- **Protocol (Step-by-Step):**
  1. Load the addon the way `addon.test.ts` beside it does.
  2. Write a table with one row per export: the argument generators, and whether the function is callable in process. Assert the table's keys equal `Object.keys(native)`, so a new export without a row fails.
  3. List the one-way functions as not callable here, each with its reason: `init`, `postGate`, `postBegin`, `postEnd`, `enterErrorState`, `requireApprovedKeys`, `hardenProcess`, `zeroizeAll`, and the `sqlite` object (covered by `packages/native/test/sqliteBoundary.test.ts`).
  4. Bound the costly draws: a valid Argon2id call uses 32 KiB and one pass, a valid PBKDF2 call 1,000 iterations. Invalid costs are unbounded, because they must be refused before any work.
  5. Write the properties at a quarter of the run count, divided inline as T-FUZZ-08 does (`fcRuns` is not on `main` in wave 1); add fixed cases for each review note in `binding.c` (N1, N2, L1, L2).
- **Verification Commands:**
  - `npm run test:main -- src/main/native/addonFuzz.test.ts` passes.
  - Seeded bug: in `binding.c` `get_bytes`, return 1 without the `napi_is_arraybuffer` check; `npm run -w @slate/native build:addon`; the test fails on the `SharedArrayBuffer` property. Revert, then restore `packages/native/{build,prebuilds,fips}` from the main checkout with `cp -Rc`, since a local rebuild can leave the addon out of step with the pinned provider.
- **Parallelization Constraints:** Wave 1. Test file only; it does not edit `packages/native`. The async functions run on libuv threads, so the file caps `fast-check` at one property at a time (no `fc.scheduler`).

#### F1c. Update feed parsers

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/update/signatureFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:** `parseSignatureFile`, `parsePqSignatureFile`, `parseManifest`, `verifyDetached`, `parseVersion`, `isNewer`, `pickInstaller`. Properties: each parser throws only `UpdateSignatureError`, on arbitrary text and on a valid file with one to four structural mutations (`mutation` and `apply` from the kit); a text over the size cap is refused before `JSON.parse` runs (a spy, as T-FUZZ-13 does); for a validly signed fixture, any change to the message or to the signature text makes `verifyDetached` throw, and it never returns the id of a key that is not in `keys`; `isNewer` is irreflexive, asymmetric and transitive, and false whenever `parseVersion` returns null for either side; `pickInstaller` returns an element of its input or null.
- **Protocol (Step-by-Step):**
  1. Build valid inputs from `update/fixtures/sign-update-v0.3.0.json` and `update/fakeHybridKey.ts`, as `signature.test.ts` does.
  2. Write the parser properties, then the verification property, then the version-order property.
  3. Add the size-cap case with a spy on `JSON.parse`.
- **Verification Commands:**
  - `npm run test:main -- src/main/update/signatureFuzz.test.ts` passes.
  - Seeded bug: in `parseSignatureFile`, delete the `text.length > MAX_SIG_BYTES` line. The size-cap case fails.
- **Parallelization Constraints:** Wave 4. Test file only. `main/update/**` is a security path, but test files outside `spec/` do not trigger that review.

### Track F2: CRDT Storage & Sync Stateful Fuzzing

#### F2a. `DocStore` model

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/storeModel.test.ts`.
- **Fuzzing Target & Invariant/Oracle:** A `fast-check` command model over a real `DocStore` on a temporary database, plain and keyed (`testKey()` from `db/testModule.ts`). The model holds a truth `LoroDoc` and the list of its per-commit updates (made as `textEdits` in `store.test.ts` makes them). Commands: append the next update; withhold one and deliver it later; append a duplicate; append from a second `DocStore` on the same file opened with `compact: false`; `compact(docId)`; cross `COMPACT_THRESHOLD` and advance fake timers by `COMPACT_IDLE_MS`; close and reopen; fold `loadSince` into a reader's document; `remove`; append to another document. After every command:
  1. A fresh `LoroDoc` given `importBatch(store.load(docId))` equals a fresh `LoroDoc` given exactly the delivered updates (`toJSON()` and `oplogVersion()`). Once every withheld update is delivered, both equal the truth. **Compaction never loses an acknowledged update, under any order of arrival.**
  2. The incremental reader equals the full load, restarting when `loadSince` says `full`.
  3. `changedDocs(cursor).seq` never decreases, and a document appended to since the cursor is listed.
  4. After `remove`, `load` is empty and the reader is told `full`.
- **Protocol (Step-by-Step):**
  1. Write the model and the first three commands with invariant 1; run at a twentieth of the run count, divided inline as T-FUZZ-08 does (`fcRuns` is not on `main` in wave 1).
  2. Add withhold and deliver, then `compact`. Apply the seeded bug and see it caught before going on.
  3. Add reopen, the second connection and the `beforeCompact` hook, then the reader and invariant 2.
  4. Add `remove`, the other document and invariants 3 and 4.
  5. Add the one threshold-crossing property at a two-hundredth of the run count, since each run appends 500 rows.
- **Verification Commands:**
  - `npm run test:main -- src/main/storeModel.test.ts` passes in under 10 s.
  - `SLATE_FUZZ_RUNS=20000 SLATE_FUZZ_SEED=7 npm run test:main -- src/main/storeModel.test.ts` passes.
  - Seeded bug: in `DocStore.compact`, delete `if (status.pending !== null && status.pending.size > 0) return`. The test fails, and the shrunk command list is "append, withhold, append, compact, deliver".
- **Parallelization Constraints:** Wave 1. Test file only; `store.ts` and `store.test.ts` are not edited.

#### F2b. `SaveQueue` model

- **Target Subsystem & Exclusive Modified Files:** Create `packages/editor/test/saveQueueModel.test.ts`.
- **Fuzzing Target & Invariant/Oracle:** A `SaveQueue` over a live `LoroDoc` and a scripted `SaveSink` whose every `append` resolves, rejects, or resolves late. Commands: one edit and commit; a burst of edits; set the sink's next outcomes; advance fake timers through the 250 ms to 5 s backoff; await `idle()`; `close()`. Properties:
  1. Importing the updates whose `append` resolved, in order, into a fresh document never leaves a pending update. **No stored update depends on one the store rejected.**
  2. Once the sink accepts again and the timers have run, `state` is `saved` and the stored document equals the live one.
  3. While the sink rejects everything, `state` is never `saved` with unacknowledged edits.
  4. `idle(timeoutMs)` always settles within `timeoutMs`.
- **Protocol (Step-by-Step):**
  1. Write the scripted sink and property 1 with edits and outcomes only.
  2. Add fake timers and property 2; then bursts, `idle()` and `close()` with properties 3 and 4.
  3. Read the existing `saveQueue.test.ts` and `durableSaves.test.ts` so no case is duplicated.
- **Verification Commands:**
  - `npx vitest run packages/editor/test/saveQueueModel.test.ts` passes in under 10 s.
  - Seeded bug: in `SaveQueue.flushAll`, move `this.acked = to` above `await this.sink.append(...)`. The test fails on property 1 after one rejected append.
- **Parallelization Constraints:** Wave 1. Test file only.

#### F2c. Hostile remote

- **Target Subsystem & Exclusive Modified Files:** Create `packages/sync/test/faultScenario.ts`, `hostileRemote.test.ts`, `pathsFuzz.test.ts`, `loroImportFuzz.test.ts`, `packages/sync/test/corpus/loro-update/`. Modify `packages/sync/test/simulationFaults.test.ts` only to import the scenario arbitraries, `run` and `verify` it defines today from `faultScenario.ts`; its case, its title and its assertions stay.
- **Fuzzing Target & Invariant/Oracle:** A `SyncEngine` over `memoryLocal()` and a `RemoteDrive` the test controls completely: `delta` returns generated `RemoteItem`s (hostile paths, false sizes, repeated ids and eTags, the engine's own device id, deletions) and `download` returns valid updates, mutated updates, arbitrary bytes, or throws.
  1. `syncOnce` settles with a report or `SyncAborted`, and never hangs (deadline by fake timers, as in `simulationFaults.test.ts`).
  2. An item whose `size` is over 64 MiB is never downloaded.
  3. When every downloaded file is not a Loro update, every local document is unchanged and the notice counts every file.
  4. `parseRemotePath` never throws, and `parseRemotePath(chunkPath(d, dev, n))` and `parseRemotePath(snapshotPath(d, dev, n))` return what went in for every generated document id, device id and sequence.
  5. `LoroDoc.import` of a mutated real update or snapshot either throws or returns; afterwards a new `LoroDoc` in the same process imports a known update and exports the expected JSON. **A decoder fault does not poison the instance other documents share.**
  6. Candidate, to be evaluated first on `main`: the engine calls `appendRemote` only for document ids of the form `page:<uuid>` or `notebook:<uuid>`, the grammar `isDocId` enforces at the IPC door. By reading, `pull` applies no such check to `parseRemotePath`'s result. If it fails, it is a hardening finding for the maintainer and not part of this branch.
- **Protocol (Step-by-Step):**
  1. Move the scenario code into `faultScenario.ts` and run `simulationFaults.test.ts` to see the same result as before.
  2. Write `pathsFuzz.test.ts` (property 4).
  3. Seed `corpus/loro-update/` with ten small updates and snapshots exported from `PageDoc` edits; write `loroImportFuzz.test.ts` with `replayCorpus` and `mutateBytes` (property 5).
  4. Write the hostile drive and properties 1 to 3; then evaluate property 6.
- **Verification Commands:**
  - `npx vitest run packages/sync/test/hostileRemote.test.ts packages/sync/test/pathsFuzz.test.ts packages/sync/test/loroImportFuzz.test.ts packages/sync/test/simulationFaults.test.ts` passes.
  - Seeded bug: in `SyncEngine.pull`, delete the `item.size > MAX_FILE_BYTES` branch. `hostileRemote.test.ts` fails on property 2.
- **Parallelization Constraints:** Wave 2 (needs F5a's `mutateBytes` and `replayCorpus`). F2d imports `faultScenario.ts`, so F2c merges first. It does not edit `packages/sync/src`.

#### F2d. Sync over the real store, with compaction

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/sync/syncStoreModel.test.ts`.
- **Fuzzing Target & Invariant/Oracle:** Three devices, each a real `DocStore` behind `docStoreLocal`, sharing one `memoryDrive` through `faultyDrive`. Actions: the edits and syncs of `faultScenario.ts`, plus `store.compact(docId)` on any device at any step, and a close and reopen of a device's store. `simulationFaults.test.ts` runs the engine over `memoryLocal`, which has no compaction, no `loadSince` and no `changedDocs`, so the path from "a remote chunk whose dependency has not arrived is stored and marked seen" to "local compaction" has one example test and no generated one. Property: after faults stop and every device syncs to quiescence, all devices hold identical documents and no edit token is missing (`verify` from `faultScenario.ts`).
- **Protocol (Step-by-Step):**
  1. Build one device from `DocStore`, `docStoreLocal` and a fake `BlobStore`; run a fault-free scenario and see `verify` pass.
  2. Add `faultyDrive`, then the compaction action, then reopen.
  3. Assert, as `simulationFaults.test.ts` does, that each fault kind fired and that compactions ran, so the property cannot pass vacuously.
- **Verification Commands:**
  - `npm run test:main -- src/main/sync/syncStoreModel.test.ts` passes.
  - Seeded bug: the same deletion as F2a's, in `DocStore.compact`. The test fails with a lost token.
- **Parallelization Constraints:** Wave 3, after F2c. It imports `packages/sync/test/{faultScenario,faultyDrive,memoryDrive}.ts` by relative path, as `syncService.test.ts` already imports `packages/sync/test/fakeDrive`.

### Track F3: Parsers, Importers & Sanitizer Fuzzing

#### F3a. Core text functions

- **Target Subsystem & Exclusive Modified Files:** Create `packages/core/test/findFuzz.test.ts`, `markdownFuzz.test.ts`, `contentFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:**
  1. `findMatches` with `regex: false`, `matchCase: true`, `wholeWord: false` equals a naive left-to-right `indexOf` scan, for any text and query (astral characters and regex metacharacters included).
  2. Every range `matchAll` returns is inside the text, non-empty, ascending and non-overlapping.
  3. Patterns that can match the empty string (`a*`, `^`, `\b`, `(?=x)`) return at most `text.length` ranges: the loop always advances.
  4. `compileQuery` and `hasNestedUnboundedQuantifier` never throw on any string.
  5. `markdownToBlocks` never throws; its node types are within `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `codeBlock`, `text`; heading levels are 1 to 3; no node carries a mark. Its cost on 1 MiB inputs (the MCP `markdown` cap) of fences, `#` and list markers stays within `relativeCost` of a plain paragraph of the same size.
  6. `toPlainText` on arbitrary `PMJSON` holds the product rule in `CLAUDE.md`: no `\r`, no U+00A0, no zero-width character, no trailing newline.
  7. `toMarkdown`, `toPlainText`, `contentToJSON` and `PageDoc.listBoxes` never throw on a document a hostile peer wrote: unknown node types, attributes of the wrong type, a 5,000-deep chain, containers of the wrong kind under the boxes map. One malformed box must not make a page unreadable.
  8. `contentToJSON` after `writeContent` gives back the blocks written, for generated schema-shaped blocks.

  The generated regexes that are executed come from a linear grammar (literals, classes, anchors, one quantified atom). The full grammar, where M1 lives, belongs to FX-1.
- **Protocol (Step-by-Step):**
  1. `findFuzz.test.ts`: properties 1 to 4.
  2. `markdownFuzz.test.ts`: properties 5 and 6, then the Markdown half of 7.
  3. `contentFuzz.test.ts`: property 8, then the Loro half of 7, building hostile documents with raw `LoroMap` and `LoroList` writes.
  4. Evaluate property 7 on `main` first. A stack overflow on the deep chain is a finding (see the rule above), not something to cap away.
- **Verification Commands:**
  - `npx vitest run packages/core/test/findFuzz.test.ts packages/core/test/markdownFuzz.test.ts packages/core/test/contentFuzz.test.ts` passes.
  - Seeded bug: in `markdownToBlocks`, change `#{1,3}` to `#{1,6}`. `markdownFuzz.test.ts` fails on the heading-level property with the input `#### x`.
- **Parallelization Constraints:** Wave 2. Test files only. FX-1 adds its own file in the same folder and edits `packages/core/src/find.ts`; F3a touches neither.

#### F3b. Paste sanitiser and static rendering

- **Target Subsystem & Exclusive Modified Files:** Create `packages/editor/test/clipboardFuzz.test.ts`, `staticRenderFuzz.test.ts`, `linksFuzz.test.ts`, `packages/editor/test/corpus/paste-html/`. Each file starts with `// @vitest-environment happy-dom`, as `packages/editor/test/spec/clipboard.test.ts` does. That spec is a guarded product-rule file and is not edited.
- **Fuzzing Target & Invariant/Oracle:**
  1. `cleanPastedHtml(html)`, parsed again: no `script`, `style`, `meta`, `link`, `title`, `font` or `span` element; every attribute is in `KEEP_PASTE_ATTRS`, or `type`/`checked` on an `input`, or `width` on an `img`, or a `style` holding only `text-align` and `margin-left`. So no `on*`, `srcdoc`, `formaction`, `class` or `id` survives.
  2. `cleanPastedHtml` is idempotent and never throws, and its cost stays within `relativeCost` of a plain paragraph of the same length.
  3. End to end: `cleanPastedHtml`, then ProseMirror's `DOMParser.fromSchema(schema)`, then `DOMSerializer`: `unsafeMarkup` of the result is empty. This is the property that covers `iframe`, `object`, `embed`, `form` and `svg`, which `cleanPastedHtml` itself leaves for the schema to drop, and `javascript:` addresses, which it keeps in `href` and `src`.
  4. `renderStaticHtml(schema, doc, contentId, document)` on a content map a hostile peer or an agent wrote: `unsafeMarkup` of the fragment is empty, or the call returns null or throws an error the schema raised. Off-screen boxes are drawn this way without an editor, so this is the path from a synced document to the page.
  5. `normalizeLinkInput(raw)`: whenever it returns `{ href }`, the scheme a URL parser reads from that `href` (tabs, newlines and leading controls removed) is `http`, `https` or `mailto`. Checked against `new URL(href).protocol` wherever `URL` accepts the value.
  6. `storeDataImages(html, put)`: `put` receives only the five stored picture types; no `img` in the output keeps a `data:` address; it never throws on malformed base64.
- **Protocol (Step-by-Step):**
  1. Seed `corpus/paste-html/` with twenty-five hand-written files, one technique each: handler attributes, `svg` and `math` foreign content, entity-split schemes, `srcdoc`, `formaction`, `base`, `meta refresh`, nested `table` and `style` mutation tricks, an unterminated comment, a 2,000-deep `div` chain.
  2. `clipboardFuzz.test.ts`: `replayCorpus` plus `hostileHtml`, properties 1, 2 and 6.
  3. Property 3, using `schema` from `packages/editor/src/extensions.ts`. Read which address schemes the image and link nodes accept there and pass them to `unsafeMarkup`.
  4. `staticRenderFuzz.test.ts` (property 4) and `linksFuzz.test.ts` (property 5).
  5. Evaluate properties 3 and 4 on `main` first; a failure is a finding.
- **Verification Commands:**
  - `npx vitest run packages/editor/test/clipboardFuzz.test.ts packages/editor/test/staticRenderFuzz.test.ts packages/editor/test/linksFuzz.test.ts` passes.
  - Seeded bug: add `'onerror'` to `KEEP_PASTE_ATTRS` in `clipboard.ts`. `clipboardFuzz.test.ts` fails on property 1 with a shrunk `<img onerror=…>`.
- **Parallelization Constraints:** Wave 2. Test files and corpus only. happy-dom's parser is not Chromium's, so this harness cannot see a bypass that depends on how the browser re-parses; F3f covers that and reuses this corpus.

#### F3c. OneNote importer

- **Target Subsystem & Exclusive Modified Files:** Create `packages/importer/test/one2htmlFuzz.test.ts`, `mapFuzz.test.ts`, `graphRetryFuzz.test.ts`, `packages/importer/test/corpus/{one2html-page,graph-page}/` (found inputs only; the seeds are the existing files under `packages/importer/test/fixtures/`, read where they are).
- **Fuzzing Target & Invariant/Oracle:**
  1. `normalizeOne2HtmlPage` never throws, on `hostileHtml` and on mutated fixtures. Its output, parsed again, holds no `script`, `style` or `svg` and no `class` attribute; the body's children are the positioned boxes and at most one ink marker; a title containing markup creates no element; `rewriteSrc` is called once per image and every image carries `data-src-type="image"`.
  2. `parseOne2HtmlSection` never throws; `level` is 0, 1 or 2; titles are trimmed.
  3. `mapOneNotePage` never throws; every box has finite `x`, `y` and `width`; no text holds a zero-width character; node types are within the set the mapper emits.
  4. `GraphHttp`'s wait for any `Retry-After` value (negative, not a number, an HTTP date in the past or far future, `86400`) is between 0 and `MAX_RETRY_AFTER_MS`.

  Inputs hold at most 50 field codes in one text node. That is a size bound, not an exclusion: how the function scales with that count is FX-2's property.
- **Protocol (Step-by-Step):**
  1. `one2htmlFuzz.test.ts`: properties 1 and 2 over the fixtures first, then with mutation and `hostileHtml`.
  2. `mapFuzz.test.ts`: property 3 over the four Graph fixtures, then generated.
  3. `graphRetryFuzz.test.ts`: property 4, with fake timers as `graphDeadlines.test.ts` uses.
- **Verification Commands:**
  - `npx vitest run packages/importer/test/one2htmlFuzz.test.ts packages/importer/test/mapFuzz.test.ts packages/importer/test/graphRetryFuzz.test.ts` passes.
  - Seeded bug: in `clean()` in `one2html.ts`, delete `el.removeAttribute('class')`. `one2htmlFuzz.test.ts` fails on property 1.
- **Parallelization Constraints:** Wave 2. Test files only. FX-2 edits `packages/importer/src/one2html.ts` and adds its own test file.

#### F3d. Backup import boundary

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/onenote/backupFuzz.test.ts`, `packages/desktop/scripts/fuzz-one2html.mjs`.
- **Fuzzing Target & Invariant/Oracle:**
  1. In PR CI, `BackupSource` over a fake converter (built as `backup.test.ts` builds its own) that writes generated HTML trees: `resource(url)` returns bytes only for a file inside a conversion folder and refuses every other address, including `..` segments, absolute paths, percent-encoded traversal and a path that merely starts with the folder's name.
  2. Nightly, black box: `fuzz-one2html.mjs` mutates `packages/importer/test/fixtures/one/New Section 1.one` and runs the real converter on each result inside a scratch folder. The converter exits within 60 s; it is not killed by a signal; **nothing is created outside the `--output` folder**; and any `href` or `src` in its output that leaves the output folder is reported, which is what would make M4 reachable.
- **Protocol (Step-by-Step):**
  1. `backupFuzz.test.ts`: property 1, with `hostileUrl` and generated `img` addresses.
  2. `fuzz-one2html.mjs`: plain JavaScript with its own twenty-line mutator (a script outside Vitest cannot import the TypeScript kit without a loader). It takes `--runs`, `--seed` and the converter path, lists the scratch folder before and after each run, and exits 1 with the seed on a violation.
  3. Run the script for 200 mutations locally where the converter is built (`npm run build:one2html`).
- **Verification Commands:**
  - `npm run test:main -- src/main/onenote/backupFuzz.test.ts` passes.
  - `node packages/desktop/scripts/fuzz-one2html.mjs --runs 200 --seed 1` exits 0 and prints the count of conversions that succeeded and that failed cleanly.
  - Seeded bug: in `BackupSource.resource`, replace the `inside` test with `true`. `backupFuzz.test.ts` fails.
- **Parallelization Constraints:** Wave 3. It does not assert that `pageContent` stays inside the folder: by reading that fails today (M4), so the property and the fix are FX-4's. The nightly job that runs the script is F5b's.

#### F3e. Search index

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/search/searchFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:**
  1. `DocStore.searchRows(scope, phrase)` never throws for any phrase of three or more characters (quotes, `*`, `NEAR`, a `text:` prefix, U+0000) and returns exactly the rows whose text contains the phrase. The phrase is spliced into an FTS5 `MATCH` string with only `"` doubled, so this is the injection property. Text and phrases are drawn from ASCII letters, digits, punctuation and a few CJK characters, where the trigram tokenizer's case folding is unambiguous.
  2. `SearchIndex.query` for a literal query equals `matchAll` over every row of `pageRows`, after any sequence of page edits, removals and notebook moves followed by `flush()`.
  3. `total` never exceeds `MAX_MATCHES`, and `truncated` is true exactly when something was cut.
  4. Any value `isSearchQuery` (in `main/ipc.ts`) accepts, `query` handles without throwing.

  Private boxes are indexed on purpose (`pageRows` says so): the private flag hides a box from agents, not from the person's own search. No oracle here treats that as a leak.
- **Protocol (Step-by-Step):**
  1. Property 1 against a `DocStore` on a temporary database with generated rows.
  2. Property 2 as a small command model (edit, remove, move, query), then 3 and 4.
- **Verification Commands:**
  - `npm run test:main -- src/main/search/searchFuzz.test.ts` passes.
  - Seeded bug: in `DocStore.searchRows`, remove `.replace(/"/g, '""')`. The test fails on a phrase containing `"`.
- **Parallelization Constraints:** Wave 4. Test file only. Regex queries are executed only from the linear grammar; the rest is FX-1's.

#### F3f. Chromium differential for the paste path (optional)

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/e2e/paste-fuzz.spec.ts`.
- **Fuzzing Target & Invariant/Oracle:** The real renderer. Each file in `packages/editor/test/corpus/paste-html/` and 300 seeded `hostileHtml` strings are pasted into a box through a synthetic paste event. After each: `unsafeMarkup` of the box's DOM is empty; no `securitypolicyviolation` event fired; no dialog opened; the window did not navigate and no window was created.
- **Protocol (Step-by-Step):**
  1. Launch as the other specs do (`SLATE_E2E=1`, hidden window) and open one page with one box.
  2. Paste the corpus in one `page.evaluate` batch, passing `unsafeMarkup`'s source into the page.
  3. Add the generated strings; keep the spec under 60 s.
- **Verification Commands:**
  - `npm run e2e -- paste-fuzz.spec.ts` passes, and no Electron process from the checkout is left running.
  - Seeded bug: the same `KEEP_PASTE_ATTRS` edit as F3b. The spec fails.
- **Parallelization Constraints:** Wave 4, after F3b. Do it only if F3b's properties 3 and 4 held on `main`; if they did not, the fix comes first. It adds no renderer code, so it needs no UI scenario. It does not edit `e2e/spec/**` or the Playwright configs.

### Track F4: IPC & MCP Boundary Fuzzing

#### F4a. IPC handlers and validators

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/test/ipcHarness.ts`, `packages/desktop/src/main/ipcFuzz.test.ts`, `packages/desktop/src/main/vaultIpcFuzz.test.ts`, `packages/desktop/src/shared/ipcValidatorsFuzz.test.ts`, `packages/desktop/src/shared/settings/schemaFuzz.test.ts`. Modify `packages/desktop/src/main/ipc.test.ts` only to import `fakeRegistrar`, `tracingServices` and `allHandlers` from `ipcHarness.ts`, where they move unchanged except that the tracing proxy also records each call's arguments.
- **Fuzzing Target & Invariant/Oracle:**
  1. For every channel in the registrar's handler map (enumerated, so a new channel is covered without editing the file) and any argument list of structured-cloneable values, the handler either throws `MalformedRequest` with that channel's text and reaches no service, or proceeds. It never throws anything else.
  2. **Nothing oversize or mistyped reaches a service**: in every recorded service call, each string is within `MAX_STRING` or `MAX_PATH`, each list within `MAX_LIST`, each `Uint8Array` within `MAX_UPDATE_BYTES` (image bytes aside, whose cap is `BlobStore.put`'s), and each document id matches an independently written `^(page|notebook):<uuid>$`.
  3. `Object.prototype` gains no property from any call.
  4. Each validator in `ipcValidators.ts` is total (never throws) and, when it accepts, the value is within the caps it names.
  5. `sanitizePatch` and `mergeSettings` on any object return only keys of `SCHEMA`, each holding a value its `SettingDef` accepts, with `__proto__` and `constructor` keys in the input ignored.
  6. For every channel in `SECRET_CHANNELS`, every `Uint8Array` reachable in the arguments is all zero after the call, whether the handler resolved, refused or threw.
- **Protocol (Step-by-Step):**
  1. Move the three helpers into `ipcHarness.ts`; run `ipc.test.ts` and see the same result.
  2. `ipcValidatorsFuzz.test.ts` (property 4) and `schemaFuzz.test.ts` (property 5).
  3. `ipcFuzz.test.ts`: generators that mix `fc.anything()`, `jsonValue` and a valid argument list (taken from `ipc.test.ts`'s well-formed cases) with one position replaced; properties 1 to 3.
  4. `vaultIpcFuzz.test.ts`: property 6, set up as `vaultIpc.test.ts` sets up `createIpc`.
- **Verification Commands:**
  - `npm run test:main -- src/main/ipcFuzz.test.ts src/main/vaultIpcFuzz.test.ts src/main/ipc.test.ts` passes.
  - `npx vitest run packages/desktop/src/shared/ipcValidatorsFuzz.test.ts packages/desktop/src/shared/settings/schemaFuzz.test.ts` passes.
  - Seeded bug: in the `CH.docsAppend` handler in `ipc.ts`, remove `|| !isBytes(update, MAX_UPDATE_BYTES)`. `ipcFuzz.test.ts` fails on property 2.
- **Parallelization Constraints:** Wave 1; uses only today's kit. It edits no channel, policy or validator, so `shared/ipc.ts`, `ipcGuard.ts` and `tools/guards/ipcValidation.test.ts` are untouched. Shared-folder tests may not import Node built-ins (`slate/shared-runs-everywhere` covers them), so the two shared files import only the kit and `fast-check`.

#### F4b. Address and path gates

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/urlGatesFuzz.test.ts`, `packages/desktop/src/shared/gitRemoteFuzz.test.ts`, `packages/sync/test/transportFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:**
  1. `safeExternalUrl(value)` returns null or a string that `new URL` parses with protocol `https:` or `mailto:`; it never throws.
  2. `resolveAppPath(root, url)` returns null or a path inside `root`, for percent-encoded and doubled traversal, backslashes, U+0000 and mixed separators. `isAppUrl` and `isAppEntry` accept only the `app://slate` origin.
  3. `blobNameFromUrl(url)` returns null or a name with no separator, no `..` and no U+0000.
  4. A remote `isAllowedRemote` accepts never starts with `-`, holds no `::` and no control character, and uses an accepted scheme or the scp form; `allowLocal: false` accepts no `file:` address and no local path. `isAllowedBranch` and `isAllowedRepoName` accept nothing starting with `-` and nothing git's ref rules refuse.
  5. For every remote `isAllowedRemote` accepts, `remoteTransport(url)` is null or its `remote` is accepted by `DocStore.recordTransport` and holds none of the address's user, password, path or query. **No credential reaches `transport_observations`.**
  6. `parseSshKex` and `parseCurlTls` never throw on arbitrary text, and their cost stays within `relativeCost` of a real trace of the same length.
- **Protocol (Step-by-Step):**
  1. `gitRemoteFuzz.test.ts` (property 4) and `transportFuzz.test.ts` (property 6 and the `remoteTransport` half of 5).
  2. `urlGatesFuzz.test.ts`: properties 1 to 3, then the cross-module half of 5 against a `DocStore` on a temporary database.
- **Verification Commands:**
  - `npm run test:main -- src/main/urlGatesFuzz.test.ts` passes.
  - `npx vitest run packages/desktop/src/shared/gitRemoteFuzz.test.ts packages/sync/test/transportFuzz.test.ts` passes.
  - Seeded bug: in `resolveAppPath`, return the joined path without its inside-the-root check (the report names the line). `urlGatesFuzz.test.ts` fails on property 2.
- **Parallelization Constraints:** Wave 3 (uses `hostileUrl`). Test files only. `packages/sync/test/transportFuzz.test.ts` is this task's file although F2c works in the same folder.

#### F4c. MCP line transport and proxy

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/mcp/lineTransportFuzz.test.ts`, `proxyFuzz.test.ts`.
- **Fuzzing Target & Invariant/Oracle:**
  1. `LineTransport`: for a generated sequence of valid JSON-RPC lines and garbage lines, the messages handed to `onmessage` are the same for every chunking of the byte stream (`chunkings`), multi-byte text included.
  2. A stream whose every line is within `MAX_LINE_BYTES` is never closed for length; one with a longer unterminated run is always closed, and nothing is delivered after it.
  3. A garbage line gives one `onerror` and the valid lines after it still arrive.
  4. The stream's data handler never throws. One fixed case feeds an 8 MiB unterminated tail followed by a single 3 MiB chunk that ends the line: the SDK's `ReadBuffer.append` throws past 10 MiB, and `LineTransport` calls it outside any `try`.
  5. `drained()` resolves once every request received has been answered through `send`, for any interleaving, duplicate ids and ids that differ only by type (`1` and `"1"`). After `refuse()`, each request gets exactly one reply.
  6. `runProxy`, over generated schedules of failed connections, sockets dropped mid-request and reconnects: every client request that carries an id receives exactly one response, the app's or `lockedReply`'s; a replayed `initialize` is answered to the client once.
  7. `runProxy` relays every line byte for byte under any chunking.
- **Protocol (Step-by-Step):**
  1. `lineTransportFuzz.test.ts` with `PassThrough` streams: properties 1 to 3, then 5, then the fixed case for 4. If that case throws on `main`, it is a finding.
  2. `proxyFuzz.test.ts` with a fake `connect`: property 6 as a command model, then property 7.
- **Verification Commands:**
  - `npm run test:main -- src/main/mcp/lineTransportFuzz.test.ts src/main/mcp/proxyFuzz.test.ts` passes.
  - Seeded bug: in `LineTransport.onData`, change `this.unterminated + chunk.length` to `chunk.length`. `lineTransportFuzz.test.ts` fails on property 2.
- **Parallelization Constraints:** Wave 4, after FX-5: property 7 fails on `main` today (M5) and is FX-5's acceptance test in generated form.

#### F4d. Private boxes, statefully

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/main/mcp/privateCanaryStateful.test.ts`. Modify `packages/mcp/test/privateCanary.test.ts` only to take its run count from `fcRuns(30)` in place of the literal `60`, so the nightly soak deepens it; its seed line goes with it.
- **Fuzzing Target & Invariant/Oracle:** `createSlateMcpServer` over an in-memory transport, on `storeDocSource` and a real `DocStore`, which is the path the app runs and the one with a cache. Commands interleave the person's actions (add a box, edit one, **make a public box private**, make a private one public, grant or revoke access on a section or page, delete a page, compact the page's document, append with origin `remote`) with agent calls to every tool the server lists, with arguments generated from each tool's schema and from fragments of the canaries. After every agent call:
  1. **No canary of a box that is private now, and none from a page the agent has no access to now, appears in the response or in any audit row.**
  2. The response for a page the agent may not read is identical to the response for an id that does not exist.
  3. No private box's content changed.
  4. Every write the agent made landed on a page with `readwrite` access at the time of the call.
- **Protocol (Step-by-Step):**
  1. Reuse the canary placement of `privateCanary.test.ts` (text, link target, image alt text, to-do item); build the world on a `DocStore` with a temporary database.
  2. Add agent calls and property 1 with a static world; see it pass.
  3. Add the person's commands one kind at a time; the private-flag flip and the access revocation are the two that test the cache in `docSource.ts`.
  4. Assert each command kind ran and that both a leak-free read and a refusal occurred, so the property is not vacuous.
- **Verification Commands:**
  - `npm run test:main -- src/main/mcp/privateCanaryStateful.test.ts` passes.
  - `npx vitest run packages/mcp/test/privateCanary.test.ts` passes.
  - Seeded bug 1: in `agentBoxes` (`packages/core/src/agentView.ts`), delete the `if (box.private) return …` line. Both files fail.
  - Seeded bug 2: in `storeDocSource`, serve the cached projection without consulting the cursor (the report names the line). The stateful file fails after a flip to private; the stateless one still passes, which is why this task exists.
- **Parallelization Constraints:** Wave 3. `packages/mcp/src` is not edited; `slate/mcp-pages-through-docsource` is unaffected.

#### F4e. Log redaction

- **Target Subsystem & Exclusive Modified Files:** Create `packages/desktop/src/shared/redactFuzz.test.ts`. `packages/desktop/test/spec/redact.test.ts` is a guarded spec and is not edited.
- **Fuzzing Target & Invariant/Oracle:**
  1. For each credential shape `SECRETS` names (API key, the GitHub and GitLab token forms, JWT, `Bearer` and `Basic` headers, `password=` pairs, `scheme://user:password@`, AWS, Slack and npm tokens, a PEM private key block, 32 or more hex digits that are not exactly 40, a base64 run that meets `looksLikeBase64`), generated and placed anywhere in surrounding noise, `redactString` returns text that does not contain the secret's body.
  2. Output length is at most 512 characters plus the truncation suffix.
  3. UUIDs, 40-digit git ids and ordinary words pass through unchanged.
  4. `redact(value)` on any graph (cycles, depth 1,000, every byte container, `Map`, `Set`, `Error`, class instances) terminates without throwing, and its result holds no byte container.
  5. Candidate: `redactString` is idempotent.

  Inputs are at most 4 KiB. How the cost grows beyond that is FX-3's property (M3).
- **Protocol (Step-by-Step):** One generator per `SECRETS` row and for the base64 rule; then properties 1 to 4; then evaluate 5 on `main`.
- **Verification Commands:**
  - `npx vitest run packages/desktop/src/shared/redactFuzz.test.ts` passes.
  - Seeded bug: delete the `gh[pousr]_` row from `SECRETS`. The test fails on property 1 with a shrunk `ghp_` token.
- **Parallelization Constraints:** Wave 3. Test file only; no Node built-in imports (it is under `src/shared`).

### Lane FX: fixes for what the audit found

Each is an ordinary fix branch: a red test first, then the fix, through the review tier its files call for. They are listed here because each one's test is a harness in this plan's style and because two of them gate a harness task.

| Task | Finding | Files | Red test | Fix, and who decides |
| --- | --- | --- | --- | --- |
| FX-1 | M1 | Create `packages/core/test/findTermination.test.ts`; fix in `packages/core/src/find.ts` and, depending on the choice, `main/search/searchIndex.ts` and `packages/editor/src/find.ts` | The three measured patterns as fixed cases, then the property: every pattern from the full grammar (overlapping alternation under `+`, `*` and `{n,}`; bounded repeats of unbounded groups; adjacent overlapping quantifiers; backreferences; lookarounds) that `compileQuery` accepts finishes within `regexDeadline`'s 1 s on pump strings up to `MAX_REGEX_TEXT`. Plus one `searchIndex.test.ts`-style case: `SearchIndex.query` with `(a\|a)+$` over one such row returns within 300 ms with `truncated: true`. | **Maintainer.** A static refusal can be widened but cannot be complete: polynomial cases such as `(.*a){12}` have no simple shape. The complete fix is a deadline: run a person's pattern in a worker that main can terminate (the rows are plain strings and need no native module). The renderer's in-page find needs its own answer, because the page's CSP was set to `worker-src 'none'`. Recommended: widen the refusal now as a stopgap in both processes, then move main's regex scan to a worker. |
| FX-2 | M2 | Create `packages/importer/test/one2htmlFieldCodes.test.ts`; fix `packages/importer/src/one2html.ts` | 3,000, 8,000 and 50,000 field codes in one paragraph: no throw, every code becomes a link, and the time for 8,000 is under thirty times the time for 800. | Agent. One pass with no rescan and no recursion: collect the text nodes once, split each on every field code in a loop. |
| FX-3 | M3 | Create `packages/desktop/src/shared/redactCost.test.ts`; fix `packages/desktop/src/shared/redact.ts` | The two measured inputs at 64 KiB and 1 MiB: the larger costs under forty times the smaller. | **Maintainer.** First establish whether any log field can be that long. If so, bound the text before the patterns run, at a length where a secret cut by the bound cannot reach the 512 characters that are kept. `shared/redact.ts` is a security path and its thresholds are a guarded spec. |
| FX-4 | M4 | Create `packages/desktop/src/main/onenote/backupContainment.test.ts`; fix `packages/desktop/src/main/onenote/backup.ts` | With a fake converter whose index names `../outside.html`, an absolute path and a percent-encoded traversal, `listPages` followed by `pageContent` reads no file outside the conversion folder (a spy on `readFileSync`). | Agent. Apply `resource()`'s containment test where `listPages` builds the path, and drop the entry. Worth doing whatever F3d's nightly run says about the converter. |
| FX-5 | M5 | Create `packages/desktop/src/main/mcp/proxyUtf8.test.ts`; fix `packages/desktop/src/main/mcp/proxy.ts` | The two run cases: a reply holding `5€` and a request holding `café`, each split inside the multi-byte character, arrive byte for byte. | Agent. Keep the relay in bytes: buffer `Buffer`s and split on `0x0a`, decoding a whole line only where the proxy must parse it. |

FX-1 and FX-2 need F5a's `regexDeadline` and `relativeCost`. FX-5 needs nothing and merges before F4c. FX-3 follows F4e, FX-4 follows F3d.

### Track F5 (second part): CI Nightly Fuzzing & Corpus Guardrails

#### F5b. Workflows, the corpus guard and the compliance trace

- **Target Subsystem & Exclusive Modified Files:** `.github/workflows/nightly.yml`, `.github/workflows/ci.yml` (the `native` job only), new `tools/guards/fuzzCorpus.test.ts`, `tools/guards/allowlists/dependencies.json` (the `fast-check` reason), `scripts/traceability.mjs` (`SEED`), `docs/compliance/traceability.yaml` (regenerated), `docs/compliance/release-checklist.md`, `docs/architecture/golden-paths.md` (a "Fuzzing" section the guard's messages point to), `CLAUDE.md` (one Commands row, one Guardrails row). Title-only edits to the test files it promotes, once every other task has merged.
- **Fuzzing Target & Invariant/Oracle:** The guard keeps the harnesses honest the way `ratchet.test.ts` keeps the allowlists honest.
  1. Every corpus folder is named in a `replayCorpus(` call and is not empty; every `replayCorpus(` call names a folder that exists.
  2. Each corpus file is at most 64 KiB, each folder at most 1 MiB, and each file's name is the first 16 hex digits of its SHA-256.
  3. No corpus file present on the base is missing (`readAt` and `baseCommit` from `tools/guards/repo.ts`).
  4. Every `fc.assert(` in `packages/` passes `fcParams`, `fcRuns(` or a literal `seed:`.
  5. Nothing under `packages/*/src`, test files aside, imports `fast-check` or a kit file.
- **Protocol (Step-by-Step):**
  1. Request the lead's signed unlock for the branch. Every commit that touches a guard file carries `Guardrail-Change: <why>`.
  2. Write `fuzzCorpus.test.ts` with a self-test case for each rule, as `ratchet.test.ts` has.
  3. `nightly.yml`: widen `fuzz-soak` to the file-name filters `Fuzz.test` and `Model.test` for both `npx vitest run` and `npm run test:main --`, keeping the three vault files, and add `SLATE_SIM_RUNS`. Add `fuzz-native` (install clang and the package that provides its fuzzer runtime, confirm the package name on the runner image, build libcrypto as the job above does, restore the corpus cache, run each harness, upload the sanitizer report and input hash on failure). Add `fuzz-converter` (build `one2html` as `verify.yml` does, run F3d's script). Pin `actions/cache` by commit SHA.
  4. `ci.yml`: add `npm run -w @slate/native fuzz:smoke` after "Native KATs under ASan/UBSan".
  5. Promote to the compliance trace. Propose the mapping to the maintainer before editing: F1a's zero-on-failure and handle properties as `T-FUZZ-14` and `-15` under F-FIPS-06 beside T-ZERO-03; F4a's secret-zeroing property as `T-FUZZ-16` under F-FIPS-06 beside T-ZERO-04; F1c's parser properties as `T-FUZZ-17` under F-NIST-06 beside T-UPD-01; F4b's and F3b's gate properties as `T-FUZZ-18` and `-19` under F-NIST-08 beside T-B-01 to -04. The data-loss, private-box and search properties trace to the 2026-11-10 architecture review, which has no matrix, and keep their `T-F…` titles. Then add the ids to the titles and to `SEED`, and run `node scripts/traceability.mjs`.
  6. `release-checklist.md`: the nightly run on the tagged commit is green, or its failure is recorded.
- **Verification Commands:**
  - `npm run guards` passes.
  - `node scripts/traceability.mjs --check` passes.
  - `gh workflow run nightly.yml --ref <branch>` (run by the maintainer) completes with the three fuzz jobs green.
  - Seeded bugs: delete one corpus file; add a bare `fc.assert(fc.property(fc.string(), () => {}))` to any test. `npm run guards` fails on each with the rule's message.
- **Parallelization Constraints:** Wave 5, alone with F5c. A guard batch: one unlock, a security review, and the maintainer's `--confirm-guard-changes` in one sitting before any push. It lands only after every harness it names is on `main`, so the new rules pass on arrival.

#### F5c. Jazzer.js spike

- **Target Subsystem & Exclusive Modified Files:** New `tools/fuzz/{package.json,package-lock.json,README.md}` and `tools/fuzz/targets/*.mjs`; `tools/guards/dependencies.test.ts` (add the manifest and lockfile to `MANIFESTS` and `LOCKFILES`); `tools/guards/allowlists/dependencies.json`; one job in `.github/workflows/nightly.yml`.
- **Fuzzing Target & Invariant/Oracle:** Three pure-JavaScript targets where coverage feedback can work: `normalizeOne2HtmlPage`, `mapOneNotePage`, and `markdownToBlocks` followed by `toMarkdown`. Each uses the oracle of its Vitest harness. Loro and the paste sanitiser are not targets (section 2.1).
- **Protocol (Step-by-Step):**
  1. Confirm against the npm registry: the current version, that it installs with `sha512` integrity and no install-time download, and that it runs on Node 22 on `ubuntu-24.04`. If any of these fails, stop and report.
  2. Install into `tools/fuzz` only. Bundle each target to JavaScript with the bundler the repository already has (Vite, through its build API).
  3. Run exit criterion (b).
  4. Only if all criteria hold, add the nightly job and the guard changes; otherwise delete the branch and record the result in the report.
- **Verification Commands and exit criteria:**
  - (a) `npm ci --prefix tools/fuzz --no-audit --no-fund` succeeds offline from the lockfile, and `npm run guards` passes with the new manifest listed.
  - (b) On a scratch branch with FX-2 reverted, starting from the existing fixtures only, the fuzzer reports the `linkFieldCodes` stack overflow within 10 minutes. The time the seeded mutator in `one2htmlFuzz.test.ts` takes to find the same is recorded beside it.
  - (c) `git diff --stat main` shows no change to the root `package.json`, the root `package-lock.json` or any `vitest*.config.*`.
- **Parallelization Constraints:** Wave 5, after F5b (both edit `nightly.yml` and `dependencies.json`). Guard files, so the same unlock and confirmation. If the spike fails, nothing in this plan depends on it.

## 4. Global Interdependencies & Wave Execution Plan

### 4.1 Ownership of shared files

Exactly one task edits each; the others send a written request to the owner.

| Shared file or folder | Owner | Who else is affected | Rule that keeps branches from colliding |
| --- | --- | --- | --- |
| Root `package.json`, `package-lock.json` | Nobody | All | No task adds a root dependency or script. F5c's dependency lives in `tools/fuzz`. |
| `CHANGELOG.md`; `version` in the root and `packages/desktop` manifests | Lead | All | Each report proposes one line. The lead adds it and bumps the version at each merge. |
| `.github/workflows/**` | F5b, then F5c | F1a, F3d (CI runs their commands) | The commands are fixed in those tasks' verification sections; only F5b writes them into a workflow. |
| `tools/guards/**`, including `allowlists/dependencies.json` | F5b, then F5c | All | One guard batch, one unlock, last. |
| `scripts/traceability.mjs`, `docs/compliance/traceability.yaml` | F5b | All | Titles of the form `T-F2A-01` leave the generated file unchanged, so no other branch touches it. |
| `CLAUDE.md`, `docs/architecture/golden-paths.md`, `docs/compliance/release-checklist.md` | F5b | All | |
| `docs/compliance/poam.md` | Maintainer | FX lane | An FX report proposes wording; it does not edit the file. |
| `packages/native/package.json` | F1a | F5b | The script names `fuzz:smoke` and `fuzz` are fixed by this plan. |
| The kit: `packages/desktop/test/fuzz.ts`, `fuzzBytes.ts`, `fuzzCorpus.ts`, `fuzzHtml.ts`, `fuzzDeadline.ts`, `fuzzRegexWorker.mjs` | F5a | Every task in waves 2 to 4 | After F5a merges, a kit change is a request to the lead. |
| `packages/desktop/src/main/vault/fuzz.test.ts` | F5a (one import) | | |
| `packages/desktop/src/main/ipc.test.ts`, `packages/desktop/test/ipcHarness.ts` | F4a | | A move of three helpers; no case changes. |
| `packages/sync/test/simulationFaults.test.ts`, `faultScenario.ts` | F2c | F2d imports `faultScenario.ts` | F2c merges before F2d starts. |
| `packages/mcp/test/privateCanary.test.ts` | F4d | | |
| `packages/editor/test/corpus/paste-html/` | F3b | F3f reads it | |
| Source files: `packages/core/src/find.ts` (FX-1), `packages/importer/src/one2html.ts` (FX-2), `packages/desktop/src/shared/redact.ts` (FX-3), `packages/desktop/src/main/onenote/backup.ts` (FX-4), `packages/desktop/src/main/mcp/proxy.ts` (FX-5) | The FX task named | | No harness task edits anything under `src/` except to add a test file. |

Several tasks add files to the same folder. They never share a file:

| Folder | Files by task |
| --- | --- |
| `packages/core/test/` | F3a: `findFuzz`, `markdownFuzz`, `contentFuzz`. FX-1: `findTermination`. |
| `packages/importer/test/` | F3c: `one2htmlFuzz`, `mapFuzz`, `graphRetryFuzz`, `corpus/`. FX-2: `one2htmlFieldCodes`. |
| `packages/sync/test/` | F2c: `faultScenario`, `hostileRemote`, `pathsFuzz`, `loroImportFuzz`, `corpus/`. F4b: `transportFuzz`. |
| `packages/desktop/src/main/` | F2a: `storeModel`. F4a: `ipcFuzz`, `vaultIpcFuzz`. F4b: `urlGatesFuzz`. |
| `packages/desktop/src/main/mcp/` | F4c: `lineTransportFuzz`, `proxyFuzz`. F4d: `privateCanaryStateful`. FX-5: `proxyUtf8`. |
| `packages/desktop/src/main/onenote/` | F3d: `backupFuzz`. FX-4: `backupContainment`. |
| `packages/desktop/src/shared/` | F4a: `ipcValidatorsFuzz`, `settings/schemaFuzz`. F4b: `gitRemoteFuzz`. F4e: `redactFuzz`. FX-3: `redactCost`. |

### 4.2 Ordering constraints

Everything not listed here is independent.

| Before | After | Why |
| --- | --- | --- |
| F5a | FX-1, FX-2, F2c, F3a, F3b, F3c, F3d, F4b, F4c, F4d | They import what F5a adds (`regexDeadline`, `relativeCost`, `mutateBytes`, `replayCorpus`, `hostileHtml`, `hostileUrl`, `unsafeMarkup`, `chunkings`, `fcRuns`). Wave 1 tasks use only today's exports and divide a run count inline, as T-FUZZ-08 does. |
| F2c | F2d | F2d imports `faultScenario.ts`. |
| F3b | F3f | F3f replays F3b's corpus, and is worth doing only if F3b's end-to-end properties held. |
| FX-5 | F4c | F4c's byte-for-byte property fails on `main` until the proxy is fixed. |
| F4e | FX-3 | FX-3's cost test extends the generators F4e writes. |
| F3d | FX-4 | Soft: F3d's nightly run says whether M4 is reachable. FX-4 is worth merging either way. |
| Every harness task | F5b | A new guard rule must pass when it lands, and the nightly job lists files that must exist. |
| F5b | F5c | Both edit `nightly.yml` and `dependencies.json`. |

### 4.3 Wave plan

At most six agents at once.

| Wave | Branches | Runs when |
| --- | --- | --- |
| 1 | F5a, F1a, F1b, F2a, F2b, F4a | Immediately. No shared infrastructure needed. |
| 2 | FX-1, FX-2, F2c, F3a, F3b, F3c | F5a is on `main`. FX-1 also needs the maintainer's choice of fix. |
| 3 | F2d, F3d, F4b, F4d, F4e, FX-5 | F2c is on `main` (for F2d). |
| 4 | F1c, F3e, F3f, F4c, FX-3, FX-4 | FX-5, F4e, F3b and F3d are on `main`. FX-3 also needs the maintainer's decision. |
| 5 | F5b, then F5c | Every harness is on `main`. Guard batch: the lead's unlock, a security review, the maintainer's confirmation. |

```mermaid
flowchart LR
  subgraph W1["Wave 1: start now"]
    F5a["F5a kit"]
    F1a["F1a native libFuzzer"]
    F1b["F1b N-API boundary"]
    F2a["F2a DocStore model"]
    F2b["F2b SaveQueue model"]
    F4a["F4a IPC handlers"]
  end
  subgraph W2["Wave 2: needs the kit"]
    FX1["FX-1 regex termination"]
    FX2["FX-2 field codes"]
    F2c["F2c hostile remote"]
    F3a["F3a core text"]
    F3b["F3b sanitiser"]
    F3c["F3c importer"]
  end
  subgraph W3["Wave 3"]
    F2d["F2d sync over DocStore"]
    F3d["F3d backup boundary"]
    F4b["F4b address gates"]
    F4d["F4d private boxes"]
    F4e["F4e redaction"]
    FX5["FX-5 proxy bytes"]
  end
  subgraph W4["Wave 4"]
    F1c["F1c update parsers"]
    F3e["F3e search index"]
    F3f["F3f Chromium differential"]
    F4c["F4c MCP transport"]
    FX3["FX-3 redaction cost"]
    FX4["FX-4 backup containment"]
  end
  subgraph W5["Wave 5: guard batch"]
    F5b["F5b CI, corpus guard, trace"]
    F5c["F5c Jazzer.js spike"]
  end
  F5a --> FX1 & FX2 & F2c & F3a & F3b & F3c
  F5a --> F3d & F4b & F4d
  F5a --> F4c
  F2c --> F2d
  F3b --> F3f
  F3d -.-> FX4
  F4e --> FX3
  FX5 --> F4c
  ALL(["every harness on main"]) --> F5b
  F5b --> F5c
```

### 4.4 Notes for the coordinator

- This file was written into the main checkout and is not committed. Commit it on a branch before making worktrees, so each agent can read it. `docs/compliance/poam.md` had an uncommitted change before this audit began; it is not part of this plan.
- F1a's branch touches `packages/native/**` and needs the security review before `merge-wp`. The FX branches need the tier their source file calls for: security for `shared/redact.ts`, architecture for the rest. Test-only branches need neither, since test files outside `spec/` do not count.
- Keep a ledger at `.agent-reports/fuzz/ledger.md` with one line per task (branch, state, report path, findings), so a run stopped by a usage limit resumes from it.
- Check free disk space between waves. The main-process harnesses each open temporary databases, and F3d's script writes converter output; both clean up after themselves, and a killed agent does not.
- A finding from any harness (the rule in section 3) goes to the maintainer with its seed before anyone fixes it. Some will be judged acceptable, and that decision is recorded beside the property.

### 4.5 What this audit did not verify

- No harness in this plan was written or run. The time budgets are targets, and each task's report replaces them with measurements.
- The candidate properties may or may not hold on `main`: F2c's document-id property, F3a's deep-nesting property, F3b's end-to-end and static-render properties, F4c's large-chunk case and F4e's idempotence.
- M4 was read, not run. M3's second input was not traced to a rule, and no log call site was shown to pass a long field. M1 to M3 and M5 were measured under Node, not Electron.
- Jazzer.js's version and capabilities come from a web search.
- Not checked: the name of the `apt` package that carries the fuzzer runtime on the `ubuntu-24.04` image; the commit SHA to pin for `actions/cache`; whether `tools/guards/docs.test.ts` constrains the `CLAUDE.md` row F5b adds; which Playwright project picks up F3f's spec; which address schemes the editor schema accepts for links and images.
- `resolveAppPath` and the cache in `storeDocSource` were not read line by line, so the seeded bugs for F4b and for F4d's second case name the behaviour to break, not the line.

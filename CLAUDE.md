# Working on Slate

Slate is a fast, developer-friendly free-form notes app (Electron + React + strict TypeScript) for
people leaving OneNote. Design: `docs/superpowers/specs/2026-10-21-slate-design.md`. Current
build plan: `docs/superpowers/plans/2026-10-21-phase-1-local-editor.md`.

## Map

- `packages/core` — pure TypeScript, no DOM, no Electron: Loro CRDT documents (`PageDoc`,
  `NotebookDoc`), auto-push maths (`computePush`), the plain-text clipboard serializer.
- `packages/editor` — React + TipTap: canvas, boxes, Loro↔ProseMirror binding, clipboard cleaning,
  `PageSession` (one open page: persistence, undo, auto-push).
- `packages/desktop` — Electron. `src/main` owns SQLite (`DocStore`) and image files (`BlobStore`);
  `src/preload` exposes `window.slate` (`src/shared/api.ts`); `src/renderer` is the app UI.
- `tools/` — the guard layer: `eslint-rules/` (the `slate/*` lint rules), `guards/` (guard tests,
  reasoned allowlists, security paths), `lint/` (the lint toolchain's own install).

## Commands

| Task | Command |
| --- | --- |
| Install, then build the native module (OpenSSL, FIPS provider, SQLCipher; notes need it). Install also sets up the lint toolchain in tools/lint | `npm install && npm run -w @slate/native build` |
| Run with hot reload | `npm run dev` |
| Typecheck everything | `npm run typecheck` |
| Unit tests (core + editor) | `npm test` (one file: `npx vitest run packages/core/test/x.test.ts`) |
| Main-process tests (Electron's Node ABI) | `npm run test:main` |
| E2E (builds first; window stays hidden) | `npm run e2e` (one spec: `npm run e2e -- canvas.spec.ts`) |
| MCP server for agents | `bin/slate-mcp` (build first); register with `claude mcp add slate -- $PWD/bin/slate-mcp` |
| Lint (whole repo; this branch's files) | `npm run lint`; `npm run lint:changed` |
| Guard tests (and the lint rules' own tests) | `npm run guards` |
| UI scenarios and screenshots on one page (`ui-review/index.html`) | `npm run ui:review` |

## Never

- Push, tag or release without asking the maintainer.
- Add AI attribution to a commit (`Co-Authored-By: Claude…`, "Generated with Claude Code");
  `.githooks/commit-msg` rejects it.
- Delete or weaken a test to get green.

## Guardrails

Slate's security and architecture rules are checks, not prose: the table below pairs each rule with
what enforces it, and every message names the accepted path (most point into
[`docs/architecture/golden-paths.md`](docs/architecture/golden-paths.md)). When a check blocks you,
use the path it names. Never route around it: no new disable comment for a guard rule (the lint
refuses one), no allowlist or suppression growth (the ratchet refuses it), no edits to guard files
(the `guard-edits` hook refuses them). If the accepted path truly cannot work, stop that item and
explain it under "Guardrail conflicts" in your report; the maintainer decides. Branches that touch
`tools/guards/security-paths.txt` paths get a security review (`docs/review/REVIEW.md`) before
`scripts/agents/merge-wp.sh` merges them. After a review finds something, run the `correct` skill
(`.claude/skills/correct/SKILL.md`) so the next agent cannot repeat it.

| Rule | Enforced by | Since |
| --- | --- | --- |
| Packages stay in their process: core pure (no DOM/Node types), editor no Node, renderer no Electron/Node/main/preload, preload only electron + shared, main never imports renderer, shared imports neither side | `slate/core-stays-pure`, `editor-stays-in-the-renderer`, `renderer-through-bridge`, `preload-electron-and-shared`, `main-never-imports-renderer`, `shared-runs-everywhere`; `.dependency-cruiser.cjs` (`npm run lint:arch`); `packages/{core,editor}/tsconfig.json` | phase 11 (G1) |
| The renderer reaches the disk and network only through `window.slate`; no code or HTML from strings; the built app's CSP allows no network | `slate/renderer-no-network` (any reference, alias or computed access), `slate/renderer-no-code-eval`; `src/shared/csp.ts` swapped in by the electron-vite build; `tools/guards/packaging.test.ts` | G1 |
| IPC has one door: every channel is a `CH` member with a `CHANNEL_POLICY` row, one handler on the one `IpcRegistrar` from `createIpc`; `send` is dropped while locked; channels served while locked are pinned | types (`Record<keyof typeof CH, ChannelPolicy>`, `Channel`); `createIpc` once per ipcMain; `slate/ipc-through-registrar` (also `webContents.ipc`, `MessageChannelMain`), `slate/ipc-registrar-once`, `slate/ipc-channel-from-ch`, `slate/preload-exposes-only-slate`; `tools/guards/ipcChannels.test.ts` with `allowlists/ipc-ungated.json` (maintainer only); `ipcGuard.test.ts` | G1 |
| Only `testHooks.ts` touches `process.env`: `env(name)` for one documented variable, `envSnapshot()` for a pure function; test hooks are scrubbed when packaged | `env()`'s type; `slate/env-through-test-hooks` (any spelling); `tools/guards/envVars.test.ts`; T-STATIC-04 (`src/main/static.test.ts`) | G1 |
| Crypto runs in `@slate/native`: no `node:crypto` in `main/vault`, `main/sync`, `main/db`, and elsewhere only in reviewed files with the imports listed for each; no JavaScript crypto library and no deep import into the module anywhere; the Web Crypto global only in `core/src/ids.ts` (`newId`, `randomInt`, `randomFraction`); no ECB outside `vault/names.ts`, no `Math.random`, no `createRequire` | `slate/crypto-stays-in-the-vault` (`allowlists/crypto-imports.json`, per import), `slate/crypto-through-native`, `slate/no-get-builtin-module`, `slate/no-web-crypto`, `slate/no-ecb`, `slate/no-math-random`, `slate/no-create-require`; T-STATIC-02 (`static.test.ts`) | G1; C4 |
| Keys never exist as JavaScript bytes: the `KeyRing` holds `KeyHandle`s into the module's secure heap, and vault, sync and database APIs take handles; the module refuses a key used outside its usage (a password KEK wraps only a fresh master key, a KEK only a fresh database key, a data key no key at all; only a database key keys SQLCipher; `rewrapKey` moves only a master key between password KEKs, and a database key never moves: a rejoin makes a fresh one and rekeys a copy). Nothing is copied, stringified or logged | `KeyRing.get` returns `KeyHandle` and no key-named parameter is bytes (`static.test.ts`, C4); usage flags (`SCC_17`, `addon.test.ts` "C4 residual (closed by C5)", `kat.c`); `LogFields` refuses bytes and handles (type); `redactString` strips hex and base64 key text; T-STATIC-01 (`static.test.ts`, `allowlists/key-text.json`); T-ZERO-01 native (`vault/keyring.test.ts`, `vault/zeroise*.test.ts`) | G1; C4 |
| A typed password or recovery key is bytes from the field to the module: the renderer draws it with `SecretField` and reads it once at submit (`submitSecret`), never in React state; every `VaultApi` secret parameter is `SecretBytes`/`VaultSecret`; the preload and main zero their copies; main checks the shape (`passwordBytes`) and never turns it into a string, except `checkPassword` for a password being set; the typed recovery key is decoded in the module (`recoveryDecode`); after unlock the lock window's renderer process exits; the process is non-dumpable (Linux) with no core file | `slate/secrets-out-of-react-state`, `slate/secret-bytes-stay-bytes` (type-aware); `tools/guards/vaultSecrets.test.ts` (with `secretHandler`, `vaultIpc.test.ts`); T-STATIC-01 C7 cases (`static.test.ts`); `addon.test.ts`, `kat.c`, `surface.test.ts`; `native/test/harden.test.ts`, `cryptoModule.test.ts` (Z-9); `e2e/lock.spec.ts` (T-ZERO-05), `e2e/memory.spec.ts` (T-ZERO-04 Linux, T-ZERO-07) | C7 |
| Windows come from `createWindow` (`src/main/windows.ts`) with isolation and sandbox on; `shell` only in `openExternal.ts` (`openExternalSafe`: https and mailto, canonical URL) | `slate/no-weak-web-preferences`, `slate/windows-from-the-factory`, `slate/open-external-safely`; `windows.test.ts`, `openExternal.test.ts`; the smoke e2e reads every window's effective preferences | G1 |
| Every webContents stays on `app://slate/`: navigation, `window.open` and `<webview>` are refused (links go to `openExternalSafe`), permissions denied by default, all from `hardening.ts`, which `createWindow` requires; IPC only from Slate's own top frame; renderer links through `ExternalLink`, HTML parsed only by the paste sanitiser; protocols serving note data refuse while locked | `slate/web-contents-guards-in-hardening`, `slate/loads-in-the-factory`, `slate/renderer-links-through-external-link`, `slate/parse-html-in-the-sanitiser`, `slate/protocols-through-the-gate`; `hardening.test.ts`, `ipcGuard.test.ts` (T-B-02/03), `protocols.test.ts`, `tools/guards/boundary.test.ts`; `e2e/boundary.spec.ts` (T-B-01, T-B-04) | C8 |
| Processes start through `src/main/proc.ts` (argument array, never a shell); TLS verification stays on | `slate/child-process-through-proc` (`allowlists/process-imports.json`), `slate/no-shell-exec`, `slate/no-shell-option` (anything but a literal `false`), `slate/no-tls-bypass` (only a literal `true`) | G1 |
| SQL text is a literal (values are `?` parameters); key pragmas only in `db/openDatabase.ts` and `db/migrateToEncrypted.ts` | `slate/sql-text-is-literal` (type or name; `allowlists/sql-dynamic.json`), `slate/sql-key-pragma-in-db` | G1 |
| Vault files are written through `writeJsonAtomic`; OS-keyring secrets only through `secretStorage.ts` (async `safeStorage`, real keyrings, never plaintext), no synchronous `safeStorage` anywhere | `slate/vault-writes-through-atomic`, `slate/no-sync-safe-storage`, `slate/secrets-through-secret-storage`; `tools/guards/boundary.test.ts` (criterion 2, T-B-06) | G1; C8 |
| Vault files are read through `readJsonCapped` (64 KiB cap, regular files only) anywhere in main; the bytes that remain in JavaScript (the typed password and recovery key, quick unlock's QU) are never copied through a pooled `Buffer.from`/`allocUnsafe`/`copyBytesFrom`, and key or decipher output never goes through `Buffer.concat` | `slate/vault-json-reads-capped` (`allowlists/vault-json-parse.json`), `slate/vault-files-read-capped`, `slate/vault-key-copies-own-memory` (`allowlists/vault-buffer-copies.json`), `slate/key-bytes-stay-put` (type-aware: `KeyBytes`, `Decipher`; `allowlists/key-copies.json`); T-FUZZ-13, T-ZERO-01 (`vault/localJsonCaps.test.ts`, `vault/zeroise*.test.ts`) | C1 |
| A fips-140-3 vault never reaches suite 0x01, Argon2id or RFC 5869 HKDF: its unlock latches the module approved-only before the first key (`enterProfile`), and the legacy primitives live in one file each (`vault/suite1.ts`, Argon2id in `vault/kdf.ts`); header v2 is exactly its JSON Schema plus rules 1-3; a header older or weaker than the device's signed `profile-floor.json` is refused | `requireApprovedKeys` refuses the legacy services (SCC_16, `kat.c`, `native/test/suite2.test.ts`); `slate/legacy-crypto-in-v1-path`, `slate/argon2-in-kdf`; `vault/fipsProfile.test.ts` (criterion 2: zero legacy calls across the fips matrix); `tools/guards/headerSchema.test.ts` (`docs/compliance/schemas/vault-header-v2.schema.json`); T-POL-05 | C5 |
| The power-up self-test comes first: the app starts the module gated (`postGate`), so no service runs until `runPost` (`vault/selftest/post.ts`, the only caller of `postBegin`/`postEnd`) passed; the vault starts in `selftest`, `selftest-failed` is terminal, and `openDatabase`/`openServices` refuse in both; IPC serves only `SELF_TEST_POLICY`'s channels there; SCC_12 anywhere fails closed (`watchModule`, `failClosed`) | native gate (`kat.c` "C6 …", `native/test/postGate.test.ts`); `tools/guards/selfTest.test.ts`; `SELF_TEST_POLICY`'s type; `vault/selftest/*.test.ts` (T-POST-01 … -09), `vaultState.test.ts`, `ipcGuard.test.ts`; `e2e/selftest.spec.ts` (T-POST-10 … -12) | C6 |
| Every audit finding is traced to tests or the POA&M: an alias finding (`See F-…`, `= F-…`) resolves to a traced one, and every §1.4 row M-01…M-22 is in `SEED.mrows` with its WP's tests or a POA&M row that cites the M id | `node scripts/traceability.mjs --check` (CI), `tools/guards/traceability.test.ts` | phase 11 (correct) |
| A crash test of a key change (`runRekey`, `rejoin`) ends with `expectNotesSurviveCrash` (`vault/testVault.ts`): the old and every new secret unlock, alone and in both orders, and the notes are counted | `tools/guards/crashSurvival.test.ts` | phase 11 (correct) |
| Main logs through the logger, never `console` or stdout | `slate/log-through-logger` | G1 |
| No type escape hatches | `tsc` (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`); `@typescript-eslint/no-explicit-any`, `ban-ts-comment`, `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-non-null-assertion` (vault) | G1 |
| Tests cannot be quietly shrunk: no `.only`; a skip says why and the skip count only shrinks; a test with no assertion fails; test configs and scripts are pinned; no package loses test files; a behaviour change has a test that fails without it | `vitest/no-focused-tests`, `slate/skip-needs-reason`; `expect.requireAssertions` in every project; `tools/guards/testConfig.test.ts`; Stop hook (`definition-of-done.mjs`, `testsFailOnBase.mjs`) | G1; Stop hook phase 1 |
| Tests are registered unconditionally: no `it`/`test`/`describe` under an if, ternary, `&&`/`||`, switch or try at module or describe level (loops allowed); a test that cannot run yet is a WP-named `it.todo` | `slate/tests-registered-unconditionally` (`tools/eslint-rules/tests-registered-unconditionally.test.mjs`) | C8 |
| Comments cannot switch a guard off: only line disables, with a reason, of ordinary rules | `eslint-comments/no-use` (no inline config, `/* global */`, block disables), `require-description`, `no-unlimited-disable`, `no-unused-disable`, `no-restricted-disable`; `tools/eslint-rules/config.test.mjs` | G1 |
| Exception lists only shrink: allowlists (and the names inside them) and `eslint-suppressions.json` | `tools/guards/ratchet.test.ts` | G1 |
| Every dependency is approved with a reason; registry versions with integrity hashes only | `tools/guards/dependencies.test.ts` (`allowlists/dependencies.json`) | G1 |
| The renderer CSP never allows `'unsafe-eval'` and only shrinks; the built app's CSP is B-4's (default none, no inline script, no remote images); asar on; fuses never looser than today | `tools/guards/packaging.test.ts` (`allowlists/fuses-loosened.json`) | G1; C8 |
| What a person sees is not broken: no clipped or squeezed text, cut-off or crowded controls, overlaps, controls off their row's or column's centre line, see-through popups, browser-default controls, clipped placeholders, low contrast; every renderer change has a UI scenario whose screenshots are looked at | UI audit (`packages/desktop/e2e/ui/audit.ts`) in every scenario (`e2e/ui/*.ui.spec.ts`, `reviewUi`, run by `npm run e2e`); `npm run ui:review`; Stop hook (`.claude/hooks/uiReview.mjs`, `tools/guards/uiReview.test.ts`): a renderer change needs a scenario, a `data-ui-allow` a `UI-Allow-Reason:`, an audit change a `UI-Gate-Change:`; `audit.ts` and `review.ts` are guard files (`review-gate.mjs`, guard-edits); `.claude/skills/ui-review/SKILL.md` | phase 13 |
| Guard files, the unlock file, review files, user settings, git history and the shared git config's work-tree keys (`core.bare`, `core.worktree`) are off limits to agents | `.claude/hooks/guard-edits.mjs` (`tools/guards/guardEdits.test.ts`); CI: guard-file commits carry `Guardrail-Change:` (`scripts/agents/check-guard-commits.mjs`) | G1 |
| Lint on every edit; typecheck, lint, guards and tests at every stop; a branch with security paths, allowlisted files or risky additions is reviewed before merge | `.claude/hooks/lint-edited.mjs`, `definition-of-done.mjs`, `tools/guards/hooks.test.ts`; `tools/guards/security-paths.txt`, `scripts/agents/review-gate.mjs`, `scripts/agents/merge-wp.sh` (`tools/guards/reviewGate.test.ts`) | G1 |
| Commits: Conventional, no AI attribution, on a branch, lint-clean, never `--no-verify` | `.githooks/commit-msg`, `.githooks/pre-commit`, `guard-edits.mjs`; merge-wp re-checks subjects | phase 1; lint G1 |

Judgment calls nothing checks: comments say why, not what; one owner per piece of state; measure
before optimising. Reviews apply `docs/review/REVIEW.md`.

| Rule (G2) | Enforced by | Since |
| --- | --- | --- |
| A product rule changes only with the maintainer: its tests are guarded specs (`packages/*/test/spec/**`, `packages/desktop/e2e/spec/**`, each with an `@product-rule` header) whose expectations only grow; a removed `expect(` anywhere needs review; only a NEW test case failing on the base counts as "seen red" (a retitled case with an edited body counts as removed plus added) | guard-edits, CI `Guardrail-Change:`, merge-wp; `tools/guards/productRules.test.ts`; review-gate (removed expectation); `.claude/hooks/testsFailOnBase.mjs` | G2 |
| No auto-formatting by default: TipTap input and paste rules come only from `editorRuleOptions` (`packages/editor/src/inputRules.ts`); lists, headings, quotes and code blocks only from the toolbar's commands, never a keymap, `handleTextInput`, `appendTransaction` or input-rule plugin; the specs type `# `, `> `, `- `, "```", `1. ` and quotes; merge-wp runs the e2e specs when editor, core or renderer code changes | `slate/editor-rules-from-spec`, `slate/block-format-from-commands`; `editor/test/spec/inputRules.test.ts` (typed through the real keymap), `desktop/e2e/spec/formatting.spec.ts`, `desktop/test/spec/settingsDefaults.test.ts`; review-gate ("editor input rules"); `needsProductE2e` in merge-wp | G2 |
| The main-process rules (logging, `process.env` in any spelling, destructuring or import, SQL text, key text, child processes, crypto) apply to every package main loads: `src/main`, `packages/{sync,mcp,importer}/src`, `packages/native/*.ts` | `MAIN_PROCESS` in `tools/eslint-rules/sanctioned.mjs`; `slate/env-through-test-hooks`, `tools/guards/envVars.test.ts`; T-STATIC-01 | G2 |
| Key bytes are opaque outside the vault: `KeyRing.get` returns `KeyBytes`, which no Buffer method, copy, decoder or text conversion accepts; a consumer borrows the bytes with `withKeyBytes(key, fn)` and zeroes the key with `zeroKey`; `vaultKeyBuffer` only in main/vault and main/db | `KeyBytes`'s type (`vault/keyring.test.ts`); `slate/key-bytes-in-the-vault`, `slate/no-key-bytes-cast`, `slate/no-key-text`; review-gate ("key material": `ring.get(`, `.toString('hex'\|'base64')`) | G2 |
| Log redaction strips 128-bit and longer keys as hex or base64 and writes any bytes (Buffer, typed array, ArrayBuffer, DataView) as `[bytes]` at any depth; a `KeyBytes` is not a `LogFields` value; redaction is a security path and its thresholds are a guarded spec | `redact()`; `KeyBytes`' string-keyed brand; `packages/desktop/test/spec/redact.test.ts`; `tools/guards/security-paths.txt` (`shared/redact.ts`, `main/log/**`) | G2 |
| A program is never a shell given a command string | `proc.ts` at run time; `slate/no-shell-option` (a literal shell program) | G2 |
| Reviews are tiered: security (security paths, allowlisted files, risky changes) or architecture (other main-process code) | `reviewTier` (`scripts/agents/review-gate.mjs`), `tools/guards/{security,architecture}-paths.txt`, merge-wp, Stop hook | G2 |
| Guard-file changes need a lead-signed unlock, and the maintainer's out-of-band confirmation before main is pushed | `unlockedFor` (Ed25519, `tools/guards/unlock-key.pub`); `confirmGuardChanges` and `--confirm-guard-changes` in merge-wp; `.githooks/pre-push` (`scripts/agents/check-push.mjs`); `tools/guards/leadTools.test.ts` | G2 |
| Nothing reaches main except a merge merge-wp signed or a range the maintainer confirmed; a work-package agent never writes to the main checkout's git (via `cd`, `-C`, `--git-dir`/`--work-tree` or `GIT_DIR`/`GIT_WORK_TREE`), and no session pushes to main | guard-edits; `Merge-WP-Signature:` trailer (merge-wp); `.githooks/pre-push` runs the main checkout's `check-push.mjs` (`unacceptedCommits`, `tools/guards/leadTools.test.ts`) | G2 |
| merge-wp and unlock.mjs are the maintainer's; agents never run them | guard-edits (either tool in any spelling or path, any computed script under `scripts/agents`); merge-wp refuses an agent environment (`CLAUDE*`, `AI_AGENT`, …) and a shell outside the main checkout; unlock.mjs signs only from the Keychain on macOS | G2 |

**Unlocking guardrail work.** The lead signs an unlock line with a key kept outside the repository:
`node scripts/agents/unlock.mjs <branch> <absolute worktree path | first commit sha since main>`
appends `<branch> <token> <signature>` to `$(git rev-parse --git-common-dir)/slate-guardrails-unlock`.
`node scripts/agents/unlock.mjs --init` makes the key pair once and refuses if a key exists;
`--rotate` replaces it and prints the new public key. On macOS the private key lives only in the
login Keychain (item `slate-guardrails`, account `lead`, no trusted applications, so each read asks the
person at the screen), handed to `security` on stdin. On Linux it is a passphrase-protected
`~/.config/slate-release/guardrails.key`, used only with `--file` from a terminal. The public key is
`tools/guards/unlock-key.pub`. guard-edits and merge-wp accept only lines that key signed. Commits
that change guard files carry a `Guardrail-Change: <why>` trailer.

**Confirming what lands on main (batch).** The lead merges reviewed branches in the main checkout.
Before any push or release the maintainer runs `scripts/agents/merge-wp.sh --confirm-guard-changes`,
which by default covers everything from the last confirmation (or `origin/main`) to `main`. They read
the commits and every guard-file diff it prints, and allow the Keychain dialog. That signs
`<from>..<to> <to> <sha256 of the guard diff>` into `$(git rev-parse --git-common-dir)/slate-guardrails-confirmed`.
The pre-push hook (the main checkout's `check-push.mjs`) refuses to push main if any of these hold:
- a guard-file change is not covered by such a confirmation;
- a commit new on main's first-parent line is neither a merge signed by merge-wp nor inside a
  confirmed range.

`merge-wp.sh <branch>`, run by the maintainer, signs its merge (`Merge-WP-Signature:`) and asks the
same way for that one branch's guard changes.

**Residual risk** (what the checks do not stop, and the layer that backstops each):

- **An agent runs as the same OS user as the maintainer.**
  - It can rewrite a hook through a command guard-edits cannot parse (`node -e` with an encoded path,
    `tar`, `patch`).
  - It can write the unlock or confirmation file by a computed name. Neither file counts without the
    lead key's signature, and the guard-file diff is still shown to the maintainer at confirmation.
  - The Keychain dialog names `security`, not the script that asked. The maintainer allows it only
    while they are running merge-wp or unlock.mjs themselves.
  - The `-T ""` access list is set through `security -i` by code that was not run here (to keep
    dialogs off an agent run). Check it once in Keychain Access after the next `--rotate`.
- On Linux, any process of the user can read the key file; the passphrase is the protection.
- CI's `Guardrail-Change:` check proves only that the trailer is there, not who wrote it. The signed
  unlock and the confirmation before push are the real gate. `git push --no-verify` skips the
  pre-push check; agents are refused it and never push.
- Vault code still unwraps `KeyBytes` with `vaultKeyBuffer` (`vault/migration.ts`,
  `vault/vaultCheck.ts`). C4 moves those keys behind native handles and removes it.
- Aliasing beyond one step (`const M = Math; M.random()`, `const BW = BrowserWindow; new BW()`,
  `Reflect.construct`) passes lint; the review gate puts main-process code in front of a reviewer.
- A secret pasted into source as a literal, or a vendored library under `src/`: review.
- `~/.claude/settings.json` and `~/.claude/CLAUDE.md` are outside the repo; guard-edits refuses
  writes to them, but the maintainer owns them.


## Releasing

1. Bump `version` in the root and `packages/desktop` `package.json` (they must match), and move
   `CHANGELOG.md`'s Unreleased entries under the new version. Commit as `chore(release): vX.Y.Z`.
2. The maintainer tags `vX.Y.Z` and pushes the tag. `.github/workflows/release.yml` checks the tag
   against both versions, runs the tests, builds macOS arm64 and Linux x64 and publishes the
   GitHub release with `latest-mac.yml` and `latest-linux.yml`, which the in-app updater reads
   (`packages/desktop/src/main/update/`). Never tag or push yourself.

## Definition of done

Checked by `.claude/hooks/definition-of-done.mjs` (Stop hook) on the whole branch since
`SLATE_BASE_REF` (default `main`):

- `npm run typecheck`, `npm run lint:changed` and `npm run guards` pass; `npm test` passes;
  `npm run test:main` passes if `src/main` changed.
- A behaviour change has a test in the cheapest layer, written first and seen failing. The hook
  runs changed unit tests against the base's source and requires at least one to fail there.
  Pure refactors say why in a `No-Red-Test-Reason:` commit trailer; a change needing no test says
  why in `No-Test-Reason:`.
- No test file loses cases (`Removed-Tests-Reason:` if on purpose).
- Everything committed, as a Conventional Commit (`feat(editor): …`).
- E2E specs the change touches pass (`npm run e2e -- <spec>`); the hook does not run e2e.

## Product rules (from the spec)

- **No auto-formatting by default**: lists, headings and code blocks only from an explicit
  command. TipTap input/paste rules are off unless the "Markdown Shortcuts" setting is on. No
  smart quotes, autocorrect, autocapitalise or spellcheck replacement. The one exception is
  `* ` at the start of a paragraph becoming a bullet list (`autoBullets`): on by default,
  switchable in Settings → Autocorrect, and undone by Backspace right after. Pasted http, https,
  mailto and www. addresses become links (`linkPastedUrls`, on by default, the maintainer's
  decision in 0.4.2), through `PastedLinks` in `packages/editor/src/links.ts`, never a paste rule;
  paste as plain text never links.
- **Copy as plain text**: real list numbers, 2-space nesting, `- ` bullets, code verbatim, tabs
  between table cells, LF only, NBSP → space, no zero-width characters, trailing newlines trimmed.
  Lives in `toPlainText` (`packages/core/src/plaintext.ts`); extend it there, never a second copy.
- **Copy as HTML**: semantic tags, no inline style except colour. **Default paste**: keep
  structure and bold/italic, drop fonts, sizes, colours, classes. `Mod+Shift+V` pastes plain text.
- **Performance budget**: under 16 ms per keystroke, under 100 ms to open a page
  (`packages/desktop/e2e/spec/perf.spec.ts`). Measured after the renderer settles: renderer main-thread
  CPU per key up to its rendered frame p95 < 16 ms, wall-clock key latency median < 16 ms and p95 < 33 ms
  (two frames), and page open < 100 ms, each wall-clock check best of 3 runs (`spec/perfProbes.spec.ts`
  shows each one failing on the slowness it is for).
- E2E launches set `SLATE_E2E=1`, which keeps the window hidden: tests never pop windows onto
  the user's screen. After an e2e run, no Electron process from this checkout is left running.
- Comments say why, not what, and carry facts that still hold, not history.

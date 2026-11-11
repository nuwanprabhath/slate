# Pre-release checklist (0.2.0)

Gates that only the maintainer can pass. Agents never tag, push or release (`CLAUDE.md`, Releasing). Tick each one
before you tag `v0.2.0`.

- [x] **Linux CI is green** (2026-10-27, run 40405028144 on 6d2d1cd): memory evidence (T-ZERO-04/06), Linux e2e, the
  native builds for linux-x64, darwin-arm64 and darwin-x64, unit, main-process and guard tests all pass.
- [x] **FIPS provider pins committed from CI** for darwin-arm64, darwin-x64 and linux-x64. The release builds on the same
  runners (macos-15, ubuntu-24.04), so it reproduces them. A local build on another toolchain gives a different
  darwin-arm64 digest: build release artefacts only in CI. A runner image change moves it too: the darwin-arm64 pin was
  re-measured on macos-15 (2026-11-07, CI run 42356676531) when macos-14 was retired, and must be again on the next
  change of the release's runner.
- [x] **`SLATE_UPDATE_SIGNING_KEY` is set** as a secret of the `release` environment of `nuwanprabhath/slate` (the
  Ed25519 private key the lead generated outside the repository). The environment allows only `v*` tags to deploy,
  and `release.yml`'s publish job names it; a repository secret would also work but reaches every workflow. Without it the release cannot sign the update feeds, and no running 0.2.x app will accept
  the update (unsigned updates are never accepted, `decisions.md`).
- [x] **Guard-change batch confirmed.** In the main checkout, run `scripts/agents/merge-wp.sh --confirm-guard-changes`,
  read every commit and guard-file diff it prints, and allow the Keychain dialog. The pre-push hook refuses a push of
  main until you have.
- [x] **C8 criterion 3 settled** (2026-10-26). The maintainer sealed `e2e/fixtures/safe-storage-sync-sealed.json` with
  the pre-C8 sync API on their Mac; `npm run e2e:keychain` opens it with the async API (passes; a corrupted copy
  fails). Rerun it on that Mac before a release that touches secret storage.
- [x] **GitHub branch protection on `main`** (ruleset: no deletion, no force push) is on (required status checks, no force push), so the agents' commit
  trail cannot be rewritten after the fact.
- [ ] **D-1 signing is acknowledged.** The macOS build is ad-hoc signed and the Linux packages are unsigned, so
  POAM-01, -02, -03 and -07 stay open (`poam.md`). Nothing to do for 0.2.0 unless you have decided to buy a Developer
  ID; if you have, do it before tagging, because it changes `fips.dylib`'s bytes and its pin (POAM-07).
- [ ] **Ship C5 and C9 together (both in 0.2.0).** No 0.1.x or 0.2.x-without-C9 build may change a v2 vault's password.
- [x] **The tag runs the full gate** (release.yml, 0.7.0). `release.yml`'s first job (`gate`) refuses a tag whose
  commit is not an ancestor of `origin/main` and checks the tag against both `package.json` versions; its `verify`
  job then calls `.github/workflows/verify.yml`, the same reusable workflow CI runs on a push, so a tag runs lint,
  guards, traceability, the guard-commit check, unit, main-process, the Linux e2e suite, the memory evidence
  (T-ZERO-04/06) and the native matrix. `build`, `sbom` and `publish` all depend on `gate` and `verify`, so a red
  check cannot publish. Before 0.7.0 the release ran only typecheck plus the unit and main-process tests, which is
  how v0.6.7 was published from a commit whose Ubuntu e2e job had failed (review F4) — the "Linux CI is green" tick
  above is no longer the only thing standing between a failing test and an immutable release.
- [ ] **Versions match.** The root and `packages/desktop` `package.json` both say 0.2.0, and CHANGELOG's
  `## [0.2.0]` section is dated (`release.yml` checks the tag against both versions).
- [ ] **Read the README's "Upgrading to 0.2.0"** once more: it is the user-facing warning about 0.1.x devices.

After tagging, check that the GitHub release carries `latest-mac.yml`, `latest-linux.yml` and their signatures. A
0.1.x app does not check signatures and will offer 0.2.0 as before: remind users to update every device
(README, "Upgrading to 0.2.0").

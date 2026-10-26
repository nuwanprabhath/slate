# Pre-release checklist (0.2.0)

Gates that only the maintainer can pass. Agents never tag, push or release (`CLAUDE.md`, Releasing). Tick each one
before you tag `v0.2.0`.

- [ ] **Linux CI is green.** The workflow runs on a Linux runner for the first time with this release. All of these
  must pass there:
  - the memory evidence (`e2e/memory.spec.ts`, T-ZERO-04 and T-ZERO-07, which run on Linux only);
  - the native build for linux-x64 (OpenSSL, FIPS provider, SQLCipher) and the unit, main-process and guard tests;
  - the FIPS provider pins for **linux-x64 and darwin-x64** are committed (only macOS arm64 could be measured on the
    development machine; read the hash from the CI build and commit it with the other pins).
- [ ] **`SLATE_UPDATE_SIGNING_KEY` is set** as a GitHub Actions secret (the Ed25519 private key the lead generated
  outside the repository). Without it the release cannot sign the update feeds, and no running 0.2.x app will accept
  the update (unsigned updates are never accepted, `decisions.md`).
- [ ] **Guard-change batch confirmed.** In the main checkout, run `scripts/agents/merge-wp.sh --confirm-guard-changes`,
  read every commit and guard-file diff it prints, and allow the Keychain dialog. The pre-push hook refuses a push of
  main until you have.
- [ ] **C8 criterion 3 settled.** Either supply the fixture it needs, or write down that you accept the gap, in
  `decisions.md`.
- [ ] **GitHub branch protection on `main`** is on (required status checks, no force push), so the agents' commit
  trail cannot be rewritten after the fact.
- [ ] **D-1 signing is acknowledged.** The macOS build is ad-hoc signed and the Linux packages are unsigned, so
  POAM-01, -02, -03 and -07 stay open (`poam.md`). Nothing to do for 0.2.0 unless you have decided to buy a Developer
  ID; if you have, do it before tagging, because it changes `fips.dylib`'s bytes and its pin (POAM-07).
- [ ] **Ship C5 and C9 together (both in 0.2.0).** No 0.1.x or 0.2.x-without-C9 build may change a v2 vault's password.
- [ ] **Versions match.** The root and `packages/desktop` `package.json` both say 0.2.0, and CHANGELOG's
  `## [0.2.0]` section is dated (`release.yml` checks the tag against both versions).
- [ ] **Read the README's "Upgrading to 0.2.0"** once more: it is the user-facing warning about 0.1.x devices.

After tagging, check that the GitHub release carries `latest-mac.yml`, `latest-linux.yml` and their signatures. A
0.1.x app does not check signatures and will offer 0.2.0 as before: remind users to update every device
(README, "Upgrading to 0.2.0").

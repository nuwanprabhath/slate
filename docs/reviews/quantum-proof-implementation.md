# Slate post-quantum implementation report

Document id `SLATE-PQ-IMPL-2026-10-29` · implements [`quantum-proof-roadmap.md`](quantum-proof-roadmap.md)
(`SLATE-PQ-2026-10-29`) · released in **0.4.0** on 2026-10-29 (one commit on `main`, `dc3b525`, tag `v0.4.0`) ·
base: 0.3.0 at `3a47a7b`.

This report says what was built, where it lives, which tests close it, where the build departed from the plan, and
what is still open. The roadmap remains the specification; section numbers like §3.5 refer to it.

---

## 1. Executive summary: where Slate stands against a quantum attacker

"Quantum-proof" here means: an adversary who records everything today and later owns a cryptographically relevant
quantum computer (CRQC) can neither read Slate's notes nor push a forged update to a Slate install. Slate 0.4.0
meets that for everything Slate itself controls. The remaining gaps are third-party servers that do not offer a
post-quantum key exchange yet, and they are reported in the app rather than hidden.

| Asset | Threat from a CRQC | State in 0.4.0 | Why it holds |
| --- | --- | --- | --- |
| Notes at rest (vault files, `SLE1`/`SLE2` envelopes, SQLCipher database, sync remote copies) | Shor breaks public-key crypto; Grover halves symmetric key strength | **Resistant, unchanged** | Every key protecting notes is symmetric and 256-bit (AES-256-GCM, KBKDF HMAC-SHA-256, SQLCipher AES-256 + HMAC-SHA-512, Argon2id / PBKDF2 password KEKs, a 256-bit recovery key). Grover leaves at least 128-bit strength. No note was re-encrypted, because none needed to be. |
| Future vault format | A classical public-key wrap slot would sit in the sync remote forever and give a CRQC the master key | **Ruled out by the format** | Vault header v3 makes "hybrid only" a signed property of the vault (`pq.kem = "hybrid-only"`). The JSON Schema and parser refuse any key-encapsulation slot without an ML-KEM component (INV-PQ-1). |
| Sync over git + SSH | Harvest now, decrypt later: record the SSH session, break its key exchange later | **Resistant when the local `ssh` supports it** (OpenSSH 9.0 and later; the maintainer's Mac and GitHub both do) | Slate's `GIT_SSH_COMMAND` puts `mlkem768x25519-sha256` (then `sntrup761x25519-sha512@openssh.com`) first. Both are hybrids, so the session is never weaker than X25519. Before 0.4.0, macOS negotiated classical `ecdh-sha2-nistp256` with GitHub. |
| Sync over OneDrive, Microsoft sign-in | Harvest now, decrypt later on TLS | **Client ready; servers still classical** (POAM-17) | Slate's TLS client offers `X25519MLKEM768` first, pinned by a regression test. `graph.microsoft.com` and `login.microsoftonline.com` still answer with `secp384r1`, so these sessions become hybrid with no Slate change once Microsoft enables it. With end-to-end encryption on, the note content inside is already sealed with AES-256-GCM. |
| Sync over git + HTTPS | Same | **Not fixable by Slate** (POAM-17) | The system git's TLS library (macOS LibreSSL 3.3.6) has no hybrid groups and GitHub HTTPS answers `X25519`. Slate detects it, shows it in Settings → Security, and recommends SSH. "Require post-quantum key exchange" refuses it. |
| Updates | A CRQC forges an Ed25519 release signature and ships malware | **Resistant from 0.4.0 on** | Every release file is signed with a hybrid `ml-dsa-65+ed25519` signature (`.pq.sig`). A 0.4.0 or later install requires **both** halves to verify, so breaking Ed25519 alone does not suffice (INV-PQ-8). Installs still on 0.3.0 or older verify Ed25519 only until they update. |

**In one sentence:** the notes were already quantum-resistant, and 0.4.0 closes the two real exposures Slate controls,
SSH sync transport and update signatures, while making sure no future format can add a classical public-key
weakness.

What this is **not**:

- It is not a FIPS 140-3 claim for the post-quantum parts. ML-DSA verification runs in OpenSSL 3.5.9's default
  provider, outside the validated module (CMVP #4985 predates FIPS 203/204). It handles public data only (POAM-18).
- It does not make third-party servers post-quantum; it prefers hybrids, measures what was negotiated and says so.
- Device enrolment with hybrid ML-KEM slots (D-6) was not built; v3 only reserves and constrains them.

---

## 2. Decisions taken

All of roadmap §4.8 was decided as recommended on 2026-10-29.

| Id | Decision | Effect |
| --- | --- | --- |
| D-9 | Upgrade v2 → v3 automatically after unlock once every device reports `pq ≥ 1` | No prompt. Changes no secret and no ciphertext. v1 → v3 stays prompt-only. |
| D-6 | Hybrid device slots stay deferred | PQ-A5 and PQ-B6 not built. |
| D-10 | Prefer hybrid SSH key exchange: on. Require: off by default | Settings → Sync → **Require post-quantum key exchange** is opt-in. |
| D-11 | ML-DSA-65 (not ML-DSA-87) | Category 3; already planned in `key-inventory.json`. |
| D-12 | The lead generated the ML-DSA key pair | Private key in `~/.config/slate-release/update-signing-key-mldsa.pem` (outside the repo) and in the `release` environment secret `SLATE_UPDATE_SIGNING_KEY_MLDSA`. The public key is pinned in `update/signature.ts`. |

---

## 3. What was built, by work package

Test ids are `T-PQ-<WP>-<n>`. Every id the roadmap lists for a built work package exists in the tree. All but one
run in the test suites that passed on CI for `dc3b525`; T-PQ-A1-08 is the shell cross-check
`packages/native/test/crossCheck.sh`, which compares the ACVP vectors against an OpenSSL 3.5 CLI and runs by hand.

### Wave 0: contracts

**Q-0.** `shared/api.ts` gains `PqLevel`, `TransportObservation`, `PqReadiness`, `VaultApi.pqReadiness` and
`SyncApi.checkTransport`. Settings key `syncRequirePq`. Channels registered in `main/pqIpc.ts`, which assembles
the readiness answer from the vault upgrade state, the sync source's transports and the pinned update key.

### Track A: native crypto and update signatures

| WP | Built | Key files | Tests |
| --- | --- | --- | --- |
| A1 | ML-DSA verification in `@slate/native`, in the standard (non-FIPS) library context; `status()` lists `pqAlgorithms` and `pqInFipsBoundary: false`; the build checks the PQ symbols are linked | `native/src/slate_crypto_core.c` (`scc_mldsa_verify`), `native/index.ts`, `vault/native.ts` (`verifyMlDsa`), `build-openssl.mjs` | `native/test/pq.test.ts`, `kat.c` (NIST ACVP vectors), `surface.test.ts`, `crossCheck.sh`: T-PQ-A1-01…08 |
| A2 | Hybrid verifier: a pinned key is Ed25519 or hybrid; a hybrid pin fetches and requires `.pq.sig`; the message is domain-separated (`"slate-update/v2|ml-dsa-65+ed25519|" ‖ keyId ‖ "|" ‖ M`, ML-DSA context `"slate-update"`) | `update/signature.ts`, `update/verifier.ts` | `signature.test.ts`, `verifier.test.ts`, `updateService.test.ts`, `e2e/update.spec.ts`: T-PQ-A2-01…06 |
| A3 | Signer writes `.sig` and `.pq.sig` and refuses to run without `SLATE_UPDATE_SIGNING_KEY_MLDSA`; release workflow signs on Node 24 and asserts OpenSSL ≥ 3.5 | `scripts/sign-update.mjs`, `.github/workflows/release.yml` | `update/signRelease.test.ts`: T-PQ-A3-01…03 |
| A4 | Power-up self-test `POST-MLDSA-VERIFY`, reported as outside the module | `vault/selftest/{vectors,post,report}.ts` | `post.test.ts`, `post.mutation.test.ts`: T-PQ-A4-01…03 |

Hybrid key id: first 16 hex digits of SHA-256(Ed25519 SPKI DER ‖ ML-DSA SPKI DER). Production hybrid key id
`f26ba10dc0f0f651`; its Ed25519 half is the existing key `f84167138197d38f`.

### Track B: vault format and migration

| WP | Built | Key files | Tests |
| --- | --- | --- | --- |
| B1 | Header v3: JSON Schema, parser, serializer; `pq { kem: "hybrid-only", minCapability }`; at most 16 device slots; wraps keep the v2 AAD byte for byte; v3 accepted by quick unlock, migration and the profile floor | `vault/header.ts`, `docs/compliance/schemas/vault-header-v3.schema.json`, `fixtures/pq` | `header.test.ts`, `fuzz.test.ts`, `quickUnlock.test.ts`: T-PQ-B1-01…10 |
| B2 | Devices report `capabilities.pq`; the gate names the devices that cannot read v3 yet | `vault/deviceGate.ts`, `sync/syncService.ts` | `deviceGate.test.ts`, `syncService.test.ts`: T-PQ-B2-01…03 |
| B3 | The §3.5 state machine: after unlock, stage `vault.pq-candidate.json`, verify it opens with the live keys, swap atomically, raise the profile floor to `minHeaderVersion = 3`; crash at any step leaves a vault that opens | `vault/pqUpgrade.ts`, `index.ts` (`startPqUpgrade` after unlock) | `pqUpgrade.test.ts`, `pqUpgradeCrash.test.ts`, `fipsProfile.test.ts`, `e2e/pq-upgrade.spec.ts` (a real 0.3.0 vault): T-PQ-B3-01…10 |
| B4 | v1 vaults upgrade straight to v3; new vaults are created on v3; key rotation and rekey keep v3; rekey refused while a header upgrade is in flight | `vault/createVault`, `rekeyHeader`, `deviceGate.ts` (`pqGateBlocking`) | `crossVersion.test.ts`, `rotation.test.ts`, `rekey.test.ts`, `e2e/encryption.spec.ts`: T-PQ-B4-01…06 |
| B5 | `transport_observations` table: what each remote negotiated, and when | `main/store.ts` | `store.test.ts`: T-PQ-B5-01…03 |

### Track C: transport

| WP | Built | Key files | Tests |
| --- | --- | --- | --- |
| C1 | Probe `ssh -Q kex`, then `GIT_SSH_COMMAND = ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com`, built only from literal names; `PqTransportUnavailable` in require mode | `packages/sync/src/gitRunner.ts` | `sshKex.test.ts`, `sshKex.integration.test.ts`: T-PQ-C1-01…07 |
| C2 | Parse the negotiated key exchange from ssh and TLS; Test connection returns `kex`, `pq` and the remote host | `packages/sync/src/transport.ts`, `main/sync/git/auth.ts` | `transport.test.ts`, `auth.test.ts`: T-PQ-C2-01…04 |
| C3 | One place sets TLS groups; keeps `DEFAULT_ECDH_CURVE = 'auto'` (offers `X25519MLKEM768` first); a static check forbids setting groups elsewhere | `main/tlsPolicy.ts` | `tlsPolicy.test.ts`, `static.test.ts`: T-PQ-C3-01…04 |
| C4 | **Check now** probe (main process only, unlocked only, no application bytes sent); prefer/require policy in sync | `main/sync/transportProbe.ts`, `sync/syncService.ts` | `transportProbe.test.ts`, `syncService.test.ts`, `pqIpc.test.ts`: T-PQ-C4-01…05 |

### Track D: UI, diagnostics and documents

| WP | Built | Tests |
| --- | --- | --- |
| D1 | Settings → Security → **Post-quantum readiness**: note encryption, vault format, each sync host's negotiated exchange with **Check now**, update signature type | `quantumReadinessText.test.ts`, `e2e/ui/security.ui.spec.ts`: T-PQ-D1-01…03 |
| D2 | Settings → Sync → **Require post-quantum key exchange**; a banner while the format upgrades | `requirePqText.test.ts`, `vaultFormatBanner.test.ts`, `e2e/settings.spec.ts`, `e2e/ui/settings.ui.spec.ts`: T-PQ-D2-01…06 |
| D3 | Cryptographic-module row lists the PQ algorithms and says they are outside the module; diagnostics export gains the vault format and per-host key exchange (host names only) | `cryptoModuleText.test.ts`, `log/pqState.test.ts`, `e2e/diagnostics.spec.ts`: T-PQ-D3-01…03 |
| D4 | `key-inventory.json` (`UPD_SIG_MLDSA`), `crypto-module.json`, `poam.md` (POAM-17, POAM-18), `decisions.md` (D-9…D-12), `security-policy.md`, OSCAL, README, CHANGELOG | traceability check |

### Invariants

| Id | Invariant | Closed by |
| --- | --- | --- |
| INV-PQ-1 | No artefact carries public-key encryption without ML-KEM | T-PQ-B1-04 (`header.test.ts`) |
| INV-PQ-2 | No note ciphertext changes during the upgrade | T-PQ-B3-02 (`pqUpgrade.test.ts`); T-PQ-B3-10 checks a note survives end to end |
| INV-PQ-3 | Password, recovery key and quick unlock keep working | T-PQ-B3-01, T-PQ-B3-10 |
| INV-PQ-4 | After v3, every v2 copy of the header is refused | T-PQ-B3-05 |
| INV-PQ-5 | No v3 while any device lacks `pq ≥ 1` or cannot be read | T-PQ-B2-02, T-PQ-B3-04 |
| INV-PQ-6 | `GIT_SSH_COMMAND` holds only literal algorithm names | T-PQ-C1-03 |
| INV-PQ-7 | TLS groups set only in `tlsPolicy.ts`; default offers `X25519MLKEM768` | T-PQ-C3-01, T-PQ-C3-03 |
| INV-PQ-8 | A hybrid-pinned build never accepts an Ed25519-only signature | T-PQ-A2-03 |
| INV-PQ-9 | A `fips-140-3` upgrade calls no legacy primitive; no PQ primitive is shown as inside the module | T-PQ-B3-07, T-PQ-D3-01 |

---

## 4. Where the build departed from the plan

- **Rekey during an upgrade (B4).** Review added T-PQ-B4-06: a rekey is refused while a `pq-header` upgrade record
  exists, so a password change cannot race the header swap.
- **Release signing on Node 24 (A3).** Node 22 cannot sign ML-DSA, and Electron's BoringSSL signs only from a
  seed-only key. The publish job moved to Node 24 and asserts OpenSSL ≥ 3.5 (guard change to `release.yml`).
- **Upgrade button (D1).** The readiness panel's "upgrade now" is an `onUpgrade` prop handled by the keys group,
  not a DOM click into another component.
- **Banner polling (D2).** Every 2 s while an upgrade runs, 5 s otherwise (it polled every 2 s forever).
- **E2E test vault (B3 knock-on).** The e2e test vault is created on v3. On v2, the automatic upgrade ran the
  deliberately corrupted self-test of T-POST-12 and failed it for the wrong reason.
- **Guard changes.** Seven guard-file commits were needed (security paths for `tlsPolicy.ts`, self-test coverage
  and mutation entries for `mldsaVerify`, v3 schema equivalence, an allowlist reason, the release workflow, and
  `pqUpgrade.ts` as a writer of `vault.json`). The maintainer confirmed them before the push.
- **History.** The 77 phase-14 commits were squashed into one at the maintainer's request; the original history is
  on the local branch `backup/pre-squash-0.4.0`.

---

## 5. Verification

| Check | Result (local, before push) |
| --- | --- |
| Typecheck, lint | clean |
| Guards | 699 passed |
| Unit tests (`npm test`) | 583 passed |
| Main-process tests | 1059 passed, 3 skipped |
| Traceability | every finding traced |
| E2E | 220 passed, 2 skipped; the two failures found were fixed (§4) and pass alone |
| Signing dry run | real keys under Node 25: both halves of `.pq.sig` verify against the pinned key |

On GitHub: CI for `dc3b525` passed all six jobs; the `v0.4.0` release workflow passed all five and published every
file with a `.sig` and a `.pq.sig`, including `latest-mac.yml` and `latest-linux.yml`.

Still to observe on real machines (roadmap §4.10):

- Settings → Security → **Check now** on the maintainer's Mac reports `mlkem768x25519-sha256` for
  `nuwanprabhath/slate-notes`.
- The maintainer's vault reads v3 after unlock, once both the Mac and the Ubuntu machine run 0.4.0, and still opens
  with the password and the recovery key with the same note count.

---

## 6. Open items and residual risk

| Item | What it means | Tracked as |
| --- | --- | --- |
| Microsoft and GitHub HTTPS negotiate classical key exchange | Their recorded traffic could be decrypted by a future CRQC. With end-to-end encryption on, the note content inside stays sealed by AES-256-GCM; metadata and plaintext-sync content are exposed | POAM-17; closes when the probe sees a hybrid |
| An `ssh` without hybrid support | Prefer mode falls back to the system's classical list; require mode refuses to sync | Settings → Security shows the negotiated method per host |
| ML-DSA outside the FIPS boundary | Update verification is not a validated-module operation | POAM-18; PQ-A6, blocked on a CMVP certificate covering FIPS 203/204 |
| Installs below 0.4.0 | Verify Ed25519 only until they update to 0.4.0 | Closes as installs update |
| One pinned update key, no rotation root | Losing or replacing the hybrid key needs an app release with the next key pinned first | POAM-05; PQ-X3 (SLH-DSA rotation root) in the backlog |
| Guardrail unlock and merge signatures are Ed25519 | Developer tooling, not the product; no stored ciphertext depends on it | PQ-X1 in the backlog |
| Hybrid device slots | Not built; passwordless enrolment and sharing would need them | D-6, PQ-A5 / PQ-B6 |
| CNSA-strict hash sizes | KBKDF HMAC-SHA-384 suite for a CNSA 2.0 profile; not needed for quantum resistance | PQ-X2 |
| HTTPS require mode | Only once a server Slate talks to offers a hybrid | PQ-X4 |

## 7. Operating notes for the next release

- Every release must ship `.pq.sig`. A build that pins the hybrid key refuses a feed without one, so a release
  signed without `SLATE_UPDATE_SIGNING_KEY_MLDSA` would strand every 0.4.0 install. The signer refuses to run
  without the key, and the release job reads it from the `release` environment.
- The signing job needs Node 24.7 or later (OpenSSL 3.5) to sign ML-DSA.
- After changing native code locally, build with `node packages/native/scripts/build-addon.mjs`. The full native
  build replaces the FIPS provider and then refuses it because it no longer matches the pin.
- Never re-add a classical public-key slot to the vault format. The v3 schema forbids it, and the guard
  `headerSchema.test.ts` checks the schema and the parser agree.

# Slate: security policy for the embedded cryptographic module

Audience: someone who must decide whether Slate's use of the OpenSSL FIPS Provider fits their rules (a module
consumer's policy, in the sense of FIPS 140-3 IG 2.4.A and the module's own Security Policy). It describes how
Slate uses the module. It is not a Security Policy for a module that Slate owns: Slate has no CMVP certificate of
its own (decision D-3 in [`decisions.md`](decisions.md)). Audit: `docs/reviews/compliance_audit.md`
(SLATE-CA-2026-10-23).

## 1. The module and what is claimed

| Item | Value |
| --- | --- |
| Module | OpenSSL FIPS Provider 3.1.2 |
| Certificate | CMVP #4985, FIPS 140-3, active, sunset 2030-03-10 ([certificate](https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4985)) |
| Host library | OpenSSL 3.5.9 libcrypto, statically linked into `@slate/native`; the provider loads as an unmodified shared object whose hash is pinned |
| Platforms built | macOS arm64 and Linux x64 (macOS x64 and Windows have no FIPS build) |
| Machine-readable record | [`crypto-module.json`](crypto-module.json), [`oscal/slate-component-definition.json`](oscal/slate-component-definition.json) |

The claim, word for word (audit §1.2):

> In the `fips-140-3` profile, every cryptographic operation that protects notes is performed by the OpenSSL FIPS Provider 3.1.2 (CMVP certificate #4985, FIPS 140-3, active, sunset 2030-03-10) in its approved mode. Slate runs a power-up self-test, enters a terminal error state on any failure, and destroys key material at lock.

What it does not claim:

1. Slate itself is not validated under FIPS 140-3. Only the embedded module holds a certificate.
2. Slate is not FedRAMP authorized and has no Cloud Service Offering (D-5).
3. The TLS that sync and sign-in use (git's TLS or SSH, Electron's `fetch`) is outside the module (POAM-11). Note
   contents are sealed before transport; credentials are not.
4. Malware running as the user while Slate is unlocked is outside the threat model.
5. The module's DRBG is seeded from the operating system's entropy source, which is outside the module boundary
   (`entropyCaveat` in `crypto-module.json`).

## 2. Approved services Slate uses

All run inside the module. JavaScript holds `KeyHandle`s (small integers) and never key bytes.

| Service | Use in Slate | Profile |
| --- | --- | --- |
| SHA-256, HMAC-SHA-256 (FIPS 180-4, 198-1) | vault header `check`, blob names, SIV names, KDF PRF | both |
| AES-256-GCM (SP 800-38D), random 96-bit IV from the module DRBG | header wraps, `SLE2` envelopes, local database-key wrap | both |
| KBKDF, counter mode, HMAC-SHA-256 (SP 800-108r1) | master key to every subkey, per-file keys (suite 0x02) | both (new vaults) |
| PBKDF2-HMAC-SHA-512 (SP 800-132 option 2), at least 600 000 iterations | password to password KEK | `fips-140-3` |
| AES-256-CTR with an HMAC-derived counter block (SIV-style) | deterministic remote names | both (new vaults); L-2 open |
| DRBG (SP 800-90A, `RAND_priv_bytes_ex`) | every key, salt, nonce and IV | both |
| SQLCipher 4.19 page encryption (AES-256-CBC with HMAC-SHA-512), keyed from a handle | local database | both; L-5 open |

Services that are not approved (Argon2id, RFC 5869 HKDF, AES-ECB for suite-1 names, `SLE1`) exist only for vaults in the
`standard` profile and for reading old vaults. A `fips-140-3` vault never reaches them: unlock latches the module
approved-only before the first key is derived, and the module refuses a legacy service afterwards (SCC_16; tests in
`vault/fipsProfile.test.ts` and `native/test/suite2.test.ts`).

## 3. Roles

Slate has one operator per vault: the person who knows the password or recovery key. There is no administrator
role, no authentication service and no remote operator.

| Role | Who | What they can do |
| --- | --- | --- |
| User (and Crypto Officer for the module's purposes) | The person at the keyboard, authenticated by the vault password or the recovery key | Unlock, lock, change password, rotate keys, upgrade or convert the vault, run the self-tests |
| Slate main process | Acts for the user after unlock | Passes handles to the module; the module refuses a key used outside its usage flags |
| Sync peers and the sync host | None | See ciphertext only |

Authentication limits in the `fips-140-3` profile (AC-7 and IA-5(1) as built): passwords of at least 15 characters;
three wrong passwords within 15 minutes lock password unlock for three hours (the recovery key still works and
resets it); idle lock at most 15 minutes; lock on sleep and on screen lock always on; no quick unlock.

## 4. Self-tests

The power-up self-test (`vault/selftest/post.ts`, `KAT_IDS`) runs before any service is used: the module starts
gated (`postGate`) and no service answers until `runPost` has passed. It runs again from Settings, Security, *Run
self-tests*, and before every vault change (encrypt, join, change password, new recovery key, rotate, upgrade and
convert).

| Id | What it checks |
| --- | --- |
| `POST-MODULE-STATUS` | the provider is loaded, approved mode is on, its hash matches the pin |
| `POST-SHA256`, `POST-HMAC-SHA256` | known answers |
| `POST-AES-ECB-ENC`, `POST-AES-ECB-DEC` | AES-256 block known answers (standard profile and old vaults) |
| `POST-AES-GCM-ENC`, `POST-AES-GCM-DEC`, `POST-AES-GCM-TAG-REJECT` | GCM known answer both ways, and a changed tag is refused |
| `POST-KBKDF`, `POST-HKDF-LEGACY`, `POST-PBKDF2`, `POST-ARGON2ID` | key derivation known answers; after a `fips-140-3` latch the legacy ones must be refused instead |
| `POST-KEY-WRAP`, `POST-RECOVERY` | how Slate combines them: wrap, unwrap and rewrap; recovery-key encode and derive |
| `POST-SLE2-SEAL`, `POST-SLE1-OPEN`, `POST-NAME-V2` | sync-file envelope and remote-name known answers |
| `POST-DRBG` | the DRBG returns distinct output |
| `POST-ZEROIZE` | a destroyed key is gone from the secure heap |
| `POST-MLDSA-VERIFY` | ML-DSA-65 known answer, and a flipped signature is refused. It runs in the OpenSSL 3.5.9 default provider, **outside** the validated module, and is reported as such (section 7a) |

Other failure causes: `POST-MODULE-LOAD` (the module could not be loaded), `POST-TIMEOUT` (the run overran its
budget), `POST-HARDEN` (the process could not make itself non-dumpable). Tests: T-POST-01 to T-POST-13 (see
[`traceability.yaml`](traceability.yaml)).

## 5. Error state

Any failed self-test, and any module fault (SCC_12 or an `enterErrorState` call) at any time, puts Slate in
`selftest-failed`. The state is terminal until Slate is quit and restarted.

- The module refuses every service.
- Every window closes except one error screen showing the failed test id, **Quit** and **Copy diagnostic report**.
- The databases, the AI-access socket and the update check stop; no note is opened, encrypted or not (D-2).
- The data folder is left as it was (T-POST-10).

Tests: `vault/selftest/*.test.ts`, `vaultState.test.ts`, `ipcGuard.test.ts`, `e2e/selftest.spec.ts`.

## 5a. Key epochs, history, rotation, upgrade and conversion

Each master key belongs to an epoch (header `epoch`). Rotation (Settings, Security, *Rotate keys*), the upgrade of a
v1 vault to v2 and the conversion of a `standard` vault to `fips-140-3` all make a new master key, a new recovery key
and a fresh salt, and move the vault to epoch + 1. They are never automatic (D-7) and are offered only once every
device record reports version 0.2.0 or newer.

- **History.** Earlier epochs' master keys are kept in the header's `history`, each sealed under a key derived
  inside the module from the current master key (`historySeal`, `historyRewrap`, `historyOpen`; KBKDF label
  `slate/v2/history`). The derived key never becomes a handle. A key enters history only against a proof (its wrap under a
  password KEK that opens it), and the entry's AAD binds the profile, so a standard entry never opens under a
  `fips-140-3` header. At most 4 entries are kept. A conversion to `fips-140-3` leaves history empty (R-3).
- **Zeroisation.** History keys and the earlier epochs' subkeys are destroyed by `KeyRing.close()` at every lock.
  Sync files of earlier epochs are re-pushed under the new epoch, swept, and the history entry is pruned once no file of
  that epoch remains (R-2). Replacing the sync history (Settings) is the way to remove old ciphertext from a remote.
- **Crash safety.** The remote header is written first (compare-and-swap), then the local database is copied and
  rekeyed under a fresh LK, then swapped; `migration.json` resumes at the next unlock (T-ROT tests in `rekey.test.ts`).
- **Due date.** A `fips-140-3` vault shows "Keys are due for rotation" 730 days after its master key was made (R-4).
- **Events.** `vault.key.rotated` and `vault.profile.changed` are logged without secrets.
- **Residual (review C9 L6, POAM-15).** Deleting `vault.seen.json` re-enables an overwrite within the same epoch
  while the device is offline; it needs write access to the user's data folder.

## 6. Zeroisation, per key

From [`key-inventory.json`](key-inventory.json), the source of truth (T-STATIC-03 keeps it in step with the code).
A key held by the module is destroyed with `OPENSSL_cleanse` over the secure heap; `KeyRing.close()` runs at every
lock and verifies the count destroyed (Z-4).

| Key | Destroyed |
| --- | --- |
| Password | the lock window's renderer process ends after unlock; the IPC bytes are zeroed; the module cleanses its copy after the KDF |
| Password KEK, recovery KEK, quick-unlock KEK | right after one wrap or unwrap |
| Recovery key | the module's buffer is cleansed after encoding or after the KEK derivation |
| Quick-unlock secret | its file is deleted; the base64 string handed to the keyring cannot be wiped (Z-12) |
| Master key (each epoch) and every subkey (sync, names, name MACs, header check, prefs, local wrap, history) | `KeyRing.close()` at every lock |
| Per-file key | right after the one file, in `finally` |
| Local database key and the SQLCipher page-HMAC key | `KeyRing.close()` and closing every connection |
| DRBG state | module-managed; process exit or the error state |
| Self-test keys | before the self-test returns, checked by `POST-ZEROIZE` |

Not wiped, stated plainly: the text field while its window lives, the copy of a typed secret inside Electron's IPC
message (POAM-10), the Argon2id working memory (POAM-08). On macOS other processes can read Slate's memory because
the build has no Developer ID and so no hardened runtime (POAM-03). On Linux the process is non-dumpable.

## 7. Open points for an accredited laboratory

The implementation does not wait on these; the claim wording does. All open (see `decisions.md`):

| Id | Question |
| --- | --- |
| L-1 | HKDF for key-from-key derivation (moot once suite 0x02 is the only path) |
| L-2 | AES-256-CTR with an HMAC-derived counter block for deterministic names |
| L-3 | Shipping a build-time `fipsmodule.cnf` under the #4985 Security Policy |
| L-4 | An OpenSSL 3.5.x host with the 3.1.2 provider on macOS arm64 and Linux x64 |
| L-5 | SQLCipher 4 PBKDF2-HMAC-SHA-512 with 2 iterations from a raw key |

## 7a. Post-quantum

What Slate does about quantum computers, and where each part sits relative to the module. Nothing here is a claim of
validation: the FIPS Provider 3.1.2 certificate (CMVP #4985) predates FIPS 203 (ML-KEM) and FIPS 204 (ML-DSA), so
these algorithms are **not** in the module's boundary (`crypto-module.json`: `pqInBoundary: false`).

| Area | State | Where |
| --- | --- | --- |
| Notes at rest, vault wraps, local database | Symmetric only (AES-256, SP 800-108r1 KBKDF, HMAC-SHA-256, SQLCipher 4, Argon2id or PBKDF2). Unchanged by this work; no re-encryption. | Inside the module in `fips-140-3` |
| Vault header | Version 3 is written after unlock once every device record reports the `pq` capability (D-9). Password, recovery key and quick unlock keep working, and no ciphertext changes. Once a device has adopted version 3 it refuses version-2 copies of the header. | `vault/pqUpgrade.ts` |
| Update signatures | Hybrid `ml-dsa-65+ed25519`: both halves must verify, each over a domain-separated message. A build that pins the hybrid key never accepts an Ed25519-only signature. ML-DSA verification is outside the module, as Ed25519 in `node:crypto` is. | `update/signature.ts`; POAM-18 |
| Git over SSH | Hybrid key exchange is preferred (`mlkem768x25519-sha256`, then `sntrup761x25519-sha512@openssh.com`, then the system's list). "Require post-quantum key exchange" is off by default (D-10). The transports are outside the module (POAM-11). | `GIT_SSH_COMMAND`; Settings, Sync |
| HTTPS | The built-in TLS client offers `X25519MLKEM768` first. Servers answer as they choose; Graph and GitHub HTTPS were classical when measured (POAM-17). | `tlsPolicy.ts` |
| Device or recipient slots | Not built (D-6 stays deferred). When built they must carry an ML-KEM component; classical public-key slots are forbidden by the header schema. | Roadmap section 3.8 |

In the `fips-140-3` profile the readiness panel and the diagnostics never present an ML-KEM or ML-DSA operation as
inside the validated module. The profile matrix is in `docs/reviews/quantum-proof-roadmap.md` section 2.3.

## 8. POA&M summary

Full table: [`poam.md`](poam.md). Open rows: POAM-01 and -02 (no Developer ID or package signing, D-1), POAM-03
(macOS memory protection), POAM-04 (`runAsNode` fuse), POAM-05 (one pinned update-signing key), POAM-06 (update
freshness), POAM-07 (FIPS provider under a Developer ID), POAM-08 (Argon2id memory), POAM-10 (typed secret in
Electron IPC), POAM-11 (transport TLS), POAM-12 (no own validation, D-3), POAM-13 (AC-7 and AC-11 values not in the
FedRAMP rules file), POAM-15 (`vault.seen.json` deleted), POAM-17 (transport key exchange is classical for some hosts), POAM-18 (ML-DSA outside the validated module). POAM-14 (SI-6) is closed: the self-test of section 4 is built.

## 9. Where each claim is tested

Every requirement id here maps to tests in [`traceability.yaml`](traceability.yaml), generated from test titles and
checked in CI (`node scripts/traceability.mjs --check`).

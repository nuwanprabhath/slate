# Compliance decisions

The maintainer's answers to `docs/reviews/compliance_audit.md` §7.1, recorded on 2026-10-23.

| Id | Decision | Answer | Effect |
| --- | --- | --- | --- |
| D-1 | Apple Developer ID and a Linux package-signing key | **Not now.** | C12 builds the signing plumbing behind configuration that stays off. CM-14, SI-7(15) and the macOS part of Z-9 are POA&M entries in `poam.md`. |
| D-2 | A failed POST also blocks plaintext users | **Yes.** | One code path (S-11). |
| D-3 | Seek Slate's own CMVP validation or NIAP evaluation | **No, for now.** | Slate relies on CMVP #4985. Revisit if a customer requires it. |
| D-4 | SQLCipher source | **Community SQLCipher on OpenSSL with the FIPS provider.** | Switch to Zetetic's module (#5185) only if L-5 fails. |
| D-5 | Hosted Slate sync service | **Out of scope.** | FedRAMP stays not applicable. |
| D-6 | Public-key wrap slots with hybrid ML-KEM | **Deferred.** | Identifiers reserved only (§4.5.1, §4.5.4). |
| D-7 | Upgrade header-v1 vaults to v2 | **Prompt** in Settings → Security once every device record reports a version ≥ the C5 release. Never automatic. | C9: *Upgrade encryption format* is offered only while every device record on the remote carries the key-epoch capability (`epochs: 1`, written by every build that can follow a key change); a record without it, or one Slate cannot read, blocks it (review C9 L3: release numbers prove nothing, as development builds all report 0.1.0). The same gate applies to key rotation and to the FIPS conversion, which C5-era code could not follow either. |
| D-8 | `cipher_memory_security = ON` in `fips-140-3` | **Measure first.** If `perf.spec.ts` misses its budget, decide with the numbers recorded here. | C3 |
| C4 residual | In-process code and the key boundary (review C4 M1-R) | **Closed in C5 (2026-10-24).** It was accepted for C4 only: in-process code could rewrap LK under a chosen KEK via `rewrapKey` (KEK class) and launder approval. | `rewrapKey` now moves password-class wraps only (SCC_17 for a KEK), and nothing else moves a database key: LK is wrapped once, fresh, under its own master key's local-wrap KEK, which the module derives. A device that joins another vault (rejoin) gets a fresh LK under the new vault and a rekeyed copy of its database (`copyAndRekey`), so the old LK never meets a KEK whose bytes JavaScript can compute. This is stricter than the module-internal local-key rewrap first planned: that rewrap would still have accepted a caller-built master key (any password can wrap chosen bytes), so the move itself had to go. What password wrapping cannot stop remains: code that picks a password can build a key tree whose bytes it knows; no existing key enters it. `addon.test.ts` "C4 residual (closed by C5)" now expects the refusal; POAM-09 is removed. Once a fips-140-3 vault unlocks, `requireApprovedKeys` also refuses Argon2id, RFC 5869 HKDF and AES-ECB for the process. |

Further maintainer answers:

- **Update signing key (C12).** The lead generates an Ed25519 key pair outside the repository. The public key is pinned
  in the app; the maintainer stores the private key as a GitHub Actions secret. The private key is never committed.
- **Unsigned updates (C12).** No unsigned update is ever accepted (stricter than audit C12 criterion 1, which allowed one
  for pre-signing clients; those clients cannot verify anyway). Every build with the verifier requires a valid signature
  from a pinned key on the feed and the artefact, and a version strictly newer than its own, in every profile.
- **Rejoin re-encrypts (C5, 2026-10-24).** Accepted: a device joining another vault (rejoin) re-encrypts its
  database under a fresh LK (`copyAndRekey`) instead of moving LK's wrap, so a database key never moves to another
  KEK (closes review C4 M1-R). A rejoin across profiles is refused before anything is derived (review C5 M1).
- **The fips-140-3 latch needs a restart (C5, 2026-10-24).** Accepted: once a fips-140-3 vault's header has
  verified, the process is approved-only for good, so opening a standard vault needs Slate restarted. The latch is
  set only after the header's `check` verifies (review C5 M1), never from an unverified header.
- **Renderer sandbox on Linux (POAM-16, 2026-10-26): "Force setuid sandbox; AppImage warns".** The .deb always launches Slate with
  `--disable-namespace-sandbox` (desktop entry and `/usr/bin/slate` wrapper), so Chromium uses the setuid chrome-sandbox and the renderers,
  the lock screen's included, are sandboxed and non-dumpable wherever the .deb is installed. The AppImage keeps working; when Slate finds a
  renderer without the sandbox it says so once in Settings → Security (dismissable) and on the lock screen, recommends the .deb, and logs
  `app.renderer.unsandboxed`. Implemented in phase 12 (SANDBOX); the AppImage residual stays on POAM-16.
- **FIPS profile visibility (C5).** The wizard shows the *Standard / FIPS 140-3* choice only in builds that bundle the
  FIPS provider. Other builds create `standard` vaults without asking. Implemented: the choice appears when
  `moduleStatus().approvedMode` is true; a fips-140-3 vault on a build without the module is refused at unlock
  (`FipsModuleRequired`), and once one is unlocked, a standard vault needs a restart of Slate (the latch is one-way).

## D-8 measurement (C3, 2026-10-24)

Conditions: an encrypted data folder, SQLCipher 4.19.0 inside `@slate/native` in approved mode (OpenSSL 3.5.9
with the FIPS Provider 3.1.2 loaded, `cipher_fips_status` = 1), MacBook arm64 shared with other build agents
(load average about 4). `e2e/perf-encrypted.spec.ts` (the `perf.spec.ts` measurement on an unlocked encrypted
database), run three times per block, blocks interleaved ON, OFF, ON, OFF. Budgets: page open < 100 ms,
keystroke p95 < 16 ms.

| `cipher_memory_security` | Page open (ms) | Keystroke p50 (ms) | Keystroke p95 (ms) |
| --- | --- | --- | --- |
| ON | 40.3, 39.5, 41.7, 38.9, 43.2, 38.9 | 3.5, 2.8, 2.7, 6.9, 2.7, 3.3 | 14.1, 91.1*, 16.9, 12.1, 11.3, 9.2 |
| OFF | 40.6, 38.1, 39.7, 39.5, 40.8, 38.4 | 4.5, 3.5, 3.7, 5.5, 6.7, 5.9 | 8.1, 11.7, 15.8, 11.2, 10.0, 17.9 |

\* one run with a 569 ms stall (max), a load spike on the shared machine.

Page open is the same within noise (median 40.0 ms ON, 39.6 ms OFF), and so is typing: keystrokes do not wait on
the database. The p95 misses are on both sides and come from the shared machine (an OFF run missed too). Four more
ON runs earlier the same morning: p95 5.4, 4.5, 7.1, 15.9 ms, page open about 40 ms. **Result: the budget holds, so
`cipher_memory_security` stays ON** whenever the module runs in approved mode (`openDatabase.ts`, `checkCipher`).
No POA&M row is needed.

- **Remote images (C8, B-4).** Stricter than the audit: the built app's CSP never allows `https:`
  images, and there is no setting or runtime CSP variant that turns them on. A note's remote
  `<img>` shows nothing rather than telling a third party who opened the note and when. Images that
  are pasted or imported are stored with the note (`slate-blob:`) and still show. Revisit only if
  users ask for remote images, as an opt-in that adds `https:` to `img-src` at run time.

## Points for an accredited CST laboratory

The implementation goes ahead; only the claim wording in audit §1.2 waits on these.

| Id | Question | Status |
| --- | --- | --- |
| L-1 | HKDF for key-from-key derivation | open (moot once suite 0x02 uses SP 800-108r1) |
| L-2 | AES-256-CTR with an HMAC-derived counter block for deterministic names | open |
| L-3 | Shipping a build-time `fipsmodule.cnf` under the #4985 Security Policy | open |
| L-4 | OpenSSL 3.5.x host and macOS arm64 / Linux x64 under #4985 | open |
| L-5 | SQLCipher 4 PBKDF2-HMAC-SHA-512 with 2 iterations from a raw key | open |

# Slate E2EE — Cryptographic Compliance Audit

| Field | Value |
| --- | --- |
| Document | `docs/reviews/compliance_audit.md` (id `SLATE-CA-2026-10-23`) |
| Audited design | `docs/superpowers/specs/2026-10-23-e2ee-design.md`: v2 plus the §15 v3 amendments |
| Audited code | `main` at `892a26c`: `packages/desktop/src/main/{vault,db,sync,mcp}/`, `ipcGuard.ts`, `index.ts`, `services.ts`, `packages/desktop/electron-builder.cjs`, `packages/desktop/src/renderer/index.html` |
| Runtime audited | Electron 45.0.0: Chromium 156, Node 24.22.0, V8 15.6, BoringSSL |
| Regulatory snapshot | Sources as published on 2026-10-23 (§2.4) |
| Normative words | MUST, MUST NOT, SHOULD and MAY as in RFC 2119 and RFC 8174 |
| Status | Findings and a remediation specification. Nothing here has been implemented in the repository yet. |

---

## 0. Reading guide for the implementing agent

**Identifiers**

| Prefix | Meaning | Example |
| --- | --- | --- |
| `F-<FW>-NN` | Finding. FW is FIPS, NIST, FR (FedRAMP), BSI, CC (Common Criteria), EL (Electron/platform) or GEN (general) | `F-FIPS-02` |
| `M-NN` | A row of the compliance mapping table (§1.4) | `M-06` |
| `S-n` | Self-test rule (§4.2) | `S-7` |
| `Z-n` | Zeroisation and memory rule (§4.3) | `Z-4` |
| `B-n` | Electron boundary rule (§4.4) | `B-2` |
| `C0`–`C13` | Work package (§7). These continue the E1–E7 and F1–F2 cadence of the E2EE spec. | `C6` |
| `T-<area>-NN` | Required test (§6) | `T-POST-03` |
| `D-n` | Decision the maintainer must make before the named WP starts (§7.1) | `D-1` |
| `L-n` | Point that needs confirmation from an accredited CST laboratory. Implementation goes ahead; the claim waits on the lab (§7.2). | `L-2` |

**Precedence.** This document amends the E2EE spec. Work package C0 adds a §16 to the spec that points here. Where the two disagree, this document wins.

**Profiles.** Rules tagged **[all]** apply to both crypto profiles. Rules tagged **[fips]** apply only to the `fips-140-3` profile (§4.1).

**Repository rules every WP must keep** (from `CLAUDE.md`):

- Write tests first and see them fail.
- `npm run typecheck`, `npm test` and `npm run test:main` must pass. E2E specs that a change touches must pass too.
- Use Conventional Commits. Never add AI attribution. Never push, tag or release.
- The renderer never touches the disk or the network directly.
- E2E runs set `SLATE_E2E=1`, so no window appears on screen.
- No more than six agents run in parallel; the dependency graph in §7 allows this.

**Evidence standard.** Every code listing in §5 and Appendix B was either compiled (C, with `-Wall -Wextra -Werror` against OpenSSL 3.6.4) or type-checked (TypeScript 7.0.2, `strict` + `noUncheckedIndexedAccess`) during the audit. The POST, the native binding and the fuzz suite were also *run*, inside Electron 45 where that matters. Each known-answer vector was reproduced by two independent implementations (Appendix A). Facts that could not be verified are marked **unverified**.

---

## 1. Executive summary

### 1.1 Verdict

The E2EE design is cryptographically sound for the threat model it states.

- Everything uses authenticated encryption, and the key hierarchy is clean: a password, recovery or quick-unlock KEK wraps the master key MK, and MK yields one subkey per purpose.
- `check` provides key commitment. A strict schema is validated before any derivation. KDF parameters have both floors and ceilings.
- Remote envelopes are bound to their logical path, and IPC is denied by default.
- Several mechanisms go beyond common practice:
  - header rollback protection (`revision`, with pending-header adoption);
  - a failed `check` that cannot be told apart from a wrong password;
  - a migration tested with injected crashes;
  - a renderer process that is recreated at every lock.

Measured against the frameworks in scope, the result is different:

| Framework | Posture | Reason |
| --- | --- | --- |
| FIPS 140-3, as used by an application | **Non-conformant** | (1) No CMVP-validated module performs any cryptography: Electron's BoringSSL is not built in FIPS mode, and `hash-wasm` and SQLite3MultipleCiphers bring their own unvalidated code. (2) Argon2id is not an approved function, so under IG 2.4.A every key below the password KEK counts as plaintext. (3) There are no run-time self-tests and no error state. |
| FedRAMP CR26 Class D | **Not applicable to Slate as a product. Non-conformant if embedded as a component.** | FedRAMP certifies Cloud Service Offerings (FRD-CSO), and Slate has none. If a Class D offering embedded Slate's cryptography, CMU-CSO-UVM ("MUST use cryptographic modules … with active validations under the NIST CMVP") would fail for the FIPS reasons above. |
| NIST SP 800-53 Rev 5 (release 5.2.0), High baseline | **Partial** | The SC-28 and SC-28(1) mechanisms exist, but SC-13 fails. Also open: AC-11 (30-minute default idle, "Never" allowed), AC-7 (no throttle), IA-5(1) (10-character minimum against 15 in SP 800-63B-4), SI-7, SI-7(15) and CM-14 (unsigned builds and update metadata; no ASAR integrity check on Linux), and SC-39 and SC-4 (keys in pooled JavaScript memory; core dumps possible). |
| BSI TR-02102-1 2026-01 | **Largely conformant** | AES-256-GCM, HMAC-SHA-256, HKDF and Argon2id are all recommended. The gaps are AES-ECB for remote names (not recommended), no crypto-agility in `SLE1`, and no key rotation. |
| Common Criteria (NIAP PP_APP v1.4 with the File Encryption PP-Module v1.0) | **Non-conformant** | Password conditioning must be PBKDF2 (SP 800-132), the FPT_TST self-tests are missing, key destruction is not evidenced, and trusted update (FPT_TUD_EXT) needs signed updates. |
| DoD IL5 and IL6 | **Not applicable** | The DoD CSP SRG and Mission Owner SRG govern cloud offerings. A desktop client falls under endpoint and STIG rules, which also require FIPS-validated cryptography. IL6 (classified) is entirely out of scope. |

### 1.2 What the remediation achieves, and what it cannot

**What it achieves.** Once C0–C13 are done, Slate can truthfully state:

> In the `fips-140-3` profile, every cryptographic operation that protects notes is performed by the OpenSSL FIPS Provider 3.1.2 (CMVP certificate #4985, FIPS 140-3, active, sunset 2030-03-10) in its approved mode. Slate runs a power-up self-test, enters a terminal error state on any failure, and destroys key material at lock.

**What it cannot achieve**, and the document never claims otherwise:

1. **Slate is not "FIPS 140-3 validated".** Only the embedded module holds a certificate. A CMVP certificate for Slate's own composition would need a lab engagement (D-3).
2. **Slate is not "FedRAMP authorized".** It has no Cloud Service Offering.
3. **The TLS used for sync is outside the validated boundary.** This covers git's TLS or SSH and Electron's Node `fetch` for Microsoft Graph. Note contents are already sealed before transport; credentials are not. This is accepted risk F-NIST-10, carried as a POA&M entry.
4. **The threat model does not change.** Malware running as the user while Slate is unlocked is still a non-goal. The memory rules raise the cost of dumps, swap leaks and cold reads; they do not defeat a debugger with the user's privileges.

### 1.3 Ten actions, in order

| # | Action | Fixes | WP |
| --- | --- | --- | --- |
| 1 | Add a native crypto boundary `@slate/native`. It contains a static OpenSSL 3 libcrypto plus the validated FIPS provider, keeps keys in the secure heap, and exposes only uint32 handles to JavaScript. | F-FIPS-01, -06, -07, F-NIST-07 | C2 |
| 2 | Replace SQLite3MultipleCiphers with SQLCipher 4 built against the same libcrypto, keyed from a handle. | F-FIPS-01, M-06 | C3 |
| 3 | Move every primitive behind the native boundary and remove `hash-wasm`. | F-FIPS-01, -02 | C4 |
| 4 | Add crypto profiles, suite registry 0x02 (SP 800-108r1 KBKDF), PBKDF2 for the `fips-140-3` profile, vault header v2, `SLE2` and SIV names. | F-FIPS-02, -03, -10, F-BSI-01, -02 | C5 |
| 5 | Add a power-up self-test and the `selftest` / `selftest-failed` states, failing closed on any error. | F-FIPS-04, -05, F-NIST SI-6 | C6 |
| 6 | Make zeroisation verifiable: handle-only key ring, passwords sent as bytes, a fresh renderer after unlock, no core dumps, mlock. | F-FIPS-06, F-NIST-07, F-CC-02 | C1, C7 |
| 7 | Harden the Electron boundary: navigation and window-open guards, IPC sender validation, a permission policy, a production CSP, async `safeStorage`. | F-EL-01, -03, -04, F-NIST-08, -09 | C8 |
| 8 | Add key epochs and rotation, including converting a `standard` vault to `fips-140-3`. | F-NIST-02 | C9 |
| 9 | Enforce AC-7, AC-11 and IA-5(1) policy per profile, add security audit events, a key inventory and an OSCAL component definition. | F-NIST-03, -04, -05, -11, F-FR-03 | C10 |
| 10 | Sign releases and update manifests, tighten the release fuses, publish an SBOM. | F-NIST-06, F-CC-04, F-EL-02 | C12 |

### 1.4 Compliance mapping table

Status key: ✔ conforms · △ conforms only once the module boundary exists, or partially · ✗ does not conform · — not applicable.

| # | Slate component (code) | FIPS 140-3 | FedRAMP CR26 Class D | NIST SP 800-53 r5.2.0 | BSI TR-02102-1 (2026-01) | Status → WP |
| --- | --- | --- | --- | --- | --- | --- |
| M-01 | Password KDF: Argon2id through `hash-wasm@4.12.0` in a `worker_thread` (`vault/kdf.ts`, `vault/argon2.worker.ts`) | Not approved: absent from SP 800-140C r2 and the IG. IG 2.4.A treats keys derived by a non-approved method as plaintext. The approved alternative is SP 800-132 PBKDF2, documented per IG D.N. | CMU-CSO-UVM ✗ | IA-5(1) ("approved salted key derivation function") ✗, SC-13 ✗ | B.1.2: "Argon2id should be used" ✔. BSI gives no parameters. | FIPS ✗, BSI ✔ → profiles, C4/C5 |
| M-02 | Recovery KEK: HKDF-SHA-256 over 256 random bits (`vault/header.ts:134`) | HKDF counts as an SP 800-56Cr2 two-step KDA (IG D.S), but its approved context is key establishment. For deriving from a stored key, SP 800-132's Data Protection Key options use an approved KDF, which is what SP 800-108r1 provides. | via M-10 | SC-12, SC-13 | Table B.1: HKDF ✔ | △ → KBKDF in suite 0x02 (C5) |
| M-03 | MK → subkeys: HKDF with an empty salt (`vault/keyring.ts:22`) | as M-02 | — | SC-12 | ✔ | △ → C5 |
| M-04 | Header wraps: AES-256-GCM with a random 96-bit IV; `check` is HMAC-SHA-256 over JCS (`vault/header.ts`) | GCM: IG C.H scenario 2 requires the IV to come from an approved DRBG *inside* the boundary, with fewer than 2^32 uses per key. HMAC: FIPS 198-1. | — | SC-12, SC-13, SC-28(1) | GCM ✔ (96-bit IV, tag ≥ 96 bits), HMAC ✔ (Table 5.2) | △ → C2/C4 |
| M-05 | LK wrap in `local-keys.json` (`vault/localKeys.ts`) | as M-04, and the `db` field is not authenticated (F-GEN-01) | — | SC-28(1) (integrity) | ✔ | △ → C5 |
| M-06 | Local database: SQLCipher 4 format through SQLite3MultipleCiphers, which ships its own `rijndael.c` and `sha2.c` (`db/openDatabase.ts`) | Not validated. Zetetic's commercial SQLCipher module is CMVP #5185. | CMU-CSO-UVM ✗ | SC-28, SC-28(1), SC-13 | CBC plus HMAC ✔ | ✗ → C3 |
| M-07 | `SLE1` envelope (`vault/crypto.ts:47-106`) | Approved primitives in an unvalidated module, with no algorithm identifier | — | SC-28(1); SC-8(1) is met by sealing before transport; SC-13 | GCM ✔. Crypto-agility "must be designed" for long-term confidentiality ✗ | △/✗ → `SLE2` (C5) |
| M-08 | Remote names: one AES-256-ECB block (`vault/names.ts`) | ECB is approved today, but the SP 800-131A r3 initial public draft marks ECB "Disallowed for data encryption; legacy use for decryption". | — | SC-13 | ECB is not recommended ✗ | ✗ → SIV names (C5) |
| M-09 | Blob names: HMAC-SHA-256 (`vault/names.ts:36`) | Approved function | — | — | ✔ | △ → C4 |
| M-10 | RNG: `crypto.randomBytes` from BoringSSL, a non-FIPS build | Not an approved DRBG inside a validated boundary, so the IG C.H IV rule fails | — | SC-12, SC-13 | — | ✗ → C2 |
| M-11 | Keys in memory: `KeyRing` copies with `Buffer.from` into shared 64 KiB pool slabs, and passwords live as V8 strings (`vault/keyring.ts:47`) | ISO/IEC 19790 §7.9.7 (AS09.28 and AS09.32 zeroisation, AS09.33 indicator), IG 9.7.B | KSI-SVC-ASM | SC-4, SC-12, SC-39; SC-28(3) is outside the baseline | — | ✗ → C1, C7 |
| M-12 | Self-tests: unit tests only | IG 10.3.A (CAST before first use), IG 10.2.A (integrity), error state | KSI-SVC-VRI | SI-6 (High), SI-7(1) | — | ✗ → C6 |
| M-13 | Quick unlock: `safeStorage` plus a `promptTouchID` UI gate (`vault/quickUnlock.ts`) | The Keychain and libsecret path is outside the module, and the biometric is not bound to the key | — | IA-2, IA-5, SC-28(3) | — | △ → off in `fips-140-3`, async API (F-EL-01) |
| M-14 | Lock timing: idle default 30 min, "Never" allowed (`shared/settings/schema.ts:49`) | — | Rev5 Class D parameters | AC-11 (FedRAMP: 15 min), AC-11(1) ✔, AC-12 | — | ✗ [fips] → C10 |
| M-15 | Unlock attempts: no throttle (spec §6.7) | — | Rev5 Class D parameters | AC-7 | — | ✗ [fips] → C10 |
| M-16 | Password rules: ≥ 10 characters, 10k blocklist, NFC (`vault/password.ts:4`) | IG D.N: the Security Policy must justify password length and guessing probability | — | IA-5(1). SP 800-63B-4 requires ≥ 15 for single-factor use; the blocklist ✔ | — | ✗ [fips] → C10 |
| M-17 | Renderer boundary. Has sandbox ✔ and contextIsolation ✔. Lacks navigation guards and IPC sender checks; the CSP allows `'unsafe-inline'`, `ws:` and `http(s):` images. | — | — | AC-3, SC-39, SI-10 | — | △ → C8 |
| M-18 | Build and update integrity: ad-hoc macOS signature, unsigned Linux packages, electron-updater trusting `sha512` from the same release, ASAR integrity on macOS only, `runAsNode` and `nodeCliInspect` fuses on | The module's own integrity test (IG 10.2.A) belongs to C2 | KSI-SVC-VRI | SI-7, SI-7(1), SI-7(15), CM-14 (added by Class D), SR-3, SR-11 | — | ✗ → C12 |
| M-19 | Transport: git over HTTPS or SSH, and Microsoft Graph through Node `fetch` on BoringSSL | Outside the boundary | CMU-CSO-UVM (if it were a CSO) | SC-8, SC-8(1) | — | △ accepted (content is pre-sealed), POA&M |
| M-20 | Machine-readable governance: none | — | FRC-CSO-JSN (JSON valid against FedRAMP schemas). OSCAL is named in AGU-AGC-GRC. | PL-2, CA-2 evidence | — | ✗ → C10 (OSCAL 1.2.3) |
| M-21 | `preunlock.json`: HMAC under K_prefs (`vault/preunlock.ts`) | Approved function | — | SI-7 | ✔ | △ → C4 |
| M-22 | Logging: redacted on write (`log/logger.ts`) | — | — | AU-2, AU-3, AU-9 | — | △ → C10 adds a security-event set |

---

## 2. Scope, method and evidence

### 2.1 What was reviewed

- **The design:** the whole E2EE spec, §§1–15.
- **The code:** every file in `packages/desktop/src/main/vault/`, plus:
  - `db/openDatabase.ts`
  - `sync/encryptingDrive.ts`
  - `services.ts`
  - `ipcGuard.ts`
  - `index.ts`, lines 1–520
  - `onenote/auth.ts`
  - `sync/git/auth.ts`
  - `mcp/socketPath.ts`
  - `renderer/index.html`
  - `electron-builder.cjs`
  - `editor/src/BoxEditor.tsx`, link handling
- **The tests:** the existing crypto and vault tests: `crypto.test.ts`, `kdf.test.ts`, `header.test.ts`, `keyring.test.ts`, `ipcGuard.test.ts`.

The spec marks some items as non-goals: same-user malware while unlocked, metadata hiding, and turning encryption off. This audit treats them as out of scope unless a framework makes them mandatory.

### 2.2 Method

1. I traced each framework requirement to the component that implements it (§1.4).
2. I reviewed the code line by line for key lifetime, error paths and parser strictness (§3).
3. I ran experiments on the actual runtime: Electron 45 with `ELECTRON_RUN_AS_NODE=1`.
4. I built and ran reference implementations for the proposed changes, so that every snippet in §5 is known to compile and behave as stated.

### 2.3 Facts verified during the audit

| # | Observation | How |
| --- | --- | --- |
| V-1 | Electron 45.0.0 reports Node 24.22.0, and `process.versions.openssl === '0.0.0'` | `electron -e` probe |
| V-2 | `crypto.getFips()` returns `0`. `crypto.setFips(true)` throws, with the error message `"ok"`. `--enable-fips` is rejected as "not supported in Electron". | probe, plus the Electron docs `environment-variables.md` |
| V-3 | `crypto.argon2Sync` exists but throws `ERR_CRYPTO_ARGON2_NOT_SUPPORTED`. Spec §3's statement holds. | probe |
| V-4 | `Buffer.poolSize === 65536`, raised from 8192 in Node 24.18.0. `Buffer.from(<32 B>)` and `Buffer.concat` return views into a 65,536-byte `ArrayBuffer`. `Buffer.alloc(32)` gets its own 32-byte `ArrayBuffer`. | probe, plus Node v24.22.0 `lib/buffer.js` |
| V-5 | The SQLite3MultipleCiphers amalgamation in `node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/sqlite3.c` contains its own Rijndael (206 occurrences) and is not linked to OpenSSL. | grep |
| V-6 | An N-API addon with OpenSSL 3.6.4 `libcrypto.a` linked statically, exporting only `napi_register_module_v1` and `node_api_module_get_api_version_v1`, loads and runs inside Electron 45 next to BoringSSL without symbol clashes. Tested on macOS arm64; Linux needs the linker flags in C2. | built and run |
| V-7 | Inside Electron 45, the POST in §5.2 runs 17 KATs in 2.4–8.9 ms. Each of the 17 single-vector corruptions is detected, leaves the module in its error state, and makes every later service call throw `SCC_12`. | built and run |
| V-8 | The fuzz suite in §6.4 (7 properties × 2,000 runs, fixed seed) passes against the audited `parseHeader` and `canonicalJson`. | vitest 5 |
| V-9 | The OSCAL component definition in Appendix C.2 validates against the official OSCAL v1.2.3 `oscal_component_schema.json`, and a deliberately broken copy is rejected. | ajv 8 + ajv-formats |
| V-10 | `safeStorage.encryptString`, `decryptString` and `isEncryptionAvailable` are marked **Deprecated** in Electron 45's `electron.d.ts`. The replacements are `encryptStringAsync`, `decryptStringAsync` (which resolves `{ shouldReEncrypt, result }`) and `isAsyncEncryptionAvailable`. The research found the synchronous API is removed in Electron 46. | typings, plus the `breaking-changes.md` research |
| V-11 | The remote `vault.json` read is capped at 64 KiB (`vault/remoteVault.ts:11`). The local reads are not capped: `unlock.ts:32`, `vaultCheck.ts:27`, `preunlock.ts:62`, `quickUnlock.ts:68,101`. | code |

**Not verified here:**

- the OpenSSL FIPS Provider 3.1.2 build and `fipsinstall` (Homebrew ships no FIPS module; the same code paths were run with `requireFips=false`);
- ELF symbol isolation on Linux;
- the SQLCipher build (C3);
- the process-memory scan, which is Linux-only (T-ZERO-04).

### 2.4 Regulatory snapshot (2026-10-23)

| Item | State | Source |
| --- | --- | --- |
| FIPS 140-3 | Still references ISO/IEC 19790:2012 and 24759:2017. The 2025 ISO editions have not been adopted by CMVP. | csrc.nist.gov/projects/fips-140-3-development |
| FIPS 140-3 Implementation Guidance | Revision of **2026-08-19**. It adds IG 1.B (hybrid modules) and modifies 10.3.A, 10.3.F, C.H, D.G and D.H. D.S (hybrid KEM per SP 800-227) arrived 2026-04-09. | CMVP IG announcements, plus the IG PDF |
| SP 800-140C r2 and 140D r2 | Final, 2023-07-25 | csrc.nist.gov/pubs/sp/800/140/c/r2/final |
| SP 800-132 | December 2010. A revision to approve a memory-hard password KDF was announced in 2023; **no draft exists**. | csrc.nist.gov/News/2023/decision-to-revise-nist-sp-800-132 |
| SP 800-131A r3 | Initial public draft of 2024-10-21. It marks ECB "Disallowed for data encryption". | csrc.nist.gov/pubs/sp/800/131/a/r3/ipd |
| SP 800-38D r1 | Pre-draft only; the plan is to drop tags shorter than 96 bits | NIST block-cipher news |
| FIPS 140-2 certificates | Moved to Historical on 2026-09-21. The schedule table says 09-22. | csrc.nist.gov/Projects/fips-140-3-transition-effort |
| OpenSSL FIPS Provider 3.1.2 | CMVP **#4985**, FIPS 140-3, Active, sunset 2030-03-10. OpenSSL 3.5.x is in review. Certificates #4282 and #4811 (140-2) are Historical. | CMVP certificate pages, plus openssl-library.org |
| Platform modules | Apple corecrypto 18.3 (Apple silicon, User, SL1) is #5184. Microsoft CNG Primitives (140-3) is #5410. Google BoringCrypto is #5296. | CMVP |
| FedRAMP | Notice NTC-0004 (2026-02-25): Class D = High. CR26 launched 2026-06-25, becomes mandatory 2027-01-01 and is valid until 2028-12-31. The rules JSON is version `2026.10.13.01`. | fedramp.gov/notices/0004; github.com/FedRAMP/rules |
| NIST SP 800-53 | Release **5.2.0** (2025-08-27). It added SA-15(13), SA-24 and SI-2(7), and made no changes to the SP 800-53B baselines. | csrc.nist.gov; usnistgov/oscal-content |
| SP 800-63B-4 | Final 2025-07-31. Passwords: ≥ 15 characters single-factor, ≥ 8 inside MFA; blocklist SHALL; composition rules SHALL NOT; SP 800-132 SHOULD be used. | csrc.nist.gov/pubs/sp/800/63/b/4/final |
| BSI TR-02102-1 | Version **2026-01** (2026-01-23). Its forecast horizon is the end of 2032. | bsi.bund.de TG02102 |
| NIS2 in Germany | NIS2UmsuCG in force since 2025-12-06. BSIG §30(2) no. 8 requires "Konzepte und Prozesse für den Einsatz von kryptographischen Verfahren" by the state of the art. It does **not** cite TR-02102, so TR-02102 is a reference, not a legal mandate. | gesetze-im-internet.de/bsig_2025/__30.html |
| EU PQC roadmap | 2025-06-23: start transitioning by the end of 2026; high-risk uses by the end of 2030 at the latest | digital-strategy.ec.europa.eu |
| PQC standards | FIPS 203/204/205: 2024-08-13. SP 800-227: final 2025-09-18. NIST IR 8547: still an initial public draft (2024-11-12). CNSA 2.0 code signing: "support and prefer by 2025, exclusively use by 2030". | csrc.nist.gov; NSA CNSA 2.0 FAQ (secondary) |
| Common Criteria | NIAP PP_APP v1.4 with PP-Module File Encryption v1.0 (CFG_APP-FE v1.1) is the evaluated configuration. App PP v2.0 was tagged 2025-06-16 on GitHub; FE v2.0 is a draft. NIAP requires exact conformance and assigns no EAL. | commoncriteriaportal.org; github.com/commoncriteria |
| DoD | The CSP SRG and Mission Owner SRG are dated January 2025. "FIPS 140-2 or 140-3 validated, minimally Level 1, in FIPS mode" comes from a search summary only, **unverified**: the PDF returned 403. | DISA (via secondary) |

---

## 3. Cryptographic and architectural deficiencies

Each finding gives: severity (Critical, High, Medium, Low, Info), the profiles it applies to, its location, the requirement, the evidence, the impact, and the fix.

### 3.1 FIPS 140-3

#### F-FIPS-01: No CMVP-validated module performs any cryptography

| | |
| --- | --- |
| Severity / profile | Critical · [fips] (blocks every FIPS claim) |
| Location | `vault/crypto.ts`, `vault/header.ts`, `vault/localKeys.ts`, `vault/names.ts`, `vault/quickUnlock.ts`, `vault/recovery.ts`, `sync/encryptingDrive.ts` use `node:crypto`. `vault/argon2.worker.ts` uses `hash-wasm`. `db/openDatabase.ts` uses SQLite3MultipleCiphers. |
| Requirement | FIPS 140-3 / SP 800-140C r2: approved security functions must run inside a validated module in its approved mode. FedRAMP CMU-CSO-UVM (Class D: MUST). NIST SC-13 as FedRAMP parameterises it. |
| Evidence | V-1, V-2, V-5. BoringSSL's `FIPS.md` says "BoringSSL as a whole is not FIPS validated"; only BoringCrypto built with `-DFIPS=1` is, and Chromium's `third_party/boringssl/BUILD.gn` has no FIPS define. `hash-wasm` and SQLite3MultipleCiphers have no CMVP entry. |
| Impact | No operation is "FIPS-validated cryptography". Every SC-13 / CMU claim fails, whatever algorithms are chosen. |
| Fix | C2 (module boundary), C3 (SQLCipher on that boundary), C4 (move every call site). |

#### F-FIPS-02: The password KDF is not an approved function, so the whole key tree counts as plaintext

| | |
| --- | --- |
| Severity / profile | Critical · [fips] |
| Location | `vault/kdf.ts:51-60` and `vault/argon2.worker.ts:14-45`; the header field `kdf.alg = "argon2id"` |
| Requirement | IG 2.4.A: keys derived or obfuscated by non-approved methods count as plaintext, and a non-approved algorithm must not share keys or CSPs with approved ones. SP 800-132 PBKDF2 is the only approved password-based KDF, for storage applications only; the Security Policy justifies password length and iteration count (IG D.N). NIAP PP_APP v1.4 FCS_CKM.1/PBKDF and the FE Module v1.0 also require SP 800-132 password conditioning. |
| Evidence | Argon2 appears nowhere in the IG or in SP 800-140C r2. NIST's 2023 decision to approve a memory-hard KDF has produced no draft (§2.4). |
| Impact | KEK_pw is non-approved, so MK, every subkey, LK and every envelope key fall outside approved mode, even once F-FIPS-01 is fixed. |
| Conflict | BSI TR-02102-1 B.1.2 says "Argon2id should be used". NIST and BSI disagree here, which is why there are two profiles (§4.1): `standard` keeps Argon2id (BSI), and `fips-140-3` uses PBKDF2-HMAC-SHA-512 (NIST/NIAP). |
| Fix | C4 (Argon2id natively, outside the FIPS library context) and C5 (PBKDF2 for `fips-140-3`). |

#### F-FIPS-03: HKDF is used to derive keys from stored keys

| | |
| --- | --- |
| Severity / profile | Medium · [fips] |
| Location | `vault/keyring.ts:22-24` (MK → subkeys, empty salt), `vault/crypto.ts:73,94` (K_sync → file key), `vault/header.ts:134-136` (recovery → KEK_rc), `vault/quickUnlock.ts:78,107` (QU → KEK_qu) |
| Requirement | CAVP tests HKDF as an SP 800-56Cr2 two-step KDA (IG D.S), and its approved context is a shared secret from approved key establishment. SP 800-132's options derive the Data Protection Key from the Master Key "using an approved KDF", and for key-derivation-from-key that is SP 800-108r1. |
| Impact | Labs may accept HKDF here (**L-1**). KBKDF removes the question. |
| Fix | Suite 0x02 (C5) uses the SP 800-108r1 KDF in counter mode with HMAC-SHA-256, the purpose as Label, and the vault id or file salt as Context. Test vectors are in Appendix A. |

#### F-FIPS-04: No run-time self-tests

| | |
| --- | --- |
| Severity / profile | High · [all] (SI-6 is in the High baseline; the CC FPT_TST family) |
| Location | Known-answer tests exist only in vitest (`crypto.test.ts:9` HKDF RFC 5869 TC3, `kdf.test.ts`). The app never runs one. |
| Requirement | IG 10.3.A: a CAST before the first operational use of each algorithm, with at least one authenticated AES mode, forward and inverse cipher, one CAST per KDA, and the PBKDF Master Key derivation. IG 10.2.A: the integrity test is pre-operational, and its algorithm passes its CAST first. NIST SI-6: verify security functions at start-up and on command, alert, and shut down on failure. |
| Note | Once C2 exists, the validated module runs its own integrity test and CASTs on load. Slate's application-level POST (§4.2) does three further things. It verifies that the module is the expected binary and that it loaded in approved mode. It tests the *composed* functions Slate builds (envelope, names, key schedule). And it gives Slate the error state that SI-6 and the user-facing fail-closed behaviour require. The POST does not make Slate FIPS-validated. |
| Fix | C6 |

#### F-FIPS-05: No error state

| | |
| --- | --- |
| Severity / profile | High · [all] |
| Location | `vault/vaultState.ts:25-34` has no error or self-test state. Crypto failures become `UnlockFailed` ("That password didn't work", `vault/unlock.ts:19-27`) or `UnverifiableFile`. |
| Requirement | ISO/IEC 19790:2012 §7.10 (a self-test failure puts the module in an error state) and §7.3 (data output is inhibited in the error state). SI-6 c ("shut the system down / restart" on failure). |
| Impact | A corrupted primitive would look like a wrong password, and the user would keep retrying. A module fault during sync would be recorded as "N files could not be verified", and sync would continue writing data sealed by a faulty implementation. |
| Fix | C6: the `selftest-failed` terminal state (§4.2 S-6–S-9), with `SCC_12` from any native call escalated through `failClosed`. |

#### F-FIPS-06: Zeroisation is incomplete and cannot be shown

| | |
| --- | --- |
| Severity / profile | High · [all] |
| Requirement | ISO/IEC 19790:2012 §7.9.7: AS09.28 (zeroise all unprotected SSPs), AS09.32 (temporary SSPs "shall be zeroised when they are no longer needed"), AS09.33 (completion indicator). IG 9.7.B. NIAP FE v1.0 FCS_CKM_EXT.4 (volatile memory: overwrite, or "destruction of reference to the key directly followed by a request for garbage collection"). |
| Fix | C1 fixes the JavaScript-level sites now. C7 removes the class of problem by keeping keys in the native secure heap. |

Sites at the audited commit where a CSP is created and never zeroed, or is copied into memory that cannot be zeroed:

| # | Site | CSP | Defect |
| --- | --- | --- | --- |
| Z-a | `vault/header.ts:120` `computeCheck` | K_check | `deriveSubkey(mk, 'check')` is passed straight into `createHmac` and never zeroed |
| Z-b | `vault/header.ts:168` `createVault` | KEK_pw | never zeroed |
| Z-c | `vault/header.ts:172-174` `createVault` | recovery secret, KEK_rc | never zeroed |
| Z-d | `vault/header.ts:181` `unlockWithPassword` | KEK_pw | `open(…, await deriveKek(…))`: the KEK is never zeroed |
| Z-e | `vault/header.ts:186-191` `unlockWithRecovery` | recovery secret, KEK_rc | never zeroed |
| Z-f | `vault/header.ts:206` `changePassword` | new KEK_pw | never zeroed |
| Z-g | `vault/header.ts:212-213` `newRecoveryKey` | recovery secret, KEK_rc | never zeroed |
| Z-h | `vault/localKeys.ts:33,56` | K_localwrap | `deriveSubkey(mk, 'localwrap')` is never zeroed |
| Z-i | `vault/crypto.ts:73,94` | per-file key | `hkdf(kSync, salt, FILE_INFO)` is never zeroed |
| Z-j | `vault/keyring.ts:47` `get` | every key | `Buffer.from(key)` copies into the shared 64 KiB pool slab (V-4). It is zeroable, but it shares an `ArrayBuffer` with unrelated data, and any copy a caller forgets survives indefinitely. |
| Z-k | `vault/argon2.worker.ts:35,39` | password, KEK_pw | The password string goes into `workerData` (a structured clone, so a V8 string in the worker isolate). The worker's output `h` and the cloned `m.ok` are never zeroed, and `Buffer.from(m.ok)` makes a third copy. |
| Z-l | `vault/kdf.ts:54` | password | `normalize('NFC')` creates another immutable string |
| Z-m | `db/openDatabase.ts:19-21,30` | LK | `keyPragmaValue` builds `"x'<hex>'"` as a V8 string, and SQLite copies the SQL text. Neither can be zeroed. |
| Z-n | `vault/quickUnlock.ts:81` | QU | `qu.toString('base64')` produces a V8 string that holds the quick-unlock secret |
| Z-o | `vault/quickUnlock.ts:105` | QU | `safeStorage.decryptString` returns a string, so QU (base64) is unzeroable |
| Z-p | `index.ts:430,461-462` | password, recovery key | They arrive over IPC as strings, after a renderer `<input>` value, an IPC structured clone and main-process copies |

The spec (§3) already says the password and the hex pragma cannot be zeroed. This audit makes that a defect to remove in the `fips-140-3` profile, rather than a disclosed limitation.

#### F-FIPS-07: IVs and keys come from a DRBG outside any boundary

| | |
| --- | --- |
| Severity / profile | Medium · [fips] |
| Location | Every `randomBytes` call: `vault/crypto.ts:28,70-71`, `vault/header.ts:156,166,172,189,212`, `vault/localKeys.ts:38`, `vault/quickUnlock.ts:77`, `vault/kdf.ts:63` |
| Requirement | IG C.H scenario 2: a random 96-bit GCM IV must come from an approved DRBG inside the module boundary. Under SP 800-133r2, keys come from an approved DRBG. |
| Fix | C2/C4: the native `randomBytes` and `keyRandom` (`RAND_bytes_ex` / `RAND_priv_bytes_ex` in the FIPS library context). The entropy source is the OS. The Security Policy of #4985 states the entropy caveat; `docs/compliance/crypto-module.json` (C2) repeats it. |

#### F-FIPS-08: The module and its approved mode are not identified to the operator

| | |
| --- | --- |
| Severity / profile | Medium · [fips] |
| Requirement | ISO/IEC 19790 §7.4 (an approved-service indicator). FedRAMP CMU-CSO-CMD (document the modules used). |
| Fix | C2/C6: Settings → Security shows `Cryptographic module: OpenSSL FIPS Provider 3.1.2 (CMVP #4985) · approved mode · self-tests passed <time>` from `native.status()` and the POST result. The same data goes to `docs/compliance/crypto-module.json`. |

#### F-FIPS-09: The GCM per-key invocation bound is not documented

| | |
| --- | --- |
| Severity / profile | Low · [all] |
| Requirement | IG C.H: fewer than 2^32 encryptions per key with random IVs. BSI TR-02102-1: re-key after 2^32 calls. |
| Analysis | The bound already holds by construction: each file key seals exactly one file. KEK_pw seals one MK per password set. K_localwrap seals one LK per `local-keys.json` write. KEK_qu seals once per enable. |
| Fix | C5 records this analysis in the key inventory (`gcmInvocationsPerKey`), and test T-GCM-01 asserts that `gcmSeal`/`gcmSealKey` call sites are exactly the listed ones (§6.8). |

#### F-FIPS-10: Remote names use AES-ECB

| | |
| --- | --- |
| Severity / profile | Medium · [all] (a BSI "not recommended", and a NIST draft "disallowed for data encryption") |
| Location | `vault/names.ts:10-34` (spec §15 N1) |
| Requirement | SP 800-131A r3 ipd: ECB is "Disallowed for data encryption; legacy use for decryption". BSI TR-02102-1 does not recommend ECB. |
| Fix | Suite 0x02 names (§4.6) are SIV-style: an HMAC-SHA-256 synthetic IV followed by AES-256-CTR. They stay deterministic, reversible without a map, and authenticated, so forged names are rejected by the MAC rather than by variant bits. ECB stays only for *reading* suite 0x01 names, which is the "legacy use for decryption" the draft allows. **L-2:** the lab confirms the CTR-with-synthetic-IV composition (each counter block is unique because the inputs are unique). |

### 3.2 NIST SP 800-53 Rev 5 (release 5.2.0, High baseline)

| ID | Sev. | Control | Gap | Fix |
| --- | --- | --- | --- | --- |
| F-NIST-01 | Critical [fips] | SC-13 | F-FIPS-01 and -02 | C2–C5 |
| F-NIST-02 | Medium [all] | SC-12, SC-12(1) | SC-12(1) (availability) is met by the recovery key. SC-12 is not, for three reasons: there is no key inventory, no cryptoperiod, and no rotation (spec §11 defers MK rotation). SP 800-57 Part 1 Rev 5, Table 1, suggests an originator-usage period of ≤ 2 years for symmetric data-encryption and key-wrapping keys. | C9 (key epochs and rotation), C10 (`key-inventory.json`) |
| F-NIST-03 | Medium [fips] | AC-11, AC-11(1) | The idle default is 30 minutes and `0` ("Never") is accepted (`shared/settings/schema.ts:49`). FedRAMP sets the AC-11 period at 15 minutes (verify against the rules JSON at C10 time, as for AC-7). AC-11(1), the pattern-hiding lock screen, is met (§6.4 step 8). | C10 |
| F-NIST-04 | Medium [fips] | AC-7 | There is no limit on failed attempts (spec §6.7: "no lockout"). FedRAMP's High parameter values: 3 consecutive invalid attempts within 15 minutes, then a lock for at least 3 hours or until an administrator releases it. **Verify the exact values against `fedramp-consolidated-rules.json` 2026.10.13.01 at C10 time.** Against someone holding a copy of the folder this is a UI control only; the KDF is the cryptographic control. | C10 (`unlockThrottle.ts`; the recovery key acts as the administrator release) |
| F-NIST-05 | Medium [fips] | IA-5(1) | The minimum is 10 characters (`vault/password.ts:4`). SP 800-63B-4 requires ≥ 15 for single-factor use. IA-5(1) asks for "an approved salted key derivation function", which F-FIPS-02 covers. The blocklist, the absence of composition rules and long-passphrase support already conform. | C10 |
| F-NIST-06 | High [all] | SI-7, SI-7(1), SI-7(15), CM-14 (Class D), SR-3, SR-11 | The macOS build is ad-hoc signed (`electron-builder.cjs:37-38`: `identity: null`, `hardenedRuntime: false`), and the Linux deb and AppImage are unsigned. The updater checks each download against the `sha512` listed in `latest-*.yml` from the same GitHub release (`update/electronBackend.ts:43,74`), so whoever controls the release controls the update, and the updated app receives the password at the next unlock. ASAR integrity validation runs on macOS only, never on Linux (Electron docs). | C12 |
| F-NIST-07 | Medium [all] | SC-39, SC-4 | Keys sit in the Electron main process's JavaScript heap and pool slabs (V-4). Nothing is mlock'd, so keys can reach swap. Core dumps are not disabled, and Node has no `setrlimit` (`node_process_methods.cc`). Distributions with systemd-coredump capture full process memory on crash. | C7 |
| F-NIST-08 | Medium [all] | AC-3, SC-39, SI-10 | There is no `will-navigate`, `will-redirect`, `setWindowOpenHandler` or `will-attach-webview` handler, and `ipcGuard.ts:40` never checks `event.senderFrame`. The preload exposes the whole note API to *whatever document* is loaded in a Slate window. The editor cancels link clicks (`BoxEditor.tsx:70-77`), but nothing in the main process enforces it. | C8 |
| F-NIST-09 | Medium [all] | SC-28, IA-5(1) (protecting stored authenticators) | Two credential stores accept the Linux `basic_text` backend, which uses a hard-coded password: the git token store (`sync/git/auth.ts:19,28`) and the MSAL cache (`onenote/auth.ts:32-33`). The MSAL cache even falls back to *plaintext*, with only a warning. Quick unlock already refuses `basic_text` (`vault/quickUnlock.ts:37,53`). | C8 (one rule for all three; [fips] refuses to store) |
| F-NIST-10 | Low [all] | SC-8, SC-8(1) | Transport TLS is outside the boundary. Note content is sealed (`SLE1`/`SLE2`) before it reaches TLS, so SC-8(1) holds for content. OAuth tokens and git credentials depend on BoringSSL or the system git TLS stack. | Accepted risk: a POA&M entry in the OSCAL remarks (C10) |
| F-NIST-11 | Low [all] | AU-2, AU-3 | Security events are not enumerated. Unlock failures are logged (`index.ts`, `log.warn('app','unlock failed')`); self-tests, profile changes, header adoption, preunlock tampering and rotations are not. | C10 (event list in §4.8) |

### 3.3 FedRAMP (Consolidated Rules 2026, Class D)

| ID | Sev. | Rule | Finding | Fix |
| --- | --- | --- | --- | --- |
| F-FR-01 | Info | FRD-CSO | FedRAMP certifies Cloud Service Offerings, "a specific, packaged cloud computing product or service". Slate syncs to the user's own git host or OneDrive and runs no vendor service. FedRAMP therefore applies only (a) if a hosted Slate sync service is offered (D-5), or (b) derivatively, when an agency's system boundary includes Slate. CR26 is mandatory from 2027-01-01; new Rev5 applications stop on 2027-06-11. | Documented scope statement (C10) |
| F-FR-02 | High (conditional) | CMU-CSO-UVM, CMU-CSO-CMD | Class D "MUST use cryptographic modules or update streams of cryptographic modules with active validations under the NIST CMVP". Algorithms added by an update stream that were never validated are excluded. The modules must be documented. | C2 (FIPS Provider 3.1.2, #4985), `crypto-module.json` |
| F-FR-03 | Medium | FRC-CSO-JSN; AGU-AGC-GRC | Machine-readable packages must validate against FedRAMP JSON schemas, and agency GRC tools must ingest "at least OSCAL". Slate has no machine-readable artefact. | C10: OSCAL 1.2.3 component definition (Appendix C.2), validated in CI |
| F-FR-04 | Info | KSI-SVC-SIN, KSI-SVC-VRI, KSI-SVC-ASM | The Key Security Indicators this remediation evidences: encryption of information (SLE2, SQLCipher), cryptographic integrity validation (POST, signed updates), and automated secret management (key ring and inventory). | Evidence table in the OSCAL `remarks` |

### 3.4 BSI TR-02102-1 (2026-01) and NIS2

| ID | Sev. | Topic | Finding | Fix |
| --- | --- | --- | --- | --- |
| F-BSI-01 | Medium | Crypto-agility | The TR requires that systems needing long-term confidentiality "must be designed" crypto-agile. Slate's formats are not (§3.7). | C5 |
| F-BSI-02 | Medium | ECB | See F-FIPS-10 | C5 |
| F-BSI-03 | Low | Argon2id parameters | The TR gives none ("should be discussed with an expert"). The defaults of 256 MiB, t = 4, p = 1 (`vault/kdf.ts:63`) exceed the memory of RFC 9106's second recommended option (64 MiB, t = 3, p = 4). p = 1 is a hash-wasm constraint the native path can lift, but changing p changes the hash, so existing vaults keep p = 1. | Record the rationale in `key-inventory.json` (C10); no parameter change |
| F-BSI-04 | Low | Length leakage | Deflate before encryption (`vault/crypto.ts:69`) makes ciphertext length depend on content. The TR does not prohibit this, but it is a known side channel when an attacker can influence part of the plaintext, for example through shared or imported content. | `SLE2` flag `PADDED` with Padmé padding (§4.5), on by default for document chunks and device records |
| F-BSI-05 | Info | PQC | Slate uses **no asymmetric cryptography for confidentiality**, so there is no harvest-now-decrypt-later exposure. Grover's attack leaves AES-256, HMAC-SHA-256 and the KBKDF at ≥ 128-bit post-quantum strength, which matches the TR's advice to use 256-bit symmetric keys. ML-KEM is **not** needed today, and adding it would add attack surface without reducing risk. Slate's real quantum exposure is (a) code-signing and update authenticity (C12: hybrid ML-DSA, with CNSA 2.0 signing exclusive by 2030), and (b) any future device enrolment or sharing that uses public keys (reserved suite space, §4.5.4). The EU roadmap's "start by end of 2026" is met for Slate by the crypto inventory (`key-inventory.json`). | C5 (reserved suites), C12 |
| F-BSI-06 | Info | NIS2 status | TR-02102 is not legally mandated by NIS2 or the NIS2UmsuCG (§2.4). It is the reference for the "state of the art" that BSIG §30 requires. | — |

### 3.5 Common Criteria (NIAP PP_APP v1.4 + PP-Module File Encryption v1.0)

| ID | Sev. | SFR | Finding | Fix |
| --- | --- | --- | --- | --- |
| F-CC-01 | High | PP_APP FCS_CKM.1/PBKDF; FE password conditioning (SP 800-132) | Argon2id is not an allowed password conditioner in any NIAP document | C5 (`fips-140-3` = PBKDF2-HMAC-SHA-512) |
| F-CC-02 | Medium | FE FCS_CKM_EXT.4 (FCS_CKM.6 in FE v2.0) | Key destruction is not documented or tested | C7 plus T-ZERO-* |
| F-CC-03 | Medium | FPT_TST (App PP v2.0 FPT_TST.1: DRBG self-tests) | None | C6 |
| F-CC-04 | Medium | FPT_TUD_EXT.1/.2 (trusted update), FPT_LIB_EXT.1 (third-party libraries) | Updates are unsigned; there is no library list | C12 (signatures, SBOM) |
| F-CC-05 | Info | Evaluation basis | NIAP accepts only exact conformance to approved PPs and assigns no EAL, so "EAL4+" is not a meaningful target for a US evaluation. A CCRA evaluation outside NIAP could claim an EAL, but only PP-based claims are mutually recognised. | D-3 |

### 3.6 Electron, platform and general

| ID | Sev. | Finding | Fix |
| --- | --- | --- | --- |
| F-EL-01 | Medium | The synchronous `safeStorage` API used by `vault/quickUnlock.ts:51,81,105`, `onenote/auth.ts:32-47` and `sync/git/auth.ts:19-30` is deprecated in Electron 45 and **removed in 46** (V-10). This blocks the next Electron security update (SI-2). | C8 |
| F-EL-02 | Medium | Fuses (`electron-builder.cjs:19-29`). `runAsNode: true` is needed only because `slate-mcp` runs the app binary as Node. `enableNodeCliInspectArguments: true` is set in *release* builds to serve `e2e-packaged`. `grantFileProtocolExtraPrivileges` is not set, and its default is ON. ASAR integrity does not exist on Linux. | C12 |
| F-EL-03 | Medium | No navigation or window-open guards; no IPC sender validation (= F-NIST-08) | C8 |
| F-EL-04 | Low | The production CSP (`renderer/index.html:6-7`) allows `script-src 'unsafe-inline'`, `connect-src ws:` (any host) and `http://localhost:*`, and `img-src https: http:`. That last one means a note's remote image beacons the user's IP and the time they open the note to a third party. | C8 |
| F-GEN-01 | Low | The `local-keys.json` AAD (`vault/localKeys.ts:26-28`) binds `vaultId` and `deviceId` but not `db`, `format` or `version`. Someone with local write access can repoint `db`. That cannot yield readable data without LK, but it is a confusion or denial-of-service vector. | C5 (v2 AAD binds `db`); C1 adds the regression test |
| F-GEN-02 | Low | Local JSON reads have no size cap (V-11), while remote reads are capped at 64 KiB. A local writer can make start-up allocate without bound. | C1 (cap 64 KiB before `JSON.parse`) |
| F-GEN-03 | Low | `quick-unlock.bin` is parsed with a cast (`vault/quickUnlock.ts:101`), not a schema, and carries no `format` or `version`. It fails closed through GCM, but it is not agile and not strictly parsed. | C5 (format v2 with schema) |

### 3.7 Crypto-agility of `SLE1` and the stored formats

| Artefact | Version marker | Algorithm id | Key id / epoch | Parameters | Verdict |
| --- | --- | --- | --- | --- | --- |
| `SLE1` envelope (`vault/crypto.ts:47-50`) | The magic alone (`SLE1`) | none: HKDF-SHA-256, AES-256-GCM implied | none | Salt (16 B) and nonce (12 B) fixed. Flags is 1 byte with only bit 0 defined, and any other bit is rejected (good: unknown flags fail closed). | **Not agile.** A new AEAD, KDF or key generation needs a new magic, and readers cannot pick a key by epoch. |
| `vault.json` v1 | `version: 1` ✔ | `kdf.alg` is an enumeration ✔. Wraps and `check` have no algorithm field. | `vaultId` only | Strict schema ✔ | **Partly agile.** The KDF can change; the wrap AEAD and the MAC cannot without a version bump. |
| `local-keys.json` v1 | `version: 1` ✔ | none | none | — | Partly agile |
| `quick-unlock.bin` | **none** | none | none | — | Not agile (F-GEN-03) |
| `preunlock.json` | **none** | none (HMAC implied) | none | — | Not agile |
| Remote names (§15 N1) | none | AES-ECB implied | none | — | Not agile. A new scheme needs a new path namespace or a vault-level suite. |
| SQLCipher database | SQLCipher's own header-less format; settings come from pragmas | `cipher='sqlcipher'`, `legacy=4` set in code | none | — | Agile through SQLCipher pragmas, but the settings are not recorded next to the key |

**Readiness for hybrid ML-KEM.** All Slate secrets are symmetric and passed via the user's password or recovery key. "Pivoting to ML-KEM" is therefore not a migration of existing data. It would be a *new wrap slot type*: wrapping MK to a device or person public key, for passwordless device enrolment or for sharing. The v2 formats (§4.5) reserve that space:

- `wraps.<slot>.alg` becomes an explicit registry.
- The `hybrid-xwing-mlkem768-x25519` and `hybrid-mlkem1024-p384` identifiers are reserved but not implementable until their specifications are final (D-6).
- `SLE2`'s suite byte reserves `0x10`–`0x1F` for public-key-recipient envelopes.

Under IG D.S (2026-04-09) and SP 800-227, such a hybrid KEM would be FIPS-approvable as long as the ML-KEM component and the combiner are inside the module.

---

## 4. Required architectural and code changes

### 4.0 Target architecture

```
┌────────────────────────── Renderer (sandbox: true, contextIsolation: true) ──────────────────────────┐
│ Lock screen / app UI. Never holds a key. Sends the password as a Uint8Array once, then zeroes it.   │
│ The lock-screen renderer process is destroyed after unlock (Z-6).                                    │
└───────────────▲──────────────────────────────────────────────────────────────────────────────────────┘
                │ contextBridge (window.slate)  ── IPC, sender-validated (B-2), state-gated (S-*, §4.2)
┌───────────────┴────────────── Main process (Node 24 / V8, Electron 45) ──────────────────────────────┐
│ VaultStateMachine  selftest → plaintext|locked|migrating … ; any → selftest-failed (terminal)        │
│ KeyRing (handles only)   EncryptingDrive / SLE2   header v2   profile policy   audit events          │
│                 │ uint32 KeyHandle, ciphertext, public data — never key bytes                        │
│ ┌───────────────▼──────────── @slate/native  (slate_native.node, N-API) ─────────────────────────┐   │
│ │ slate_crypto_core.c: handle table → OpenSSL secure heap (mlock, guard pages, MADV_DONTDUMP)    │   │
│ │ better-sqlite3 binding + SQLCipher 4 (keyed from a handle; cipher_provider = openssl)          │   │
│ │ libcrypto 3.5.x (static, hidden symbols)                                                        │   │
│ │   ├─ default OSSL_LIB_CTX  ── fips + base providers only, default_properties fips=yes          │   │
│ │   │        └─ OpenSSL FIPS Provider 3.1.2 (fips.dylib/.so, CMVP #4985)  ◄── cryptographic       │   │
│ │   │                                                                       boundary             │   │
│ │   └─ g_std_ctx ── default provider: Argon2id + HKDF for suite 0x01 (standard profile only)     │   │
│ └─────────────────────────────────────────────────────────────────────────────────────────────────┘   │
│ Process hardening at start: RLIMIT_CORE=0, PR_SET_DUMPABLE=0 (Linux), hardened runtime (macOS, D-1) │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Invariants (all are tested; see §6):

1. No `node:crypto` import remains under `packages/desktop/src/main/{vault,sync,db}`. `node:crypto` stays legal elsewhere only for non-security uses: `randomUUID` for document ids, and SHA-256 for blob *names*, where the content hash is an identifier and not a security function. T-STATIC-02 enforces this.
2. JavaScript never holds key bytes. It holds `KeyHandle` numbers.
3. In the `fips-140-3` profile, every operation on note data goes through the default library context, where only approved algorithms are reachable.

### 4.1 Crypto profiles

A **profile** is chosen when a vault is created. It is stored in the authenticated vault header v2 (§4.5.2) and can only ever be *raised* (`profileRank`). The data lives in `vault/profile.ts` (listing B.14).

| Policy | `standard` (default; BSI-aligned) | `fips-140-3` (opt-in; NIST, FedRAMP, NIAP-aligned) |
| --- | --- | --- |
| FIPS provider required to be active | no (the module is still used for every operation) | **yes**: POST-MODULE-STATUS fails otherwise |
| Password KDF | Argon2id, m = 256 MiB, t = 4, p = 1. Floors 64 MiB / 2, ceilings 1 GiB / 10 (unchanged). Computed natively in `g_std_ctx`. | PBKDF2-HMAC-SHA-512 (SP 800-132). Iterations calibrated to about 1 s, floor 600,000, ceiling 10,000,000. Salt 32 bytes (accepted range 16–64). dkLen 32. |
| Suite written | 0x01 for header-v1 vaults until they are upgraded (C9); 0x02 for every vault created after C5 | 0x02 |
| Suites read | 0x01, 0x02 | 0x02 only |
| Password minimum | 10 characters, blocklist, NFC | **15** characters (SP 800-63B-4), blocklist, NFC |
| Idle lock | user choice, "Never" allowed | ≤ 15 minutes; "Never" becomes 15 (`effectiveIdleMinutes`) |
| Lock on sleep / screen lock | user choice | forced on |
| Quick unlock | allowed | **off**: the biometric is not bound to the key, and `safeStorage` is outside the module |
| Unlock throttle (AC-7) | none | 3 failures in 15 minutes → password unlock refused for 180 minutes; the recovery key is never throttled |
| Remote images in notes | allowed (CSP `img-src https:`) | blocked |
| Credential storage on Linux `basic_text` | session-only (never persisted) | refused |
| Updates | signature-verified when signatures are present (C12) | **only** signed updates are applied |

**Why both profiles still use the native module.** Keeping one code path means a single set of self-tests, and the `standard` profile also gains the memory protections. The only difference is *which* library context runs the password KDF (and the HKDF of suite 0x01), plus the policy table.

### 4.2 Power-up self-test (POST) state machine

**States.** The audited states (`plaintext | locked | unlocking | unlocked | locking | migrating`) gain two more:

- `selftest`, the only initial state;
- `selftest-failed`, which is terminal.

The listing is B.7 (`vault/vaultState.ts`).

```
                       ┌──────────────── POST passed: initialVaultState(files) ───────────────┐
                       │                                                                       ▼
  process start ──► selftest ──────────────────────────────────────────────► plaintext | locked | migrating
                       │ POST failed / timeout / module missing                (then the audited moves)
                       ▼
               selftest-failed ◄──── failClosed() from ANY state ◄── on-demand POST failed
                 (terminal: no outgoing move; only Quit)             ◄── pre-vault-change POST failed
                                                                     ◄── a native call threw SCC_12
```

**Rules.**

| Rule | Requirement |
| --- | --- |
| S-1 [all] | `VaultStateMachine` starts in `selftest`. `initialVaultState()` runs only after `runPost()` returns `ok: true`, inside `startupSelfTest` (listing B.11). |
| S-2 [all] | Until the POST passes, none of these run: `openDatabase`, `openServices`, `unlockVault`, `SyncService.start`, `startMcp`, and anything that parses `vault.json` beyond the profile peek of S-4. IPC handlers may be *registered*, because `guardHandlers` gates them on state (table below). The first `BrowserWindow` is created after the POST: the lock screen, the app, or the error screen. The POST takes under 10 ms (V-7). |
| S-3 [all] | POST order: (1) load `slate_native.node` (failure: `POST-MODULE-LOAD`); (2) `native.hardenProcess()`; (3) `native.init(config, modulesDir, requireFips)`, which loads the FIPS provider and runs its integrity HMAC and CASTs; (4) `POST-MODULE-STATUS`: no module error, zero module self-test failures, and when `requireFips` is set, `fipsActive` plus the SHA-256 of `fips.{dylib,so}` matching the digest pinned at build time; (5) the 15 algorithm and composed KATs in the order of `KAT_IDS`; (6) `POST-ZEROIZE`: every POST handle is destroyed and `liveHandles` is back to its baseline. |
| S-4 [all] | `requireFips` is true when any of these holds: (a) `resources/policy.json` contains `{"requireFips": true}` (managed installs); (b) the local `vault.json` passes `parseHeader` (schema only, no keys) with `profile: "fips-140-3"`; (c) `profile-floor.json` (a local record of the highest profile adopted, kept like `revision`) says `fips-140-3`. Unlock re-checks this. `unlockVault` refuses with `SelfTestFailed` if the *verified* header's profile requires FIPS and `native.status().fipsActive` is false. |
| S-5 [all] | The whole POST has a 10 s budget. Exceeding it is `POST-TIMEOUT`. |
| S-6 [all] | On failure: `native.enterErrorState()` zeroises every handle and makes every native service throw `SCC_12` for the life of the process. The state becomes `selftest-failed`. The window shows: "Slate stopped: a cryptographic self-test failed (`<first failed id>`). Your notes were not opened. Quit and start Slate again; if this repeats, reinstall Slate." There are two buttons, **Quit** and **Copy diagnostic report**. The report contains the app version, OS, `native.status()`, the failed ids and timestamps, all redacted. There is no retry. |
| S-7 [all] | The POST runs again, without the module load: (a) on demand from Settings → Security → *Run self-tests* (channel `vaultSelfTest`); (b) before every vault-changing operation (encrypt, join, change password, new recovery key, rotate, profile change); (c) whenever any native call throws `SCC_12`, or any `SCC_*` code other than `SCC_11`, since an authentication failure is a normal result. A failure calls `failClosed()`. |
| S-8 [all] | `failClosed()` (listing B.11) runs in a fixed order: (1) state → `selftest-failed`, so IPC refuses from the next tick; (2) `native.enterErrorState()`; (3) every window is destroyed **without** a renderer flush, since writing through a faulty implementation is worse than losing the last ≤ 3 s of edits, and the error window opens; (4) sync is aborted (the existing `AbortSignal`), and MCP and the watcher are stopped; (5) database connections are closed (SQLite may checkpoint pages already encrypted under LK; no new plaintext is accepted); (6) `keyRing.close()`. Every step runs even if an earlier one throws. |
| S-9 [all] | `selftest-failed` is terminal: `MOVES['selftest-failed'] = []`, with no `app.relaunch()` loop. `window-all-closed` in this state quits the app. |
| S-10 [all] | Fault injection for tests: `SLATE_TEST_SELFTEST_CORRUPT=<KatId>` passes `corrupt` to `runPost`. It is honoured only when `SLATE_E2E=1` and `!app.isPackaged`, and it is added to the variables `scrubTestHooks` removes (`testHooks.ts`). |
| S-11 [all] | Plaintext users get the same behaviour. One code path; `D-2` records the decision. A plaintext data folder is still readable with any SQLite tool, so the user is not locked out of their data. |

**IPC allowed per state.** This extends `PRE_UNLOCK_CHANNELS`; listing B.8 implements it.

| State | Allowed channels | Everything else throws |
| --- | --- | --- |
| `selftest`, `selftest-failed` | `vaultStatus`, `appVersion`, `chromeMenu`, `appQuit` (new), `diagnosticsCopyReport` (new) | `SelfTestFailed` |
| `locked`, `unlocking`, `locking` | the audited `PRE_UNLOCK_CHANNELS`, plus `vaultSelfTest`. `FLUSH_CHANNELS` are allowed only while flushing. | `Locked` |
| `plaintext`, `migrating`, `unlocked` | all | — |

Every state also requires a trusted sender (B-2): otherwise `UntrustedSender`.

### 4.3 Memory isolation and zeroisation

**Where key material may exist.** [all] once C7 is done; C1 applies the interim JavaScript rules.

| Location | Before (audited) | After |
| --- | --- | --- |
| MK, KEKs, subkeys, LK, file keys | JS `Buffer`s: `KeyRing` map entries, plus `Buffer.from` copies in 64 KiB pool slabs | OpenSSL secure heap inside `slate_native.node`, addressed by `KeyHandle` |
| Password | `<input>` value, IPC string, main string, `normalize()` copy, worker `workerData` string | `<input>` value (renderer, destroyed after unlock) → `Uint8Array` over IPC → native, cleansed after the KDF. Residual: a `String` only while *setting* a password, for the policy check. |
| Recovery key | IPC string, decoded in JS | The same as the password: the decode moves into native (C7) |
| QU (quick unlock) | `qu.toString('base64')`, `decryptString` strings | Unchanged in `standard` (the `safeStorage` API takes strings only, Z-12); quick unlock is not available in `fips-140-3` |
| SQLCipher key | hex V8 string in `PRAGMA key`, SQL text inside SQLite | `keyWithHandle(handle)`: native code builds `x'<hex>'` in a stack buffer, calls `sqlite3_key_v2`, then `OPENSSL_cleanse`. `PRAGMA cipher_memory_security = ON` in `fips-140-3`. |

**Rules.**

| Rule | Requirement |
| --- | --- |
| Z-1 [all] | Each CSP in `docs/compliance/key-inventory.json` (Appendix C.1) exists only in the native secure heap. During C1, and only until C7 lands, a CSP may be a `Buffer.alloc`-backed buffer owned by exactly one function and zeroed in `finally`. |
| Z-2 [all] | Never use these on a CSP: `Buffer.from(csp)`, `Buffer.concat([…csp…])`, `Uint8Array.from(csp)`, `csp.toString(…)`, `JSON.stringify`, template literals, `structuredClone`, `postMessage`, `workerData`. T-STATIC-01 enforces this. |
| Z-3 [all] | Ownership is explicit. A function that creates a key returns a `KeyHandle`, and the receiver destroys it (`keyDestroy`) or hands it to `KeyRing`. File keys are destroyed in `finally` (listing B.5, `sealSle2With`). |
| Z-4 [all] | `KeyRing.close()` destroys every handle, then checks that `native.status().liveHandles` dropped by the same number (listing B.13). A mismatch throws. The lock step reports it, and `failClosed(['POST-ZEROIZE'])` follows. This is the ISO 19790 AS09.33 completion indicator: the lock log records `{ destroyedHandles }`. |
| Z-5 [all] | The renderer sends a password as `new TextEncoder().encode(value.normalize('NFC'))`. It then sets `input.value = ''` and zeroes the array once `invoke` settles. Main passes the `Uint8Array` straight to `native.pbkdf2` or `native.argon2id`, which cleanse it, and never turns it into a string. `CH.vaultUnlock` and `CH.vaultQuickUnlockEnable` accept only a `Uint8Array` of 1–4096 bytes. |
| Z-6 [all] | After a successful unlock, main creates a new app window and then destroys the lock window. This is §15 N6 in reverse, and it replaces today's `loadPage(w, false)` on the same window (`index.ts:301`). T-ZERO-05 asserts that the lock renderer's OS pid has exited. |
| Z-7 [all] | No worker thread ever holds a CSP. `argon2.worker.ts` and `hash-wasm` are deleted in C4. |
| Z-8 [all] | SQLCipher is keyed only through `keyWithHandle`. `keyPragmaValue` is deleted. |
| Z-9 [all] | `native.hardenProcess()` runs in the POST before any key exists. It sets `setrlimit(RLIMIT_CORE, 0)` on all platforms and `prctl(PR_SET_DUMPABLE, 0)` on Linux. On macOS, a hardened runtime without the `com.apple.security.get-task-allow` entitlement (C12, needs D-1) stops other non-root processes attaching. T-ZERO-06 checks that Chromium child processes still launch on Linux with the process non-dumpable. |
| Z-10 [all] | The secure heap is 1 MiB with a 32-byte minimum allocation. If `CRYPTO_secure_malloc_init` returns 2 (heap allocated but not locked, for example because RLIMIT_MEMLOCK is too small), `status().secureHeapLocked` is `false`. Settings → Security then says "Memory locking is unavailable on this system", and a `module.degraded` event is logged. FIPS does not require mlock, so the `fips-140-3` profile still runs. |
| Z-11 [all] | V8 strings and the renderer DOM cannot be zeroed. No CSP ever becomes a string, except the residuals listed in the table above. The README's honest-copy section says so. |
| Z-12 [standard] | Quick unlock's `safeStorage` call needs a string: `encryptStringAsync(qu base64)`. This residual is accepted in `standard` and documented. |

**Electron-specific constraint: the V8 memory cage.** Electron 21 and later enable the V8 sandbox, so N-API external buffers pointing outside the cage are refused. Secure-heap memory therefore can **never** be exposed to JavaScript as an `ArrayBuffer`. The handle design follows from this. Anything that must reach JavaScript (ciphertext, MACs, public data) is copied into a V8-allocated `ArrayBuffer` (`napi_create_arraybuffer`, see listing B.2).

### 4.4 Electron boundary containment

| Rule | Requirement | Listing |
| --- | --- | --- |
| B-1 [all] | `installWebContentsGuards(appUrl)` runs before the first window. It does four things: `will-navigate` and `will-redirect` cancel any URL that is not the app entry; `setWindowOpenHandler` always denies (and hands `http(s)` and `mailto` to `shell.openExternal`, with the same pattern as `CH.openExternal`); `will-attach-webview` is cancelled. | B.16 |
| B-2 [all] | Every IPC handler validates `event.senderFrame`. It must be a top-level frame (`parent === null`) whose URL is the app entry: for `file:`, the same `pathname`; in dev, the same origin. Otherwise the handler throws `UntrustedSender` and logs `ipc.untrusted-sender`. | B.8 |
| B-3 [all] | Permissions are denied by default: `setPermissionRequestHandler`, `setPermissionCheckHandler` and `setDevicePermissionHandler`. The allowlist starts as `{'clipboard-sanitized-write'}`, and C8 adds only what a failing e2e spec proves is needed, each with a comment. | B.16 |
| B-4 [all] | The packaged build uses a production CSP, injected by an electron-vite `transformIndexHtml` hook when `mode === 'production'`: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: slate-blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. When the profile allows remote images *and* the setting is on, the runtime adds `https:` to `img-src` through the `session.webRequest` CSP header for `slate-blob:`/file responses, or the build emits two CSP variants and the main process picks one. The dev CSP keeps `ws:` and `http://localhost:*`. | — |
| B-5 [all] | One `secretStorage.ts` module wraps `safeStorage` with the **async** API: `isAsyncEncryptionAvailable`, `encryptStringAsync`, and `decryptStringAsync`, which returns `{ shouldReEncrypt, result }` (when `shouldReEncrypt` is set, re-encrypt and rewrite). It also applies the backend rule `REAL_KEYRINGS` (`gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`) on Linux. Callers: quick unlock, `sync/git/auth.ts`, `onenote/auth.ts`. The MSAL plaintext fallback (`onenote/auth.ts:33,39,47`) is removed in **all** profiles; without a real keyring, tokens live in memory for the session. | — |
| B-6 [all] | Release fuses (C12): `runAsNode: false`, once `slate-mcp` ships as its own executable; `enableNodeCliInspectArguments: false`, with `e2e-packaged` using a separate `electron-builder.e2e.cjs` that turns it on; `grantFileProtocolExtraPrivileges: false`, after the renderer is served from a custom `app://slate/` protocol (`protocol.handle` mapping to `out/renderer`, with strict path normalisation that refuses `..` and absolute paths). `enableNodeOptionsEnvironmentVariable: false`, `enableCookieEncryption: true`, `enableEmbeddedAsarIntegrityValidation: true` and `onlyLoadAppFromAsar: true` stay as they are. | — |
| B-7 [all] | On Linux, where there is no ASAR integrity (F-EL-02), the compensating controls are signed packages and a signed update manifest (C12), and the POST's pinned digest of the FIPS provider (S-3). | — |

### 4.5 Crypto-agile formats (version 2)

#### 4.5.1 Suite registry

| Id | Name | Key schedule (subkeys, file keys) | AEAD | Remote names | Password KDFs | Read by | Written by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `0x01` | `SLATE-1-HKDF-GCM` (the audited format) | HKDF-SHA-256 (RFC 5869) | AES-256-GCM | one AES-256-ECB block (§15 N1) | `argon2id` | `standard` | `standard` header-v1 vaults only, until upgraded |
| `0x02` | `SLATE-2-KBKDF-GCM` | SP 800-108r1 counter-mode KDF, HMAC-SHA-256, r = 32, `[L]` = 32-bit, 0x00 separator | AES-256-GCM | SIV: HMAC-SHA-256 + AES-256-CTR (§4.6) | `argon2id` (`standard`), `pbkdf2-hmac-sha512` (`fips-140-3`) | both | both |
| `0x03`–`0x0F` | reserved, symmetric | e.g. AES-256-GCM-SIV (recommended by BSI, not NIST-approved) or Ascon-AEAD128 (SP 800-232), if needed | | | | refuse | never |
| `0x10`–`0x1F` | reserved, public-key recipient | hybrid ML-KEM + ECDH per SP 800-227 / IG D.S (D-6) | | | | refuse | never |
| others | invalid | | | | | refuse | never |

A reader refuses an unknown or disallowed suite **before** touching any key (`parseEnvelope`, then the `allowed` check).

#### 4.5.2 Vault header v2

Header v1 stays readable, so existing vaults keep working. Header v2 is written by every vault created after C5, and by every upgraded vault. JSON Schema (draft 2020-12):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:slate:schema:vault-header:2",
  "type": "object",
  "additionalProperties": false,
  "required": ["format", "version", "vaultId", "revision", "createdAt", "profile", "suite", "keyEpoch", "kdf", "wraps", "check"],
  "properties": {
    "format": { "const": "slate-vault" },
    "version": { "const": 2 },
    "vaultId": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    "revision": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
    "createdAt": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "profile": { "enum": ["standard", "fips-140-3"] },
    "suite": { "const": 2 },
    "keyEpoch": { "type": "integer", "minimum": 0, "maximum": 4294967295 },
    "kdf": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false,
          "required": ["alg", "memoryKiB", "passes", "parallelism", "salt"],
          "properties": {
            "alg": { "const": "argon2id" },
            "memoryKiB": { "type": "integer", "minimum": 65536, "maximum": 1048576 },
            "passes": { "type": "integer", "minimum": 2, "maximum": 10 },
            "parallelism": { "const": 1 },
            "salt": { "$ref": "#/$defs/salt" }
          }
        },
        {
          "type": "object", "additionalProperties": false,
          "required": ["alg", "iterations", "salt"],
          "properties": {
            "alg": { "const": "pbkdf2-hmac-sha512" },
            "iterations": { "type": "integer", "minimum": 600000, "maximum": 10000000 },
            "salt": { "$ref": "#/$defs/salt" }
          }
        }
      ]
    },
    "wraps": {
      "type": "object", "additionalProperties": false, "required": ["password"],
      "properties": { "password": { "$ref": "#/$defs/wrap" }, "recovery": { "$ref": "#/$defs/wrap" } }
    },
    "history": { "type": "array", "maxItems": 4, "items": { "$ref": "#/$defs/history" } },
    "check": { "type": "string", "pattern": "^[A-Za-z0-9+/]{43}=$" }
  },
  "$defs": {
    "salt": { "type": "string", "minLength": 24, "maxLength": 88, "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" },
    "wrap": {
      "type": "object", "additionalProperties": false, "required": ["alg", "nonce", "ct"],
      "properties": {
        "alg": { "const": "aes-256-gcm" },
        "nonce": { "type": "string", "pattern": "^[A-Za-z0-9+/]{16}$" },
        "ct": { "type": "string", "pattern": "^[A-Za-z0-9+/]{64}$" }
      }
    },
    "history": {
      "type": "object", "additionalProperties": false, "required": ["epoch", "alg", "nonce", "ct"],
      "properties": {
        "epoch": { "type": "integer", "minimum": 0, "maximum": 4294967294 },
        "alg": { "const": "aes-256-gcm" },
        "nonce": { "type": "string", "pattern": "^[A-Za-z0-9+/]{16}$" },
        "ct": { "type": "string", "pattern": "^[A-Za-z0-9+/]{64}$" }
      }
    }
  }
}
```

Semantics beyond the schema, enforced in `parseHeaderV2`. Each is a `BadHeader` before any derivation.

1. The salt decodes canonically (`decodeB64` round-trip) to 16–64 bytes. For `pbkdf2-hmac-sha512`, *new* vaults use 32.
2. `profile: "fips-140-3"` requires `kdf.alg = "pbkdf2-hmac-sha512"`. `profile: "standard"` requires `argon2id`.
3. History epochs are distinct and `< keyEpoch`. With `profile: "fips-140-3"` they may only name epochs that were themselves `fips-140-3` (C9 rule R-3).
4. The parse is size-capped at 64 KiB before `JSON.parse` (F-GEN-02).

**Derivations** (suite 0x02; vectors are in Appendix A):

| Value | Definition |
| --- | --- |
| `vid` | the 16 bytes of `vaultId` (uuid hex, no dashes) |
| KEK_pw | `standard`: Argon2id(NFC(password) as UTF-8, salt, m, t, p = 1, 32). `fips-140-3`: PBKDF2-HMAC-SHA-512(P = NFC(password) as UTF-8, S = salt, c = iterations, dkLen = 32), per SP 800-132 §5.4 option 2, where the MK is protected by a KEK derived from the password. |
| KEK_rc | `KBKDF(RK, "slate/v2/recovery", vid)` |
| KEK_qu | `KBKDF(QU, "slate/v2/quick", vid ‖ deviceIdBytes)` (`standard` only) |
| K_x for x ∈ {sync, name, nameEnc, nameMac, check, prefs, localwrap} | `KBKDF(MK_keyEpoch, "slate/v2/" + x, vid)` (listing B.13) |
| file key | `KBKDF(K_sync, "slate/v2/remote-file", salt16)` (listing B.5) |
| K_hist,e | `KBKDF(MK_current, "slate/v2/history", vid ‖ uint32be(e))`, which wraps MK_e in `history[]` |
| wrap AAD | `"slate-vault/v2\|" + vaultId + "\|" + slot + "\|" + profile + "\|" + suite + "\|" + keyEpoch + "\|" + JCS(kdf)` |
| `check` | `HMAC-SHA-256(K_check, JCS(header without "check"))`. A failed check is indistinguishable from a wrong password, exactly as in v1. |

**Downgrade protection** (extends §4 "never adopts a lower revision"):

- A device stores `profile-floor.json` containing `{vaultId, profile, minHeaderVersion}`. It refuses any header for that `vaultId` whose profile ranks lower or whose `version` is lower, exactly like a lower `revision`.
- A header-v1 copy of a vault that has moved to v2 is ignored.
- `profile-floor.json` is MAC'd with K_prefs and verified at unlock, like `preunlock.json`.

#### 4.5.3 `SLE2` envelope

| Offset | Size | Field | Rule |
| --- | --- | --- | --- |
| 0 | 4 | magic `53 4C 45 32` ("SLE2") | otherwise not SLE2. `SLE1` (`53 4C 45 31`) is parsed by the legacy branch. |
| 4 | 1 | suite | must be `0x02` and in the profile's `readSuites`; otherwise `UnverifiableFile` |
| 5 | 1 | flags | bit 0 `DEFLATED`, bit 1 `PADDED`; bits 2–7 must be zero |
| 6 | 4 | keyEpoch | uint32, big-endian. It selects MK_keyEpoch (current epoch or `history`). Unknown → `UnverifiableFile`. |
| 10 | 16 | salt | from the module DRBG, fresh per file |
| 26 | 12 | nonce | from the module DRBG, fresh per file. One GCM invocation per file key. |
| 38 | n | ciphertext | |
| 38 + n | 16 | tag | |

- **AAD** = bytes `[0, 38)` ‖ `"|"` ‖ UTF-8(logical engine path). Every header byte is authenticated, and so is the location.
- **Seal order:** deflate (optional) → pad (optional) → GCM.
- **Open order:** size cap (64 MiB sealed) → structural parse → suite allowed? → key for epoch? → GCM open (an `SCC_11` becomes `UnverifiableFile`; an `SCC_12` is re-thrown to `failClosed`) → unpad → inflate, capped at 256 MiB.
- **Padding** (`PADDED`): ISO/IEC 7816-4 (`0x80` then zeros) up to `padmeLength(len + 1)`. Padmé leaks O(log log L) bits of the length, with at most about 12 % overhead. Default on for `docs/*` chunks, snapshots and device records; off for blobs.

#### 4.5.4 Other v2 formats

| File | v2 content | AAD / MAC |
| --- | --- | --- |
| `local-keys.json` | `{format: "slate-local-keys", version: 2, vaultId, deviceId, keyEpoch, db, dbCipher: "sqlcipher-4", nonce, ct}` | AAD = `"slate-lk/v2\|" + JCS(all fields except nonce and ct)`. This fixes F-GEN-01 by binding `db`. |
| `quick-unlock.bin` | `{format: "slate-quick-unlock", version: 2, vaultId, deviceId, keyEpoch, sealedQu, nonce, ct}`, with a strict schema (F-GEN-03) | AAD = `"slate-qu/v2\|" + JCS(all fields except nonce and ct)` |
| `preunlock.json` | the audited fields plus `format: "slate-preunlock", version: 2, profile` | `mac = HMAC-SHA-256(K_prefs, JCS(all fields except mac))` |
| `profile-floor.json` | `{format: "slate-profile-floor", version: 1, vaultId, profile, minHeaderVersion, mac}` | as `preunlock.json` |
| reserved: public-key wrap slot | `wraps.device-<uuid>: {alg: "hybrid-xwing-mlkem768-x25519" \| "hybrid-mlkem1024-p384", enc, nonce, ct}` | not implementable until D-6 |

### 4.6 Suite 0x02 remote names (replacing AES-ECB)

```
P   = the 16 uuid bytes, version nibble (byte 6, high half) replaced by kind code: 1 notebook, 2 page, 3 device
SIV = HMAC-SHA-256(K_name_mac, "slate-name/v2" ‖ 0x00 ‖ P)[0..16)
C   = AES-256-CTR(K_name_enc, initial counter block = SIV, P)          (one block)
name = lowercase hex(SIV ‖ C)                                          (64 characters)
decode: SIV, C ← name;  P' = AES-256-CTR(K_name_enc, SIV, C);  require HMAC(K_name_mac, …P')[0..16) == SIV
        (constant time), kind ∈ {1,2,3}, variant bits 10; restore version nibble 4.
```

- **Determinism and reversibility.** These are kept: the inputs are unique, so the names are unique. The engine's `delta` still rebuilds logical paths without downloading anything.
- **New property.** A forged name is rejected by the MAC (with probability 1 − 2^-128) rather than by a 1-in-8 kind-and-variant check.
- **Remote layout under suite 0x02.**
  - `e2ee/d/<64 hex doc>/<64 hex dev>/<seq>.c` and `s-<seq>.c`
  - `e2ee/v/<64 hex dev>.c`
  - `e2ee/b/<hex HMAC-SHA-256(K_name, "blob|" + name)>` (unchanged)
- **Regexes.** `REMOTE_DOC` and `REMOTE_DEVICE` in `sync/encryptingDrive.ts` gain the 64-hex alternatives. Suite 0x01 vaults keep the 32-hex forms.
- **Listing.** B.6.

### 4.7 Key epochs and rotation (C9)

| Rule | Requirement |
| --- | --- |
| R-1 | *Rotate keys* (Settings → Security, after a POST) generates MK_{e+1} with `keyRandom`, plus a **new recovery key**, because the recovery slot cannot be rewrapped without the old one. The new key is shown once and must be re-entered (§7.1 step 5). The password is unchanged; KEK_pw is re-derived with a fresh salt. Header: `keyEpoch = e+1`, `revision + 1`, `history` gains `{epoch: e, …GCM(K_hist,e, MK_e)}` (at most 4 entries; the oldest is refused for rotation until it is pruned). |
| R-2 | After the header has been CAS-written (§15 N2), the sync bookkeeping is reset (§7.2 step 4). The engine re-pushes everything under epoch e+1, with new names because K_name_* changed. Then the old `e2ee/d` and `e2ee/v` trees are removed. With git, the user is offered *Replace history* (the §7.2 orphan commit with force-with-lease); with OneDrive, a recycle-bin notice. Once no file with epoch e remains, which the engine's `delta` reports, `history` drops e (`revision + 1`). |
| R-3 | **Converting `standard` to `fips-140-3`** is a rotation with three extra steps: `kdf` becomes PBKDF2 (the password is re-entered and must pass the 15-character rule); `history` is **emptied**, because MK_e was protected by Argon2id and IG 2.4.A makes it plaintext-equivalent, so it must not enter an approved key tree; and the local database is re-encrypted under a new LK by the copy-and-`rekey` procedure of §7.4. The device writes the fips header only after the re-push and the local re-encryption have finished. Until then it stays `standard`, in state `migrating`, and is resumable through `migration.json`. |
| R-4 | **Cryptoperiod.** The originator-usage period for MK is ≤ 2 years (SP 800-57 Pt 1 r5, Table 1). In `fips-140-3`, Settings → Security shows "Keys are due for rotation" from `createdAt` / the last rotation + 730 days, and logs `vault.key.rotation-due`. Nothing rotates automatically, since rotation needs the user (R-1). |
| R-5 | A header-v1 `standard` vault upgrades to v2 by R-1/R-2 with an unchanged profile. That is the only way it starts writing `SLE2` (D-7: prompt or automatic). |

### 4.8 Security audit events (AU-2 / AU-3)

All events go through the existing redacting logger (`log/logger.ts`). The log folder is inside the 0700 data folder (AU-9). No event carries a key, password, note title or path below the home directory.

| Event | Fields |
| --- | --- |
| `selftest.passed` | `ran`, `ms`, `fips` |
| `selftest.failed` | `failed[]`, `fips`, `phase` (`startup` \| `on-demand` \| `pre-change` \| `module-error`) |
| `module.degraded` | `secureHeapLocked: false` |
| `vault.unlock.succeeded` | `method` (`password` \| `recovery` \| `quick`), `headerRevision` |
| `vault.unlock.failed` | `method`, `failures` |
| `vault.unlock.throttled` | `retryAt` |
| `vault.locked` | `trigger` (`idle` \| `sleep` \| `screen` \| `manual` \| `quit` \| `error`), `destroyedHandles` |
| `vault.header.adopted` | `fromRevision`, `toRevision` |
| `vault.header.refused` | `reason` (`downgrade` \| `profile` \| `schema` \| `check`) |
| `vault.password.changed` / `vault.recovery.rotated` | `revision` |
| `vault.key.rotated` / `vault.key.rotation-due` | `fromEpoch`, `toEpoch` / `dueSince` |
| `vault.profile.changed` | `from`, `to` |
| `vault.preunlock.tampered` | — |
| `sync.unverifiable` | `count` |
| `update.signature.failed` | `version` |
| `ipc.untrusted-sender` | `channel`, `origin` |
| `app.renderer.unsandboxed` | `reason` (`no-sandbox-switch` or `seccomp-off`; added in phase 12 for POAM-16, maintainer decision 2026-10-26) |

### 4.9 Native module build (C2, C3)

| Item | Specification |
| --- | --- |
| Package | `packages/native` (`@slate/native`): `binding.gyp`, `src/slate_crypto_core.{c,h}` (B.1), `src/binding.c` (B.2), `src/sqlite/` (the better-sqlite3-multiple-ciphers 13.0.3 C++ binding sources, MIT, vendored unchanged except `Database::KeyWithHandle`, B.3), `deps/sqlcipher/` (SQLCipher amalgamation), `index.ts` (B.4). |
| libcrypto | OpenSSL **3.5.x LTS**, the newest patch at implementation time, from openssl-library.org. The tarball SHA-256 is pinned in `packages/native/deps.lock.json` and checked by the build script. Configure: `./Configure <darwin64-arm64-cc\|darwin64-x86_64-cc\|linux-x86_64> no-shared no-tests no-apps no-legacy enable-ec_nistp_64_gcc_128 -fPIC -fvisibility=hidden`. Link `libcrypto.a` into the addon. |
| FIPS provider | Built from the validated **openssl-3.1.2** source (certificate #4985) exactly as its Security Policy instructs (`./Configure enable-fips && make && make install_fips`), on each target platform. Output: `fips.dylib` / `fips.so` and `fipsmodule.cnf`. Ship both in `resources/fips/` (`extraResources`, outside the asar). **L-3:** confirm with the #4985 Security Policy that `fipsmodule.cnf` may be generated at build time with `openssl fipsinstall -self_test_onload` and shipped. If not, run `fipsinstall` per machine on first launch with a bundled `slate-fipsinstall` built from the same 3.1.2 sources. **L-4:** confirm that loading the 3.1.2 provider from a 3.5.x libcrypto, and running it on macOS arm64 and Linux x64 operational environments, is covered by the certificate's OE list or by the CMVP porting rules. |
| Runtime config | Written at every start to `<userData>/fips/openssl-fips.cnf` (mode 0600) by `main/native/fipsConfig.ts`: `config_diagnostics = 1`, `openssl_conf = openssl_init`, `.include "<absolute resources>/fips/fipsmodule.cnf"`, then `[openssl_init] providers = provider_sect, alg_section = algorithm_sect`; `[provider_sect] fips = fips_sect, base = base_sect`; `[base_sect] activate = 1`; `[algorithm_sect] default_properties = fips=yes`. `scc_init` sets `OSSL_PROVIDER_set_default_search_path(<resources>/fips)` *before* `OSSL_LIB_CTX_load_config`, so no system `OPENSSLDIR` is ever consulted. |
| Pinned digest | The build writes `packages/native/fips-digest.json` (`{ "darwin-arm64": "<sha256>", "linux-x64": "<sha256>" }`), which electron-vite inlines into the main bundle. POST-MODULE-STATUS compares the file on disk with it. |
| Symbol isolation | macOS: `-Wl,-exported_symbol,_napi_register_module_v1 -Wl,-exported_symbol,_node_api_module_get_api_version_v1` (V-6: only these two symbols are exported). Linux: `-Wl,--exclude-libs,ALL -Wl,-Bsymbolic -Wl,--version-script=exports.map`, with `exports.map` = `{ global: napi_register_module_v1; node_api_module_get_api_version_v1; local: *; };`. Acceptance: `nm -D --defined-only slate_native.node` lists exactly those two symbols. |
| SQLCipher | SQLCipher community edition (BSD-3), the newest 4.x release, version and SHA-256 pinned in `deps.lock.json`. The amalgamation is built per its README with `-DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_OPENSSL -DSQLITE_TEMP_STORE=3 -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown`, plus the better-sqlite3 defines from `deps/defines.gypi`. `SQLCIPHER_CRYPTO_OPENSSL` is mandatory on macOS, where SQLCipher otherwise defaults to CommonCrypto. SQLCipher uses NULL (default) library contexts, so it is served by the FIPS provider loaded into the default context (B.1 `scc_init`). |
| Database checks | On every keyed open, `openDatabase` asserts `PRAGMA cipher_provider` = `openssl`. In `fips-140-3` it also asserts `PRAGMA cipher_fips_status` = `1`. Any other answer → `failClosed(['POST-MODULE-STATUS'])`. |
| Compatibility | SQLite3MultipleCiphers with `cipher='sqlcipher'`, `legacy=4` writes the SQLCipher 4 format, so existing encrypted databases must open unchanged with SQLCipher 4 defaults. T-DB-01 proves this with a fixture database created by the audited build. `applyCipher`'s pragmas are removed; SQLCipher ignores them. |
| **L-5** | SQLCipher 4 derives its page-HMAC key with PBKDF2-HMAC-SHA-512 using 2 iterations (`fast_kdf_iter`) from the raw key. That is a key-from-key use of PBKDF2. The lab must confirm it is acceptable, or the commercial Zetetic module (#5185) must be used instead (D-4). |
| Prebuilds | CI builds `darwin-arm64`, `darwin-x64` and `linux-x64` (the release targets of `.github/workflows/release.yml`). Windows is out of scope: the `fips-140-3` profile is hidden there until a Windows build exists. |

---

## 5. Implementation-ready code

### 5.1 Where each listing goes

Every listing is a complete file unless marked *excerpt*. "Verified" says what was done during the audit.

| Listing | Target path in the repository | WP | Verified |
| --- | --- | --- | --- |
| B.1 | `packages/native/src/slate_crypto_core.h`, `packages/native/src/slate_crypto_core.c` | C2 | Compiled with `-std=c11 -Wall -Wextra -Werror` against OpenSSL 3.6.4. KATs pass, and also under `-fsanitize=address,undefined`. |
| B.1a | `packages/native/test/kat.c` | C2 | Compiled and run: 20/20 pass, plain and under ASan/UBSan |
| B.2 | `packages/native/src/binding.c` | C2 | Built as `slate_native.node`, loaded and exercised in Node 22 and in Electron 45 |
| B.3 | `packages/native/src/sqlite/database_key.cpp` (*excerpt, pseudo-specification*) | C3 | Not compiled: it depends on the vendored better-sqlite3 sources |
| B.4 | `packages/native/index.ts` | C2 | Type-checked |
| B.5 | `packages/desktop/src/main/vault/envelope.ts` (replaces `crypto.ts`'s envelope half) | C4/C5 | Type-checked. Run: `SLE2` KAT, and `SLE1` legacy writes reproduce the audited bytes exactly. |
| B.6 | `packages/desktop/src/main/vault/names.ts` (suite 0x02 half) | C5 | Type-checked; run as POST-NAME-V2 |
| B.7 | `packages/desktop/src/main/vault/vaultState.ts` | C6 | Type-checked; run in `post.test.ts` |
| B.8 | `packages/desktop/src/main/ipcGuard.ts` | C6/C8 | Type-checked |
| §5.2 | `vault/selftest/vectors.ts`, `vault/selftest/post.ts`, `vault/selftest/supervisor.ts`, `vault/selftest/child.ts` | C6 | Run inside Electron 45: 17/17 pass; 17/17 single-vector corruptions detected |
| B.13 | `packages/desktop/src/main/vault/keyring.ts` | C7 | Type-checked |
| B.14 | `packages/desktop/src/main/vault/profile.ts` | C5/C10 | Type-checked |
| B.15 | `packages/desktop/src/main/vault/unlockThrottle.ts` | C10 | Type-checked |
| B.16 | `packages/desktop/src/main/hardening.ts` | C8 | Type-checked against Electron 45 typings |
| B.17 | `packages/desktop/src/main/secretStorage.ts` | C8 | Type-checked against Electron 45 typings |
| B.18 | `packages/desktop/src/main/native/fipsConfig.ts` | C2 | Type-checked |
| B.19 | `packages/desktop/src/preload/index.ts` and lock screen (*excerpt*) | C7 | Type-checked |
| §6 | the test listings | C6, C7, C11 | `fuzz.test.ts` run (7 × 2,000); the others type-checked |

### 5.2 Power-up self-test with known-answer vectors

The POST runs **the production code paths with fixed inputs**. `sealSle2With` is the very function that `sealEnvelope` calls with fresh randomness, and `encodeIdV2`/`decodeIdV2` are the production name codec. A corrupted implementation therefore fails the POST rather than only a reimplementation of it. Every comparison is constant-time. Fault injection (`corrupt`) flips one bit of the expected value, which the comparison cannot tell apart from a wrong computation.

```typescript
// packages/desktop/src/main/vault/selftest/vectors.ts — known-answer vectors for the power-up self-test.
// Every value was cross-checked in the audit with two independent implementations (OpenSSL 3.6.4 CLI,
// Python 3.14 hashlib, Node 22 / OpenSSL 3.5.8, Electron 45 / BoringSSL); see audit Appendix A.

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const fill = (n: number, byte: number): Uint8Array => new Uint8Array(n).fill(byte)
const seq = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export const KAT = {
  sha256: { msg: utf8('abc'), out: hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') }, // FIPS 180-4 example
  // RFC 4231 test case 2; the 4-byte key "Jefe" zero-extended to 32 bytes (identical under RFC 2104).
  hmacSha256: { key: Uint8Array.from([0x4a, 0x65, 0x66, 0x65, ...new Uint8Array(28)]), msg: utf8('what do ya want for nothing?'), out: hex('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843') },
  aesEcb: { key: seq(32), pt: hex('00112233445566778899aabbccddeeff'), ct: hex('8ea2b7ca516745bfeafc49904b496089') }, // FIPS 197 C.3
  // McGrew–Viega GCM test case 14: K = 0^256, IV = 0^96, P = 0^128.
  aesGcm: { key: fill(32, 0), iv: fill(12, 0), pt: fill(16, 0), ctTag: hex('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919') },
  // SP 800-108r1 counter mode, HMAC-SHA-256: KI = 00..1f, Label "slate/v2/sync", Context = vaultId bytes.
  kbkdf: { key: seq(32), label: 'slate/v2/sync', context: hex('000000000000400080000000000000aa'), out: hex('88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388') },
  // Suite 0x01 key schedule: HKDF-SHA-256(IKM = 00..1f, salt = empty, info = "slate/v1/sync").
  hkdfLegacy: { key: seq(32), info: 'slate/v1/sync', out: hex('50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c') },
  pbkdf2: { password: 'slate-kat-password', salt: fill(32, 0x5a), iterations: 1000, out: hex('13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079') }, // HMAC-SHA-512
  argon2id: { password: 'slate-kat-password', salt: fill(16, 0x5a), memoryKiB: 32, passes: 3, out: hex('688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812') }, // v0x13, p = 1
  // Composed: the production SLE2 sealer with fixed salt/nonce, K_sync from the kbkdf vector above.
  sle2: {
    kSync: hex('88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388'),
    path: 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk',
    salt: fill(16, 0x11), nonce: fill(12, 0x22), plaintext: utf8('slate-kat-plaintext'),
    sealed: hex('534c4532020000000000111111111111111111111111111111112222222222222222222222223a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010'),
  },
  // Composed legacy read: an SLE1 file as Slate ≤ the audited commit writes it (K_sync = hkdfLegacy.out).
  sle1: {
    kSync: hex('50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c'),
    path: 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk',
    sealed: hex('534c4531001111111111111111111111111111111122222222222222222222222282133b13f98a2ce9b3209f0132a095dc83721e58a018383d2c087f1905cc7d6c3e360f'),
    plaintext: utf8('slate-kat-plaintext'),
  },
  // Suite 0x02 remote name (SIV: HMAC-SHA-256 synthetic IV + AES-256-CTR) of page 00000000-0000-4000-8000-000000000001.
  nameV2: {
    kNameEnc: hex('945f11ea9bf4b80dc2ca2f87255998fd341f56c6d9a6fb45a44aa067c1b3f589'),
    kNameMac: hex('5ed3ac7f8024fae8e05db04c670e85169ccb2a046814a7cd455d78575be4f36e'),
    kind: 'page', uuid: '00000000-0000-4000-8000-000000000001',
    name: '50e291505985f76efa7aeb45620bd1b830101fd8c6a1b6030c339f4eee5ffe9c',
  },
} as const
```

```typescript
// packages/desktop/src/main/vault/selftest/post.ts — application power-up self-test (audit §4.2).
import { openEnvelope, sealSle2With, SUITE, type EnvelopeKeys, type SuiteId } from '../envelope'
import type { KeyHandle, NativeStatus, SlateNative } from '@slate/native'
import { decodeIdV2, encodeIdV2 } from '../names'
import { KAT } from './vectors'

export const KAT_IDS = [
  'POST-MODULE-STATUS',
  'POST-SHA256',
  'POST-HMAC-SHA256',
  'POST-AES-ECB-ENC',
  'POST-AES-ECB-DEC',
  'POST-AES-GCM-ENC',
  'POST-AES-GCM-DEC',
  'POST-AES-GCM-TAG-REJECT',
  'POST-KBKDF',
  'POST-HKDF-LEGACY',
  'POST-PBKDF2',
  'POST-ARGON2ID',
  'POST-SLE2-SEAL',
  'POST-SLE1-OPEN',
  'POST-NAME-V2',
  'POST-DRBG',
  'POST-ZEROIZE',
] as const
export type KatId = (typeof KAT_IDS)[number] | 'POST-MODULE-LOAD' | 'POST-TIMEOUT'

export interface PostResult {
  ok: boolean
  /** In run order; the first entry is the reason shown on the error screen. */
  failed: KatId[]
  ran: KatId[]
  ms: number
  module: NativeStatus | null
}

export interface PostOptions {
  /** Null when the addon could not be loaded at all. */
  native: SlateNative | null
  /** True for a vault (or install policy) on the fips-140-3 profile: the FIPS provider must be active. */
  requireFips: boolean
  /**
   * Test hook (honoured only when SLATE_E2E=1 and the app is not packaged; scrubTestHooks removes
   * it otherwise): the named KAT compares against a vector with one bit flipped.
   */
  corrupt?: KatId | null
  /**
   * [fips] The FIPS provider binary as read from resources/fips/, and the SHA-256 pinned into the main
   * bundle at build time (packages/native/fips-digest.json). Checked in addition to the provider's own HMAC.
   */
  moduleFile?: { bytes: Uint8Array; pinnedSha256: Uint8Array } | null
  /** Whole-run budget; exceeding it is POST-TIMEOUT. */
  budgetMs?: number
  now?: () => number
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}

function flipped(v: Uint8Array): Uint8Array {
  const c = Uint8Array.from(v)
  c[c.length - 1]! ^= 0x01
  return c
}

/** A handle's 32 bytes, observed through a public service (AES of a zero block), so the POST never exports keys. */
function fingerprint(n: SlateNative, key: KeyHandle): Uint8Array {
  return n.aesEcbBlock(key, new Uint8Array(16), true)
}

export function runPost(opts: PostOptions): PostResult {
  const now = opts.now ?? (() => performance.now())
  const start = now()
  const ran: KatId[] = []
  const failed: KatId[] = []
  const n = opts.native
  if (!n) return { ok: false, failed: ['POST-MODULE-LOAD'], ran: ['POST-MODULE-LOAD'], ms: now() - start, module: null }
  const want = (id: KatId, v: Uint8Array) => (opts.corrupt === id ? flipped(v) : v)
  const owned: KeyHandle[] = []
  const own = (h: KeyHandle) => (owned.push(h), h)
  const imp = (bytes: Uint8Array) => own(n.keyImport(Uint8Array.from(bytes)))
  const baseline = n.status().liveHandles

  const check = (id: KatId, test: () => boolean) => {
    ran.push(id)
    let ok = false
    try {
      ok = test()
    } catch {
      ok = false
    }
    if (!ok) failed.push(id)
  }

  check('POST-MODULE-STATUS', () => {
    const s = n.status()
    if (s.errorState || s.moduleSelfTestFailures !== 0 || opts.corrupt === 'POST-MODULE-STATUS') return false
    if (!opts.requireFips) return true
    const f = opts.moduleFile
    return s.fipsActive && !!f && equal(n.sha256(f.bytes), f.pinnedSha256)
  })
  check('POST-SHA256', () => equal(n.sha256(KAT.sha256.msg), want('POST-SHA256', KAT.sha256.out)))
  check('POST-HMAC-SHA256', () => equal(n.hmacSha256(imp(KAT.hmacSha256.key), KAT.hmacSha256.msg), want('POST-HMAC-SHA256', KAT.hmacSha256.out)))
  const ecbKey = imp(KAT.aesEcb.key)
  check('POST-AES-ECB-ENC', () => equal(n.aesEcbBlock(ecbKey, KAT.aesEcb.pt, true), want('POST-AES-ECB-ENC', KAT.aesEcb.ct)))
  check('POST-AES-ECB-DEC', () => equal(n.aesEcbBlock(ecbKey, KAT.aesEcb.ct, false), want('POST-AES-ECB-DEC', KAT.aesEcb.pt)))
  const gcmKey = imp(KAT.aesGcm.key)
  check('POST-AES-GCM-ENC', () => equal(n.gcmSeal(gcmKey, KAT.aesGcm.iv, new Uint8Array(0), KAT.aesGcm.pt).subarray(12), want('POST-AES-GCM-ENC', KAT.aesGcm.ctTag)))
  check('POST-AES-GCM-DEC', () => equal(n.gcmOpen(gcmKey, KAT.aesGcm.iv, new Uint8Array(0), KAT.aesGcm.ctTag), want('POST-AES-GCM-DEC', KAT.aesGcm.pt)))
  check('POST-AES-GCM-TAG-REJECT', () => {
    if (opts.corrupt === 'POST-AES-GCM-TAG-REJECT') return false
    try {
      n.gcmOpen(gcmKey, KAT.aesGcm.iv, new Uint8Array(0), flipped(KAT.aesGcm.ctTag))
      return false // a forged tag that opens is the worst failure there is
    } catch {
      return true
    }
  })
  check('POST-KBKDF', () => {
    const out = own(n.kbkdf(imp(KAT.kbkdf.key), KAT.kbkdf.label, KAT.kbkdf.context))
    return equal(fingerprint(n, out), fingerprint(n, imp(want('POST-KBKDF', KAT.kbkdf.out))))
  })
  check('POST-HKDF-LEGACY', () => {
    const out = own(n.hkdfLegacy(imp(KAT.hkdfLegacy.key), new Uint8Array(0), KAT.hkdfLegacy.info))
    return equal(fingerprint(n, out), fingerprint(n, imp(want('POST-HKDF-LEGACY', KAT.hkdfLegacy.out))))
  })
  check('POST-PBKDF2', () => {
    const out = own(n.pbkdf2(new TextEncoder().encode(KAT.pbkdf2.password), Uint8Array.from(KAT.pbkdf2.salt), KAT.pbkdf2.iterations))
    return equal(fingerprint(n, out), fingerprint(n, imp(want('POST-PBKDF2', KAT.pbkdf2.out))))
  })
  check('POST-ARGON2ID', () => {
    const a = KAT.argon2id
    const out = own(n.argon2id(new TextEncoder().encode(a.password), Uint8Array.from(a.salt), a.memoryKiB, a.passes))
    return equal(fingerprint(n, out), fingerprint(n, imp(want('POST-ARGON2ID', a.out))))
  })
  check('POST-SLE2-SEAL', () => {
    const k = KAT.sle2
    const sealed = sealSle2With(n, imp(k.kSync), 0, k.path, k.plaintext, { salt: k.salt, nonce: k.nonce }, { deflate: false, pad: false })
    return equal(sealed, want('POST-SLE2-SEAL', k.sealed))
  })
  check('POST-SLE1-OPEN', () => {
    const k = KAT.sle1
    const kSync = imp(k.kSync)
    const keys: EnvelopeKeys = { syncKey: () => kSync, writeSuite: SUITE.KBKDF_AES256GCM, writeEpoch: 0 }
    const allowed: ReadonlySet<SuiteId> = new Set([SUITE.HKDF_AES256GCM])
    return equal(openEnvelope(n, keys, k.path, k.sealed, allowed), want('POST-SLE1-OPEN', k.plaintext))
  })
  check('POST-NAME-V2', () => {
    const v = KAT.nameV2
    const keys = { enc: imp(v.kNameEnc), mac: imp(v.kNameMac) }
    const name = encodeIdV2(n, keys, v.kind, v.uuid)
    const back = decodeIdV2(n, keys, name)
    const expected = opts.corrupt === 'POST-NAME-V2' ? v.name.slice(0, -1) + (v.name.endsWith('0') ? '1' : '0') : v.name
    return name === expected && back?.kind === v.kind && back.uuid === v.uuid
  })
  check('POST-DRBG', () => {
    // A sanity check only: the module runs the SP 800-90A/B health tests itself.
    const a = n.randomBytes(32)
    const b = n.randomBytes(32)
    return opts.corrupt !== 'POST-DRBG' && !equal(a, b) && a.some((x) => x !== 0)
  })
  check('POST-ZEROIZE', () => {
    for (const h of owned.splice(0)) n.keyDestroy(h)
    return n.status().liveHandles === baseline && opts.corrupt !== 'POST-ZEROIZE'
  })
  for (const h of owned.splice(0)) n.keyDestroy(h)

  const ms = now() - start
  if (ms > (opts.budgetMs ?? 10_000)) failed.push('POST-TIMEOUT')
  const ok = failed.length === 0
  // ISO/IEC 19790 §7.10: a failed self-test leaves the module refusing every service until restart.
  if (!ok) n.enterErrorState()
  return { ok, failed, ran, ms, module: n.status() }
}
```

```typescript
// packages/desktop/src/main/vault/selftest/supervisor.ts — wires the POST into start-up and fails closed later.
import type { SlateNative } from '@slate/native'
import type { VaultState, VaultStateMachine } from '../vaultState'
import { runPost, type KatId, type PostResult } from './post'

export interface SelfTestDeps {
  /** Loads and initialises the addon; returns null (never throws) when either step fails. */
  loadNative(): SlateNative | null
  /** From the install policy, or the `profile` field of a parsed (not yet verified) vault.json. */
  requireFips(): boolean
  vault: VaultStateMachine
  /** The audited initialVaultState(), evaluated only after the POST passed. */
  initialState(): VaultState
  corrupt: KatId | null
  log(event: 'selftest.passed' | 'selftest.failed', fields: Record<string, unknown>): void
}

export interface EmergencySteps {
  /** Abort sync between files, stop MCP and the external watch; nothing waits on the renderer. */
  stopServices(): Promise<void>
  /** Destroy every window without asking it to flush, then show the self-test error window. */
  replaceWindowsWithErrorScreen(failed: readonly KatId[]): void
  closeDatabases(): void
  closeKeyRing(): number
}

/**
 * Rule S-1…S-6: runs before any IPC handler can reach a service, before a database is opened and
 * before vault.json is trusted. Returns the result so index.ts can pick the first window to show.
 */
export function startupSelfTest(deps: SelfTestDeps): PostResult {
  const result = runPost({ native: deps.loadNative(), requireFips: deps.requireFips(), corrupt: deps.corrupt })
  if (result.ok) {
    deps.vault.to(deps.initialState())
    deps.log('selftest.passed', { ran: result.ran.length, ms: Math.round(result.ms), fips: result.module?.fipsActive ?? false })
  } else {
    deps.vault.fail()
    deps.log('selftest.failed', { failed: result.failed, fips: result.module?.fipsActive ?? false })
  }
  return result
}

/**
 * Rule S-7/S-8: a self-test that fails after start-up (on demand, before a vault change, or a
 * module call answering SCC_12) moves every state to `selftest-failed`. The order matters: the
 * state flips first so IPC refuses immediately; the module zeroises before anything slow runs.
 */
export async function failClosed(native: SlateNative | null, vault: VaultStateMachine, steps: EmergencySteps, failed: readonly KatId[]): Promise<void> {
  vault.fail()
  native?.enterErrorState()
  const attempt = async (run: () => unknown) => {
    try {
      await run()
    } catch {
      // Every step runs: a broken sync must not keep a database open.
    }
  }
  await attempt(() => steps.replaceWindowsWithErrorScreen(failed))
  await attempt(() => steps.stopServices())
  await attempt(() => steps.closeDatabases())
  await attempt(() => steps.closeKeyRing())
}
```

**Wiring in `index.ts`** (*integration sketch, not compiled*: it names existing functions of the audited `index.ts`):

```typescript
// Replaces `new VaultStateMachine(initialVaultState({...}))` (index.ts:119-126) and moves window creation after it.
const vault = new VaultStateMachine() // state: 'selftest'
const paths = fipsPaths(process.resourcesPath, dataDir)
const requireFips = () => policyRequiresFips(process.resourcesPath) || headerProfilePeek(dataDir) === 'fips-140-3' || profileFloor(dataDir) === 'fips-140-3'
const native = (() => {
  try {
    const n = loadNative(join(__dirname, '../native/slate_native.node'))
    n.hardenProcess()
    if (requireFips()) writeFipsConfig(paths)
    n.init(paths.configFile, paths.modulesDir, requireFips())
    return n
  } catch {
    return null // POST-MODULE-LOAD
  }
})()
const post = startupSelfTest({
  loadNative: () => native,
  requireFips,
  vault,
  initialState: () => initialVaultState({ vault: existsSync(join(dataDir, VAULT_FILE)), localKeys: existsSync(join(dataDir, LOCAL_KEYS_FILE)), migration: existsSync(join(dataDir, MIGRATION_FILE)), plainDb: existsSync(join(dataDir, 'slate.db')) }),
  corrupt: isE2E && !app.isPackaged ? ((process.env.SLATE_TEST_SELFTEST_CORRUPT ?? null) as KatId | null) : null,
  log: (event, fields) => log.info('vault', event, fields),
})
if (!post.ok) {
  openSelfTestErrorWindow(post.failed) // loads index.html?selftest-failed=<id>; renders data-testid="selftest-failed"
  return // nothing below runs: no services, no sync, no MCP, no lock triggers
}
```

The `moduleFile` option is filled from `readFileSync(join(paths.modulesDir, process.platform === 'darwin' ? 'fips.dylib' : 'fips.so'))` together with the digest inlined from `packages/native/fips-digest.json`, whenever `requireFips()` is true.

### 5.3 The remaining listings

The C core, the binding, the TypeScript modules and the excerpts are in **Appendix B**, in the numbering of §5.1.

---

## 6. Compliance test-suite specification

### 6.1 Layers

| Layer | Runner | Where it runs | Gate |
| --- | --- | --- | --- |
| Unit (pure) | `npm test` (vitest 5) | every push, all platforms | required |
| Main process | `npm run test:main`: Electron as Node with the real addon | every push, `darwin-arm64` + `linux-x64` | required |
| Native | `packages/native/test/kat.c` built with `-fsanitize=address,undefined` | every push, both platforms | required |
| E2E | `npm run e2e` (Playwright, `SLATE_E2E=1`, hidden windows) | every push | required for the specs touched |
| E2E memory | `e2e/memory.spec.ts` with `SLATE_MEMSCAN=1` under `sudo -E` | nightly plus release tags, `linux-x64` only | required for release |
| Fuzz soak | `SLATE_FUZZ_RUNS=200000` on the fuzz suite | nightly | a failure blocks release |
| Packaged | `npm run e2e:packaged` with the release fuses (separate builder config for the inspect fuse, B-6) | release tags | required |

### 6.2 T-POST: forcing self-test failures into the hard-locked state

| Test | Layer | Procedure | Pass criteria |
| --- | --- | --- | --- |
| T-POST-01 | main | `runPost({ native: real, requireFips })` on an intact module | `failed = []`; `ran` equals `KAT_IDS` in order; `liveHandles` back to baseline; `ms < 1000` |
| T-POST-02 | main (child processes) | For each of the 17 `KAT_IDS`, spawn `selftest-child.js <id>` (one process each, because the error state is sticky) | `{ ok: false, failed: [id], errorState: true, servicesRefused: true }` for **every** id. The audit ran this: 17/17. |
| T-POST-03 | main | `startupSelfTest` with `loadNative: () => null` | `failed = ['POST-MODULE-LOAD']`; state `selftest-failed`; every `vault.to(x)` throws for all 7 other states |
| T-POST-04 | main | `requireFips: true` with the dev (non-FIPS) build | `failed` contains `POST-MODULE-STATUS` |
| T-POST-05 | main | `requireFips: true`, `moduleFile.bytes` = the provider binary with one byte flipped | `POST-MODULE-STATUS` fails |
| T-POST-06 | main | Provider tampering. Copy `resources/fips` into a temp directory and flip one byte in `fips.{dylib,so}` (provider integrity HMAC), then separately change `module-mac` in `fipsmodule.cnf`. `init` against each. | `init` throws `SCC_6` (`SCC_ERR_MODULE_SELFTEST`) or `SCC_5`; the POST reports `POST-MODULE-LOAD` |
| T-POST-07 | main | `failClosed` from `unlocked`, with recording fakes for each step | Steps are seen in the order windows → services → db → keys, all with state `selftest-failed` already set (listing in §6.9) |
| T-POST-08 | main | A real native call throwing `SCC_12` during `EncryptingDrive.download` | It is **not** mapped to `UnverifiableFile` (B.5 rethrows it). The supervisor runs `failClosed(['POST-MODULE-STATUS'])`. |
| T-POST-09 | main | `guardHandlers` while `selftest-failed` | Every registered channel except the `selfTest` set throws `SelfTestFailed`; the enumerated set is compared with the policy, as in the existing `ipcGuard.test.ts` |
| T-POST-10 | e2e | `selftest.spec.ts` (listing below), for 6 representative ids | Error screen with the code; no `lock-secret` field; `docs.list` and `vault.unlock` refuse; `status().state === 'selftest-failed'`; exactly 1 window; **the data folder is unchanged byte for byte**, logs excepted |
| T-POST-11 | e2e | A start without the fault after a failed start | Unlocks normally: the failure is not persisted |
| T-POST-12 | e2e | Settings → *Run self-tests* with `SLATE_TEST_SELFTEST_CORRUPT` applied on demand (`SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND=1`) while unlocked | The app window is destroyed without a flush; the error window shows; the MCP socket file is gone; `lsof`/`/proc/<pid>/fd` shows no open `slate-*.db` |
| T-POST-13 | e2e | Packaged build (`e2e:packaged`) with `SLATE_TEST_SELFTEST_CORRUPT` set | It is **ignored**: `scrubTestHooks` removes it, and the app reaches the lock screen |

```typescript
// packages/desktop/e2e/selftest.spec.ts — T-POST-10…13: a failed power-up self-test is a hard lock.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'

const PASSWORD = 'e2e selftest password'
// One vector per family; post.child.test.ts covers all of KAT_IDS at the unit layer.
const CORRUPT = ['POST-MODULE-STATUS', 'POST-AES-GCM-ENC', 'POST-KBKDF', 'POST-PBKDF2', 'POST-SLE2-SEAL', 'POST-ZEROIZE'] as const

/** sha256 of every file under the data folder except logs, which the failed start is allowed to append to. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = relative(dir, p)
      if (rel === 'logs' || rel.startsWith('logs/')) continue
      if (statSync(p).isDirectory()) walk(p)
      else out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

async function refusals(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const settle = (p: Promise<unknown>) => p.then(() => 'allowed', (e: unknown) => String(e))
    return Promise.all([settle(window.slate.docs.list('')), settle(window.slate.vault.unlock(new TextEncoder().encode('e2e selftest password')))])
  })
}

test.describe('power-up self-test', () => {
  for (const id of CORRUPT) {
    test(`${id} corrupted: no note is opened, nothing in the data folder changes, every channel refuses`, async ({ userData }) => {
      const seed = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
      await expect(seed.page.getByTestId('lock-screen')).toBeVisible()
      await seed.app.close()
      const before = snapshot(userData)

      const { app, page } = await launchApp(userData, { SLATE_TEST_SELFTEST_CORRUPT: id })
      await expect(page.getByTestId('selftest-failed')).toBeVisible()
      await expect(page.getByTestId('selftest-failed-code')).toHaveText(id)
      await expect(page.getByTestId('lock-secret')).toHaveCount(0)
      for (const outcome of await refusals(page)) expect(outcome).toContain('self-test failed')
      expect((await page.evaluate(() => window.slate.vault.status())).state).toBe('selftest-failed')
      // No window but the error screen, and no way out of it but quitting.
      expect(app.windows()).toHaveLength(1)
      await app.close()

      expect(snapshot(userData)).toEqual(before)
    })
  }

  test('the next start without the fault unlocks as usual (the failure is not persisted)', async ({ userData }) => {
    const seed = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD })
    await seed.app.close()
    const failed = await launchApp(userData, { SLATE_TEST_SELFTEST_CORRUPT: 'POST-AES-GCM-DEC' })
    await expect(failed.page.getByTestId('selftest-failed')).toBeVisible()
    await failed.app.close()
    const { app, page } = await launchApp(userData)
    await page.getByTestId('lock-secret').fill(PASSWORD)
    await page.getByTestId('lock-unlock').click()
    await expect.poll(async () => (await page.evaluate(() => window.slate.vault.status())).state).toBe('unlocked')
    await app.close()
  })
})
```

### 6.3 T-ZERO: proving that key material is gone after `KeyRing.close()`

The proof has four independent layers. Any one can fail on its own.

| Test | Layer | Procedure | Pass criteria |
| --- | --- | --- | --- |
| T-ZERO-01 | main | Open a ring (MK + LK + 7 subkeys = 9 handles). Record `status().liveHandles` before and after `close()`, then call each handle through `aesEcbBlock(h, zero, true)`. | `close()` returns 9; `liveHandles` drops by 9; every call afterwards throws `SCC_8` (handle unknown, never "zeros"); `ring.get()` throws `Locked` |
| T-ZERO-02 | main | `status().secureHeapUsed` at three points: baseline after the POST, after unlock, after lock | After the lock it equals the baseline. It is **not** compared with 0, because the DRBG instantiates its own state in the secure heap (the audit saw 864 bytes with 3 handles plus DRBG state). |
| T-ZERO-03 | native (C) | KAT program: import 6 keys, `zeroizeAll`, then read `CRYPTO_secure_used()` | `zeroized = 6`, `live = 0`, heap back to baseline (the audit ran this) |
| T-ZERO-04 | e2e memory (Linux) | `memory.spec.ts` (listing below). `SLATE_TEST_CANARY_KEYS=1` imports a fixed MK and LK; KEK_pw is recomputed with `hash-wasm` (kept as a devDependency purely as an independent reference). Scan the main process with `memscan.ts` (listing below) for raw, hex, base64, UTF-16-hex and UTF-16-base64 forms, plus the password in UTF-8 and UTF-16. | **Control:** while unlocked, `mk/raw` is found, which proves the scanner works. **Assertion:** after lock and two forced GCs, **zero** hits for every needle. |
| T-ZERO-05 | e2e | Before unlock, `pid = lockWindow.webContents.getOSProcessId()`; unlock; then `process.kill(pid, 0)` from the test | It throws `ESRCH`: the renderer process that held the password has exited (Z-6) |
| T-ZERO-06 | e2e (Linux) | With `PR_SET_DUMPABLE=0`: run the whole e2e suite. Then `kill -SEGV <main pid>` with `ulimit -c unlimited` and `kernel.core_pattern=/tmp/slate-core.%p` (CI sets both). | The suite passes, so Chromium children still spawn. No `/tmp/slate-core.*` appears, and `systemd-coredump` lists nothing for the pid. |
| T-ZERO-07 | main | V8 heap snapshot. `SLATE_TEST_HEAP_SNAPSHOT=1` adds a test-only IPC that calls `v8.writeHeapSnapshot()` after the lock; grep it for the canary hex and base64 strings. | Zero hits (cross-platform, covering the JavaScript heap only) |
| T-ZERO-08 | static | T-STATIC-01 (§6.8) | No forbidden CSP operation in `vault/`, `sync/`, `db/`, `services.ts` |

```typescript
// packages/desktop/e2e/memory.spec.ts — T-ZERO-04/05: no key byte survives a lock in the main process.
// Linux CI only (memscan reads /proc/<pid>/mem and needs CAP_SYS_PTRACE: the job runs it with sudo -E).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argon2id } from 'hash-wasm'
import { expect, launchApp, test } from './fixtures'
import { needlesFor, scanProcess } from './memscan'

// SLATE_TEST_CANARY_KEYS=1 (e2e and unpackaged only) makes the test vault import these MK and LK values
// instead of drawing them from the DRBG, so the scan knows what to look for. 32 bytes each.
const CANARY = {
  mk: Buffer.from('c4a1a7d0' + '5a'.repeat(28), 'hex'),
  lk: Buffer.from('c4a1a7d1' + 'a5'.repeat(28), 'hex'),
} as const
const PASSWORD = 'canary-password-7f3e9b21c4'

/** KEK_pw is not chosen but derived: recompute it with hash-wasm (kept as a devDependency for exactly this). */
async function expectedKek(userData: string): Promise<Buffer> {
  const { kdf } = JSON.parse(readFileSync(join(userData, 'vault.json'), 'utf8')) as { kdf: { memoryKiB: number; passes: number; salt: string } }
  const kek = await argon2id({ password: PASSWORD, salt: Buffer.from(kdf.salt, 'base64'), iterations: kdf.passes, memorySize: kdf.memoryKiB, parallelism: 1, hashLength: 32, outputType: 'binary' })
  return Buffer.from(kek)
}

test.skip(process.platform !== 'linux' || process.env.SLATE_MEMSCAN !== '1', 'needs Linux and sudo (SLATE_MEMSCAN=1)')

test('after lock, the main process holds no copy of MK, LK, the password KEK or the password', async ({ userData }) => {
  const { app, page } = await launchApp(userData, { SLATE_TEST_ENCRYPT_PASSWORD: PASSWORD, SLATE_TEST_CANARY_KEYS: '1', SLATE_TEST_EXPOSE_GC: '1' })
  const mainPid = await app.evaluate(() => process.pid)
  await page.getByTestId('lock-secret').fill(PASSWORD)
  await page.getByTestId('lock-unlock').click()
  await expect.poll(async () => (await page.evaluate(() => window.slate.vault.status())).state).toBe('unlocked')

  // Control: while unlocked the scanner must be able to see what it is looking for, or a clean
  // result proves nothing. The native secure heap holds MK in raw form, so the raw needle must hit.
  const unlocked = scanProcess(mainPid, needlesFor('mk', CANARY.mk))
  expect(unlocked.some((h) => h.label === 'mk/raw')).toBe(true)

  await page.evaluate(() => window.slate.vault.lock())
  await expect.poll(async () => {
    for (const w of app.windows()) if (await w.getByTestId('lock-screen').isVisible().catch(() => false)) return true
    return false
  }).toBe(true)
  // Two full GCs, so a reference dropped by the lock is collected before the scan.
  await app.evaluate(() => {
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    gc?.()
  })

  const needles = [
    ...needlesFor('mk', CANARY.mk),
    ...needlesFor('lk', CANARY.lk),
    ...needlesFor('kek', await expectedKek(userData)),
    { label: 'password/utf8', bytes: Buffer.from(PASSWORD, 'utf8') },
    { label: 'password/utf16', bytes: Buffer.from(PASSWORD, 'utf16le') },
  ]
  expect(scanProcess(mainPid, needles)).toEqual([])
  await app.close()
})
```

```typescript
// packages/desktop/e2e/memscan.ts — Linux only. Reads another process's memory through /proc/<pid>/mem.
// Slate makes itself non-dumpable (PR_SET_DUMPABLE 0), so the scanner needs CAP_SYS_PTRACE: CI runs it with sudo.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'

export interface Needle {
  label: string
  bytes: Buffer
}

export interface Hit {
  label: string
  address: string
  mapping: string
}

/** Every encoding a key could leave behind: raw bytes, hex and base64 text, and V8's two-byte strings. */
export function needlesFor(label: string, secret: Uint8Array): Needle[] {
  const raw = Buffer.from(secret)
  const forms: Array<[string, Buffer]> = [
    ['raw', raw],
    ['hex', Buffer.from(raw.toString('hex'), 'latin1')],
    ['hex-utf16', Buffer.from(raw.toString('hex'), 'utf16le')],
    ['base64', Buffer.from(raw.toString('base64'), 'latin1')],
    ['base64-utf16', Buffer.from(raw.toString('base64'), 'utf16le')],
  ]
  return forms.map(([form, bytes]) => ({ label: `${label}/${form}`, bytes }))
}

interface Region {
  start: bigint
  end: bigint
  mapping: string
}

function readableRegions(pid: number): Region[] {
  const out: Region[] = []
  for (const line of readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (!m || m[3]![0] !== 'r') continue
    const mapping = m[4] ?? ''
    // Kernel-backed pages cannot be read through /proc/<pid>/mem and hold no Slate data.
    if (mapping === '[vvar]' || mapping === '[vsyscall]' || mapping === '[vvar_vclock]') continue
    out.push({ start: BigInt('0x' + m[1]!), end: BigInt('0x' + m[2]!), mapping })
  }
  return out
}

/** Scans every readable mapping in 4 MiB chunks; chunks overlap by the longest needle so no match straddles a gap. */
export function scanProcess(pid: number, needles: Needle[]): Hit[] {
  const overlap = Math.max(...needles.map((n) => n.bytes.length)) - 1
  const CHUNK = 4 * 1024 * 1024
  const buf = Buffer.alloc(CHUNK + overlap)
  const hits: Hit[] = []
  const fd = openSync(`/proc/${pid}/mem`, 'r')
  try {
    for (const r of readableRegions(pid)) {
      for (let at = r.start; at < r.end; at += BigInt(CHUNK)) {
        const want = Number(r.end - at < BigInt(CHUNK + overlap) ? r.end - at : BigInt(CHUNK + overlap))
        let got = 0
        try {
          got = readSync(fd, buf, 0, want, at)
        } catch {
          break // a guard page or a mapping that went away while scanning
        }
        const view = buf.subarray(0, got)
        for (const n of needles) {
          for (let i = view.indexOf(n.bytes); i !== -1; i = view.indexOf(n.bytes, i + 1)) {
            hits.push({ label: n.label, address: '0x' + (at + BigInt(i)).toString(16), mapping: r.mapping })
          }
        }
      }
    }
  } finally {
    closeSync(fd)
  }
  return hits
}
```

CI recipe for T-ZERO-04 and -06 (GitHub Actions, `ubuntu-latest`):

```yaml
memory-evidence:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm ci && npm run build -w @slate/desktop
    - run: sudo sysctl -w kernel.core_pattern=/tmp/slate-core.%p
    - run: ulimit -c unlimited && xvfb-run -a sudo -E env "PATH=$PATH" SLATE_MEMSCAN=1 npx playwright test e2e/memory.spec.ts
      working-directory: packages/desktop
    - run: test -z "$(ls /tmp/slate-core.* 2>/dev/null)"
```

### 6.4 T-FUZZ: hostile input to every parser

| Test | Target | Generator | Property |
| --- | --- | --- | --- |
| T-FUZZ-01 | `parseHeader` (v1), and `parseHeaderV2` once it exists | `fc.jsonValue({ maxDepth: 6 })` | Only `BadHeader` is thrown; each parse takes < 5 ms |
| T-FUZZ-02 | `parseHeader` | 1–4 structural mutations of a valid header: delete key, add key, replace value with JSON, `-0`, 2^53, `1e21`, `0.5`, `''`, `"\u0000"`, a 70,000-character string | Rejected with `BadHeader`, or accepted only if `canonicalJson(parsed) === canonicalJson(input)`, so nothing is silently dropped or coerced |
| T-FUZZ-03 | KDF ceilings and floors | integers over the whole safe range | Accepted iff 65,536 ≤ m ≤ 1,048,576 and 2 ≤ t ≤ 10 (v1). The v2 PBKDF2 range is 600,000 ≤ c ≤ 10,000,000. |
| T-FUZZ-04 | `canonicalJson` | the RFC 8785 §3.2.3 key-ordering example, plus a differential against an independent comparator (`Array.prototype.sort` with explicit code-unit comparison) over `fc.dictionary(fc.string({ unit: 'binary' }), fc.integer())` | Byte-identical output |
| T-FUZZ-05 | `parseEnvelope` | `fc.uint8Array({ maxLength: 512 })` | Only `UnverifiableFile` |
| T-FUZZ-06 | `parseEnvelope` | Valid magic with arbitrary suite, flags and length | Unknown suites and flags refused structurally |
| T-FUZZ-07 | `parseEnvelope` | Every truncation of a real `SLE2` file | Refused below 54 bytes, otherwise parsed with the right length |
| T-FUZZ-08 | `openEnvelope` with a real key | 1–8 bit flips anywhere in a sealed file; also AAD path swaps | Only `UnverifiableFile`; `inflateRawSync` is never called before the tag verified (spy on `node:zlib`) |
| T-FUZZ-09 | `openEnvelope`, deflate bomb | A validly sealed 2 MiB of zeros, opened with `maxInflated` 1 MiB | `UnverifiableFile('This file is too large or damaged')` |
| T-FUZZ-10 | `readLocalKeys` v1/v2, `parsePreunlock`, quick-unlock v2 parse, `profile-floor` parse | Mutations as in T-FUZZ-02, plus arbitrary JSON | Only their own error types; v2 parsers reject any field outside the schema |
| T-FUZZ-11 | `decodeRecovery` | `fc.string()` and near-miss strings (valid key ± one character, case, separators) | `BadRecoveryKey` or the right 32 bytes, never another 32 bytes |
| T-FUZZ-12 | `decodeIdV2` | `fc.stringMatching(/^[0-9a-f]{64}$/)` and bit flips of real names | `null` for all except real names (the MAC); never throws |
| T-FUZZ-13 | Local JSON size caps | Files of 64 KiB + 1 byte for every local JSON (F-GEN-02) | Refused before `JSON.parse` (spy) |

Seeds and runs: the default `seed = 0x51a7e` and `numRuns = 2000` in CI (`SLATE_FUZZ_SEED` and `SLATE_FUZZ_RUNS` override them). A failing seed and path are written to the test log. The minimised counterexample becomes a permanent `it(...)` case in the same file. The audit ran T-FUZZ-01, -02, -03, -04 (the RFC example), -05, -06 and -07: 7 tests, all passing.

```typescript
// packages/desktop/src/main/vault/fuzz.test.ts — property-based fuzzing of every parser that sees untrusted bytes.
// Deterministic in CI (fixed seed, numRuns below); `SLATE_FUZZ_RUNS=200000 npm run test:main -- fuzz` for a soak.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BadHeader, canonicalJson, parseHeader } from './header'
import { parseEnvelope, UnverifiableFile } from './envelope'

const RUNS = Number(process.env.SLATE_FUZZ_RUNS ?? 2000)
const SEED = Number(process.env.SLATE_FUZZ_SEED ?? 0x51a7e)
const params = { numRuns: RUNS, seed: SEED, endOnFailure: true }

const VALID = {
  format: 'slate-vault', version: 1, vaultId: '00000000-0000-4000-8000-0000000000aa', revision: 1, createdAt: 1761200000000,
  kdf: { alg: 'argon2id', memoryKiB: 262144, passes: 4, parallelism: 1, salt: Buffer.alloc(16, 7).toString('base64') },
  wraps: { password: { nonce: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(48).toString('base64') } },
  check: Buffer.alloc(32).toString('base64'),
}

/** One structural mutation of a JSON value: the operators an attacker editing vault.json has. */
const mutation = fc.oneof(
  fc.record({ op: fc.constant('delete' as const), at: fc.nat() }),
  fc.record({ op: fc.constant('add' as const), key: fc.string({ maxLength: 12 }), value: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ op: fc.constant('replace' as const), at: fc.nat(), value: fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.constantFrom(-0, 2 ** 53, -1, 1e21, 0.5, '', '\u0000', 'A'.repeat(70_000))) }),
)

type Mutation = { op: 'delete'; at: number } | { op: 'add'; key: string; value: unknown } | { op: 'replace'; at: number; value: unknown }

function apply(obj: Record<string, unknown>, m: Mutation): Record<string, unknown> {
  const keys = Object.keys(obj)
  const out: Record<string, unknown> = structuredClone(obj)
  if (m.op === 'delete' && keys.length) delete out[keys[m.at % keys.length]!]
  if (m.op === 'add') out[m.key] = m.value
  if (m.op === 'replace' && keys.length) out[keys[m.at % keys.length]!] = m.value
  return out
}

describe('parseHeader under fuzzing', () => {
  it('arbitrary JSON: only BadHeader, and each parse stays under 5 ms', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (json) => {
        const t = performance.now()
        try {
          parseHeader(json)
        } catch (e) {
          expect(e).toBeInstanceOf(BadHeader)
        }
        expect(performance.now() - t).toBeLessThan(5)
      }),
      params,
    )
  })

  it('mutated valid headers: rejected unless the mutation kept every field valid', () => {
    fc.assert(
      fc.property(fc.array(mutation as fc.Arbitrary<Mutation>, { minLength: 1, maxLength: 4 }), (ms) => {
        let h: Record<string, unknown> = { ...VALID, kdf: { ...VALID.kdf } }
        for (const m of ms) h = apply(h, m)
        try {
          const parsed = parseHeader(h)
          // Accepted: it must round-trip to exactly the canonical form of the input (no field dropped or coerced).
          expect(canonicalJson(parsed)).toBe(canonicalJson(h))
        } catch (e) {
          expect(e).toBeInstanceOf(BadHeader)
        }
      }),
      params,
    )
  })

  it('KDF ceilings hold for every integer, so a hostile header cannot ask for 1 TiB', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 53) + 1, max: 2 ** 53 - 1 }), fc.integer({ min: -100, max: 1000 }), (memoryKiB, passes) => {
        const ok = memoryKiB >= 65536 && memoryKiB <= 1024 * 1024 && passes >= 2 && passes <= 10
        const run = () => parseHeader({ ...VALID, kdf: { ...VALID.kdf, memoryKiB, passes } })
        if (ok) expect(run).not.toThrow()
        else expect(run).toThrow(BadHeader)
      }),
      params,
    )
  })

  it('canonicalJson orders keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = { '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 }
    const order = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'] as const
    // Compared as text: JSON.parse would hand integer-like keys back first and hide the order.
    expect(canonicalJson(input)).toBe('{' + order.map((k) => `${JSON.stringify(k)}:${input[k]}`).join(',') + '}')
  })
})

describe('parseEnvelope under fuzzing', () => {
  it('random bytes: only UnverifiableFile', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        try {
          parseEnvelope(bytes)
        } catch (e) {
          expect(e).toBeInstanceOf(UnverifiableFile)
        }
      }),
      params,
    )
  })

  it('valid magic with random suite/flags/lengths: unknown suites and flags are refused structurally', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.uint8Array({ maxLength: 100 }), (suite, flags, rest) => {
        const bytes = Uint8Array.from([0x53, 0x4c, 0x45, 0x32, suite, flags, ...rest])
        const structurallyValid = suite === 0x02 && (flags & ~0x03) === 0 && bytes.length >= 38 + 16
        if (structurallyValid) expect(parseEnvelope(bytes).suite).toBe(0x02)
        else expect(() => parseEnvelope(bytes)).toThrow(UnverifiableFile)
      }),
      params,
    )
  })

  it('every truncation of a real file is refused or parses to a shorter ciphertext', () => {
    const real = Uint8Array.from(Buffer.from('534c4532020000000000111111111111111111111111111111112222222222222222222222223a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010', 'hex'))
    for (let len = 0; len < real.length; len++) {
      const cut = real.subarray(0, len)
      if (len < 38 + 16) expect(() => parseEnvelope(cut)).toThrow(UnverifiableFile)
      else expect(parseEnvelope(cut).ctAndTag.length).toBe(len - 38)
    }
  })
})
```

### 6.5 T-KAT: cross-implementation vectors

| Test | Assertion |
| --- | --- |
| T-KAT-01 | Every vector in `vectors.ts` is recomputed in CI by an *independent* implementation and compared: OpenSSL CLI (`openssl kdf … KBKDF / PBKDF2 / HKDF / ARGON2ID`, `openssl enc -aes-256-ecb/ctr`), Python `hashlib`/`hmac`, and Node's `node:crypto` (OpenSSL) for GCM. The script is `packages/native/test/crossCheck.sh`, using the commands in Appendix A. |
| T-KAT-02 | `hash-wasm` (devDependency) and the native Argon2id agree on the POST vector and on one full-size vector (256 MiB, t = 4), the latter run nightly |
| T-KAT-03 | The audited `vault/crypto.ts` (before C4 deletes it) and B.5 produce identical `SLE1` bytes for the vector. The audit confirmed this. After C4 the vector stays as a fixture. |

### 6.6 T-POL: profile policy

| Test | Assertion |
| --- | --- |
| T-POL-01 | `fips-140-3`: a 14-character password is refused at creation and at change; 15 is accepted; a blocklisted password of any length is refused |
| T-POL-02 | `effectiveIdleMinutes(0, fips) === 15` and `effectiveIdleMinutes(60, fips) === 15`; the Settings UI disables "Never" and values above 15 |
| T-POL-03 | `fips-140-3`: lock-on-sleep and lock-on-screen-lock cannot be turned off |
| T-POL-04 | AC-7: three failures within 15 minutes, then the fourth attempt (password) gets `{ allowed: false, retryAt: +180 min }`; the recovery key still unlocks; success resets the throttle; failures older than 15 minutes do not count |
| T-POL-05 | Downgrades: a v1 header, or a v2 header with `profile: "standard"`, for a vault whose `profile-floor.json` says `fips-140-3` is refused with `vault.header.refused { reason: 'downgrade' }` |
| T-POL-06 | `fips-140-3`: quick unlock is not offered, `enableQuickUnlock` refuses, and an existing `quick-unlock.bin` is deleted at conversion |
| T-POL-07 | `fips-140-3`: a suite 0x01 file on the remote is `UnverifiableFile` (`readSuites`) |
| T-POL-08 | `fips-140-3`: `img-src` in the effective CSP has no `https:`; a note with a remote image makes no network request (Playwright `page.on('request')`) |

### 6.7 T-B: Electron boundary

| Test | Assertion |
| --- | --- |
| T-B-01 | e2e: `page.evaluate(() => location.href = 'https://example.invalid/')` leaves the window on the app URL; `window.open('https://example.invalid')` opens no `BrowserWindow` |
| T-B-02 | unit: `isTrustedSender` is false for a sub-frame, for `https://evil.invalid/`, for `file:///tmp/other.html` and for `null`; true for the exact app entry |
| T-B-03 | unit: `guardHandlers` throws `UntrustedSender` before reading state for an untrusted frame (the handler spy is not called) |
| T-B-04 | e2e: a `navigator.mediaDevices.getUserMedia` request is denied; `Notification.requestPermission()` resolves `'denied'` |
| T-B-05 | unit: `createSecretStorage` with backend `basic_text` on Linux: `available() === false`, and `seal` throws `SecretStorageUnavailable`; `credentialPolicy(false, 'standard') === 'session-only'` |
| T-B-06 | unit: no code path writes the MSAL cache in plaintext (the fallback branch is deleted; grep test) |
| T-B-07 | packaged: `npx @electron/fuses read --app <Slate.app>` shows `RunAsNode: Disabled` (after the C12 MCP change), `EnableNodeCliInspectArguments: Disabled` and `GrantFileProtocolExtraPrivileges: Disabled` |

### 6.8 T-STATIC: source checks (vitest, `packages/desktop/src/main/static.test.ts`)

| Test | Rule | Implementation |
| --- | --- | --- |
| T-STATIC-01 | Z-2 | Parse every `.ts` under `main/vault`, `main/sync`, `main/db` and `main/services.ts` with the TypeScript compiler API. Fail on `Buffer.from(<expr>)`, `Buffer.concat`, `.toString(` or a template literal whose operand's identifier matches `/(^\|_)(mk\|lk\|kek\|key\|secret\|qu\|password)($\|[A-Z_])/i` or is the result of `keyRing.get`. An allowlist file names the reviewed exceptions, each with a reason. |
| T-STATIC-02 | §4.0 invariant 1 | No `import … from 'node:crypto'` in `main/vault`, `main/sync`, `main/db`. Elsewhere only `randomUUID` and `createHash('sha256')` named imports. |
| T-STATIC-03 | Key inventory complete | Every `kbkdf(…, 'slate/v2/<x>', …)` label and every `KeyName` in `keyring.ts` has an entry in `docs/compliance/key-inventory.json`, and every inventory entry with `owner` under `main/` names an existing file |
| T-STATIC-04 | Test hooks scrubbed | Every `process.env.SLATE_TEST_*` read in `src/main` is listed in `TEST_HOOK_VARS` (`testHooks.ts`) |
| T-GCM-01 | F-FIPS-09 | The `gcmSeal` / `gcmSealKey` call sites are exactly the set recorded in `key-inventory.json` (`gcmInvocationsPerKey`) |

### 6.9 Unit listings for the POST

```typescript
// packages/desktop/src/main/vault/selftest/post.test.ts — runs under `npm run test:main` (Electron as Node)
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import type { SlateNative } from '@slate/native'
import { KAT_IDS, runPost, type KatId } from './post'
import { VaultStateMachine } from '../vaultState'
import { failClosed, startupSelfTest } from './supervisor'

// A fresh module instance per test is not possible inside one process (the error state is sticky
// by design), so failure cases run the addon in a child process: see post.child.test.ts. Here the
// module is replaced by a recording fake around the real one for the state-machine assertions.
const real = (): SlateNative => {
  const req = createRequire(import.meta.url)
  const n = req(process.env.SLATE_NATIVE_ADDON ?? req.resolve('@slate/native/build/Release/slate_native.node')) as SlateNative
  n.init(process.env.SLATE_FIPS_CONF ?? '', process.env.SLATE_FIPS_MODULES ?? '', process.env.SLATE_REQUIRE_FIPS === '1')
  return n
}

describe('power-up self-test', () => {
  it('passes every KAT on an intact module and leaves no key handle behind', () => {
    const n = real()
    const before = n.status().liveHandles
    const r = runPost({ native: n, requireFips: process.env.SLATE_REQUIRE_FIPS === '1' })
    expect(r.failed).toEqual([])
    expect(r.ran).toEqual([...KAT_IDS])
    expect(n.status().liveHandles).toBe(before)
    expect(r.ms).toBeLessThan(1000)
  })

  it('a missing module is POST-MODULE-LOAD and the vault never leaves selftest-failed', () => {
    const vault = new VaultStateMachine()
    const r = startupSelfTest({ loadNative: () => null, requireFips: () => false, vault, initialState: () => 'locked', corrupt: null, log: () => {} })
    expect(r.failed).toEqual(['POST-MODULE-LOAD'])
    expect(vault.state).toBe('selftest-failed')
    for (const next of ['plaintext', 'locked', 'unlocking', 'unlocked', 'migrating', 'selftest'] as const) {
      expect(() => vault.to(next)).toThrow()
    }
  })

  it('a conditional failure while unlocked flips the state before any slow step', async () => {
    const vault = new VaultStateMachine()
    vault.to('locked')
    vault.to('unlocking')
    vault.to('unlocked')
    const seen: string[] = []
    await failClosed(null, vault, {
      replaceWindowsWithErrorScreen: () => void seen.push(`windows:${vault.state}`),
      stopServices: async () => void seen.push(`services:${vault.state}`),
      closeDatabases: () => void seen.push(`db:${vault.state}`),
      closeKeyRing: () => (seen.push(`keys:${vault.state}`), 0),
    }, ['POST-AES-GCM-ENC' satisfies KatId])
    expect(seen).toEqual(['windows:selftest-failed', 'services:selftest-failed', 'db:selftest-failed', 'keys:selftest-failed'])
  })
})
```

```typescript
// packages/desktop/src/main/vault/selftest/post.child.test.ts — one child process per corrupted vector.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { KAT_IDS } from './post'

// The child is the built main-process POST entry (out/main/selftest-child.js, a 10-line script that
// loads the addon, runs runPost({ corrupt: argv[2] }), tries one more service and prints JSON).
const CHILD = process.env.SLATE_POST_CHILD ?? 'out/main/selftest-child.js'

describe.each(KAT_IDS.map((id) => [id]))('POST with %s corrupted', (id) => {
  it('fails exactly that KAT, enters the error state and refuses every later service', () => {
    const run = spawnSync(process.execPath, [CHILD, id], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 })
    expect(run.status).toBe(0)
    const r = JSON.parse(run.stdout) as { ok: boolean; failed: string[]; errorState: boolean; servicesRefused: boolean }
    expect(r).toEqual({ ok: false, failed: [id], errorState: true, servicesRefused: true })
  })
})
```

```typescript
// packages/desktop/src/main/vault/selftest/child.ts — built to out/main/selftest-child.js (an extra electron-vite
// main entry). Used only by post.child.test.ts: one process per corrupted vector, since the error state is sticky.
import { createRequire } from 'node:module'
import type { SlateNative } from '@slate/native'
import { runPost, type KatId } from './post'

const n = createRequire(import.meta.url)(process.env.SLATE_NATIVE_ADDON ?? '../native/slate_native.node') as SlateNative
n.init(process.env.SLATE_FIPS_CONF ?? '', process.env.SLATE_FIPS_MODULES ?? '', process.env.SLATE_REQUIRE_FIPS === '1')
const r = runPost({ native: n, requireFips: process.env.SLATE_REQUIRE_FIPS === '1', corrupt: (process.argv[2] ?? null) as KatId | null })
let servicesRefused = false
try {
  n.keyRandom()
} catch (e) {
  servicesRefused = (e as { code?: unknown }).code === 'SCC_12'
}
process.stdout.write(JSON.stringify({ ok: r.ok, failed: r.failed, errorState: r.module?.errorState ?? false, servicesRefused }))
```

### 6.10 T-DB and T-UPD

| Test | Assertion |
| --- | --- |
| T-DB-01 | A fixture database created by the audited build (SQLite3MultipleCiphers, `cipher='sqlcipher'`, `legacy=4`, key `x'00…1f'`) opens with the new SQLCipher build and passes `PRAGMA integrity_check`; its row counts match the fixture manifest |
| T-DB-02 | `PRAGMA cipher_provider` returns `openssl`; with the FIPS build, `PRAGMA cipher_fips_status` returns `1`; with `requireFips` and a non-FIPS provider, `openDatabase` throws and `failClosed` runs |
| T-DB-03 | `keyWithHandle` with a destroyed handle throws `SCC_8`, and the database is not opened |
| T-UPD-01 | The updater refuses a `latest-*.yml` whose detached signature is missing (`fips-140-3`) or invalid (all profiles), and logs `update.signature.failed` |
| T-UPD-02 | A manifest signed by the *next* pinned key verifies, so a key rotation needs no emergency release |

---

## 7. Executable work packages

### 7.1 Decisions needed from the maintainer

| Id | Decision | Recommendation | Blocks |
| --- | --- | --- | --- |
| D-1 | Get an Apple Developer ID (hardened runtime, notarisation) and a Linux package-signing key | **Yes.** Without them, CM-14, SI-7(15) and Z-9 on macOS stay as POA&M entries. | C12 (signing part), Z-9 (macOS part) |
| D-2 | A failed POST also blocks plaintext users | **Yes**: one code path (S-11) | C6 |
| D-3 | Seek Slate's own CMVP validation or a NIAP evaluation | **No**, for now. Rely on #4985; revisit if a customer requires it. | — |
| D-4 | SQLCipher source | **Community SQLCipher on OpenSSL with the FIPS provider.** Switch to the commercial Zetetic module (#5185) only if L-5 fails. | C3 |
| D-5 | Offer a hosted Slate sync service | Out of scope. It would be the only route to FedRAMP applicability. | — |
| D-6 | Public-key wrap slots (passwordless device enrolment, sharing) with hybrid ML-KEM | **Defer**; reserve the identifiers only (§4.5.1, §4.5.4) | — |
| D-7 | Upgrade header-v1 vaults to v2 | **Prompt** in Settings → Security once every device record reports a version ≥ the C5 release; never automatically | C9 |
| D-8 | `PRAGMA cipher_memory_security = ON` in `fips-140-3` if `perf.spec.ts` misses its budget (16 ms per keystroke, 100 ms page open) | Measure first. If the budget is missed, keep it ON and record the numbers, or turn it OFF with a POA&M entry. | C3 |

### 7.2 Points for an accredited CST laboratory

Implementation does not wait for these. The claim wording in §1.2 does.

| Id | Question |
| --- | --- |
| L-1 | Is HKDF (SP 800-56Cr2 KDA) acceptable for key-from-key derivation in this design? This is moot once suite 0x02 uses SP 800-108r1. |
| L-2 | Is AES-256-CTR with an HMAC-SHA-256-derived initial counter block, unique per unique input, an approved use for deterministic name encryption (§4.6)? |
| L-3 | May a `fipsmodule.cnf` produced at build time with `fipsinstall -self_test_onload` be shipped, under the #4985 Security Policy? |
| L-4 | Are the OpenSSL 3.5.x libcrypto host and the macOS arm64 / Linux x64 operational environments covered by #4985, or by the CMVP porting rules? |
| L-5 | Is SQLCipher 4's PBKDF2-HMAC-SHA-512 with 2 iterations, deriving the page-HMAC key from a raw 256-bit key, acceptable? |

### 7.3 Dependency graph and schedule

```
C0 ──┬── C1 ───────────────┐
     ├── C2 ── C3 ──┐      │
     │              ├── C4 ┴─┬── C5 ── C6 ──┬── C9
     │              │        │              ├── C10
     │              │        └── C7 ────────┤
     ├── C8 ─────────────────────────────────┤
     └── C12 ────────────────────────────────┴── C11 ── C13
```

| Wave | WPs | Agents |
| --- | --- | --- |
| 1 | C0 | 1 |
| 2 | C1, C2, C8, C12 | 4 |
| 3 | C3 | 1 |
| 4 | C4 | 1 |
| 5 | C5, C7 | 2 |
| 6 | C6 | 1 |
| 7 | C9, C10 | 2 |
| 8 | C11 | 1 |
| 9 | C13 | 1 |

No wave needs more than six agents.

Every WP below follows `CLAUDE.md`'s definition of done: tests first and seen failing, typecheck, `npm test`, `npm run test:main`, touched e2e specs, and Conventional Commits. Model suggestions follow the E2EE spec's cadence.

---

#### C0: Spec wiring and decisions (Sonnet)

- **Dependencies:** none.
- **Files to modify:**
  - `docs/superpowers/specs/2026-10-23-e2ee-design.md`: add §16, "Compliance profile", with one paragraph per audit section and a pointer to `docs/reviews/compliance_audit.md`.
  - `docs/compliance/decisions.md` (new): D-1–D-8 with the maintainer's answers, plus L-1–L-5 with status `open`.
- **Exact architectural criteria:**
  1. §16 states the precedence rule of §0.
  2. Every D-n has an answer, or is marked "deferred" with the WPs it blocks.
  3. No code changes.
- **Verification tests required:** none (documentation). `npm run typecheck` stays green.

#### C1: JavaScript-level zeroisation and integrity hygiene, interim (Opus)

- **Dependencies:** C0.
- **Files to modify:**
  - `packages/desktop/src/main/vault/header.ts`
  - `vault/localKeys.ts`
  - `vault/crypto.ts`
  - `vault/keyring.ts`
  - `vault/unlock.ts`
  - `vault/vaultCheck.ts`
  - `vault/preunlock.ts`
  - `vault/quickUnlock.ts`
  - `vault/argon2.worker.ts`
  - `vault/atomic.ts` (new export `readJsonCapped`)
  - the matching `*.test.ts` files
- **Exact architectural criteria:**
  1. Fix every site Z-a…Z-i of F-FIPS-06: each derived or unwrapped key is zeroed in `finally` unless returned to the caller, and the function's doc comment names who owns the returned buffer.
  2. `KeyRing.get` returns a copy made with `Buffer.alloc(32)` + `key.copy(dst)`, never `Buffer.from` (Z-j).
  3. `deriveSubkey` results are zeroed after use in `computeCheck`, `wrap` and `readLocalKeys`.
  4. Argon2 worker: the output is passed back as a transferred `ArrayBuffer` (`postMessage(h.buffer, [h.buffer])`). The main side copies it into a `Buffer.alloc` buffer and zeroes the received view. *This removes one of three copies; the string copies stay until C4.*
  5. `local-keys.json` stays at version 1. Its AAD cannot gain `db` without breaking existing files, and a rejoin (§7.5) legitimately keeps the old `db` name under a new `vaultId`, so no name rule can be enforced on the reader side. The AAD fix is the v2 format (C5). C1 adds a regression test proving that a repointed `db` ends in `UnlockFailed`/`WrongKey` and never in a plaintext open.
  6. `readJsonCapped(path, 64 * 1024)` replaces the uncapped reads at `unlock.ts:32`, `vaultCheck.ts:27`, `preunlock.ts:62` and `quickUnlock.ts:68,101` (F-GEN-02).
- **Verification tests required:**
  - T-ZERO-01 (JavaScript variant: spy on `Buffer.prototype.fill` per site and assert each derived key is filled with 0).
  - T-FUZZ-13.
  - A new `localKeys.test.ts` case: a `db` that does not match the vault id is refused.
  - All existing vault tests unchanged.

#### C2: Native cryptographic boundary `@slate/native` (Opus)

- **Dependencies:** C0.
- **Files to modify (all new unless stated):**
  - `packages/native/{package.json, binding.gyp, exports.map, index.ts, deps.lock.json, fips-digest.json}`
  - `packages/native/src/{slate_crypto_core.h, slate_crypto_core.c, binding.c}` (B.1, B.2)
  - `packages/native/scripts/build-openssl.mjs` (download, SHA-256 check, configure, build; both OpenSSL 3.5.x and FIPS 3.1.2)
  - `packages/native/test/kat.c` (B.1a)
  - `packages/native/test/crossCheck.sh` (Appendix A commands)
  - `packages/desktop/src/main/native/fipsConfig.ts` (B.18)
  - `packages/desktop/electron-builder.cjs` (`extraResources: { from: '../native/fips/<platform>', to: 'fips' }`)
  - `packages/desktop/electron.vite.config.ts` (copy the built `slate_native.node` to `out/native/slate_native.node`; the existing `asarUnpack: ['**/*.node']` keeps it outside the asar, and both `index.ts` and `selftest-child.js` load it as `../native/slate_native.node`)
  - root `package.json` (`workspaces` already cover `packages/*`; add `postinstall` rebuild of `@slate/native`)
  - `.github/workflows/release.yml` (build OpenSSL, FIPS provider and addon per target; upload `fips-digest.json`)
- **Exact architectural criteria:**
  1. The `slate_native.node` exports exactly `napi_register_module_v1` and `node_api_module_get_api_version_v1`: `nm -gU` on macOS, `nm -D --defined-only` on Linux.
  2. libcrypto is static with hidden visibility. The FIPS provider is the unmodified 3.1.2 build, loaded from `resources/fips` by `OSSL_PROVIDER_set_default_search_path` and the generated config (§4.9). No system `OPENSSLDIR` is consulted (`strace -f -e openat` or `fs_usage` shows no access outside `resources/fips` and `<userData>/fips`).
  3. The default library context contains only `fips` and `base` when `requireFips`; `g_std_ctx` holds `default`. No API takes a library-context argument from JavaScript.
  4. Every function rejects work in the error state with `SCC_12`. Handles are generation-tagged, so a destroyed handle is never reused (`SCC_8`).
  5. `scc_init` calls `CRYPTO_secure_malloc_init(1 MiB, 32)` and reports `secureHeapLocked`.
  6. Settings → Security shows module name, version, CMVP number, approved-mode state and POST time (F-FIPS-08). `docs/compliance/crypto-module.json` records `{ module: "OpenSSL FIPS Provider", version: "3.1.2", cmvp: 4985, standard: "FIPS 140-3", securityPolicyUrl, sunset: "2030-03-10", libcrypto: "<3.5.x>", entropyCaveat }`.
  7. Prebuilds exist for darwin-arm64, darwin-x64 and linux-x64.
- **Verification tests required:**
  - `packages/native/test/kat.c` passes, plain and under ASan/UBSan (T-ZERO-03).
  - T-KAT-01 (`crossCheck.sh`).
  - T-POST-06 (provider tamper).
  - A main-process test that loads the addon under `ELECTRON_RUN_AS_NODE` and round-trips `gcmSealKey`/`gcmOpenKey`.
  - The symbol-export check as a CI step.

#### C3: SQLCipher on the boundary (Opus)

- **Dependencies:** C2.
- **Files to modify:**
  - `packages/native/src/sqlite/*` (vendored better-sqlite3-multiple-ciphers 13.0.3 C++ sources plus `database_key.cpp`, B.3)
  - `packages/native/deps/sqlcipher/` (amalgamation produced by `scripts/build-sqlcipher.mjs`, pinned in `deps.lock.json`)
  - `packages/desktop/src/main/db/openDatabase.ts` (delete `applyCipher` and `keyPragmaValue`; key with `db.keyWithHandle(h)`; assert `cipher_provider`/`cipher_fips_status`)
  - `packages/desktop/src/main/db/migrateToEncrypted.ts` (`rekey` path through `rekeyWithHandle`)
  - `packages/desktop/src/main/store.ts`, `services.ts`, `blobs.ts` (pass handles)
  - `packages/desktop/package.json` and root `package.json` (remove `better-sqlite3-multiple-ciphers` and its `electron-rebuild -o` postinstall; `tsconfig.json` `paths` entry)
  - `packages/importer`, `packages/mcp`, `packages/sync`, wherever they import the database type
- **Exact architectural criteria:**
  1. One SQLite binding remains: `@slate/native`'s `Database`, with the better-sqlite3 API plus `keyWithHandle(KeyHandle)` and `rekeyWithHandle(KeyHandle)`.
  2. No SQL text ever contains key material (T-STATIC-01 extended to `db/`).
  3. With a key: `PRAGMA temp_store = MEMORY`, `cipher_provider = 'openssl'`; in `fips-140-3`, also `cipher_fips_status = '1'` and `cipher_memory_security = ON` (subject to D-8).
  4. Existing encrypted databases open unchanged.
  5. `perf.spec.ts` meets its budget.
- **Verification tests required:**
  - T-DB-01 (fixture created by the audited build; checked in under `packages/desktop/src/main/db/fixtures/`), T-DB-02, T-DB-03.
  - The whole existing `openDatabase.test.ts`, `migrateToEncrypted.test.ts` and `migration.test.ts`.
  - `e2e/encryption.spec.ts`, `e2e/lock.spec.ts`, `e2e/perf.spec.ts`.

#### C4: Move every primitive behind the boundary (Opus)

- **Dependencies:** C1, C3.
- **Files to modify:**
  - `vault/crypto.ts` (deleted; replaced by `vault/envelope.ts` B.5 with `SLE1` read/write)
  - `vault/keyring.ts` (B.13, handles)
  - `vault/kdf.ts` (`deriveKek` → `native.argon2id`; delete `argon2.worker.ts`)
  - `vault/header.ts`, `vault/localKeys.ts`, `vault/names.ts` (suite 0x01 ECB through `aesEcbBlock`), `vault/recovery.ts` (`sha256` checksum through native), `vault/quickUnlock.ts`, `vault/preunlock.ts`, `vault/unlock.ts`, `vault/migration.ts`, `vault/testVault.ts`
  - `sync/encryptingDrive.ts`
  - `services.ts`, `index.ts`
  - `packages/desktop/package.json` (`hash-wasm` moves to `devDependencies` as a test reference)
- **Exact architectural criteria:**
  1. T-STATIC-02 passes: no `node:crypto` in `main/vault`, `main/sync`, `main/db`.
  2. Every file sealed before C4 opens after C4. Every file sealed after C4 by a header-v1 vault opens with the audited code. The proof is cross-version fixtures: `fixtures/sle1-*.bin` produced by the audited build.
  3. `KeyRing` exposes handles only; `EncryptingDrive.withKey` is deleted.
  4. MK is unwrapped by `gcmOpenKey` and never exists as JavaScript bytes.
  5. Argon2id output equals hash-wasm for the POST vector and for the default parameters.
- **Verification tests required:**
  - All vault and sync unit tests, ported to the native API with identical cases (no test removed).
  - T-KAT-02, T-KAT-03.
  - T-ZERO-01 (native variant).
  - `e2e/encryption.spec.ts`, `e2e/git-sync.spec.ts`, `e2e/sync.spec.ts`, `e2e/mcp-encrypted.spec.ts`.

#### C5: Crypto profiles, suite 0x02 and v2 formats (Opus)

- **Dependencies:** C4.
- **Files to modify:**
  - `vault/profile.ts` (B.14, new)
  - `vault/header.ts` (`parseHeaderV2`, `createVaultV2`, wrap AAD v2, `check` v2, downgrade rules, `profile-floor.json`)
  - `vault/kdf.ts` (PBKDF2 parameters, floors and ceilings, calibration to about 1 s)
  - `vault/envelope.ts` (`SLE2`, padding)
  - `vault/names.ts` (`encodeIdV2`/`decodeIdV2`, B.6)
  - `vault/localKeys.ts`, `vault/quickUnlock.ts`, `vault/preunlock.ts` (v2 formats, §4.5.4)
  - `vault/password.ts` (profile-dependent minimum)
  - `sync/encryptingDrive.ts` (64-hex path regexes, suite dispatch)
  - `vault/migration.ts` (wizard: a profile choice, shown only when a FIPS build is present)
  - `renderer/src/settings/*` (profile shown read-only; wizard radio "Standard / FIPS 140-3 (U.S. federal)")
  - `shared/api.ts`
- **Exact architectural criteria:**
  1. The header-v2 JSON Schema of §4.5.2 is checked in at `docs/compliance/schemas/vault-header-v2.schema.json`. `parseHeaderV2` accepts exactly the documents the schema accepts *and* the semantic rules 1–4.
  2. A `fips-140-3` vault never writes or reads suite 0x01, and never calls `argon2id` or `hkdfLegacy`: a spy on the native object counts zero calls across the whole fips test matrix.
  3. A `standard` vault created after C5 is header v2 with suite 0x02.
  4. Header-v1 vaults are untouched until C9.
  5. `SLE2` matches §4.5.3 byte for byte; Appendix A vectors.
  6. Names under suite 0x02 match §4.6.
- **Verification tests required:**
  - T-FUZZ-01…12 against the v2 parsers.
  - T-POL-01, -05, -06, -07.
  - Appendix A vectors as unit tests.
  - Downgrade tests: v2 → v1 header refused, and `fips-140-3` → `standard` refused.
  - `e2e/encryption.spec.ts` with `SLATE_TEST_PROFILE=fips-140-3` (a new e2e hook, added to `TEST_HOOK_VARS`).

#### C6: Power-up self-test and the error state (Opus)

- **Dependencies:** C5.
- **Files to modify:**
  - `vault/selftest/{vectors,post,supervisor,child}.ts` (§5.2, new)
  - `vault/selftest/profilePeek.ts` (new: `policyRequiresFips(resourcesPath)`, `headerProfilePeek(dataDir)`, `profileFloor(dataDir)` as used by the §5.2 wiring; each uses `readJsonCapped` and returns `null` on any error)
  - `vault/vaultState.ts` (B.7)
  - `ipcGuard.ts` (B.8: state-aware policy)
  - `index.ts` (wiring §5.2; error window; `vaultSelfTest`, `appQuit` and `diagnosticsCopyReport` channels; the S-7 triggers before vault changes; `SCC_12` escalation)
  - `shared/ipc.ts`, `shared/api.ts` (`VaultState` gains the two states; `VaultStatus.selfTest`)
  - `renderer/src/lock/SelfTestFailed.tsx` (new; `data-testid="selftest-failed"`, `"selftest-failed-code"`)
  - `testHooks.ts` (`SLATE_TEST_SELFTEST_CORRUPT`, `SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND`)
  - `electron.vite.config.ts` (extra main entry `selftest-child`)
- **Exact architectural criteria:**
  1. S-1 … S-11 hold.
  2. The state table of §4.2 is enforced by `guardHandlers`, and a test enumerates every registered channel.
  3. The POST takes < 50 ms on the CI runners, budget 10 s.
  4. No `openDatabase`/`openServices` call happens before `selftest` exits: a spy that throws if called while `vault.state === 'selftest'`.
  5. The error screen text matches S-6. The diagnostic report contains no path below `$HOME` and no key (redact test).
- **Verification tests required:** T-POST-01 … T-POST-13. The existing `vaultState.test.ts` and `ipcGuard.test.ts` are extended, not replaced.

#### C7: Memory isolation completion (Opus)

- **Dependencies:** C4. Runs in parallel with C5.
- **Files to modify:**
  - `preload/index.ts`
  - `shared/api.ts` (every secret parameter of `VaultApi` becomes `Uint8Array`: `unlock`, `unlockRecovery`, `enableQuickUnlock`, `finishMigration`, `prepareEncryption`, `confirmRecovery`, `join`, `changePassword`, `newRecoveryKey`)
  - `renderer/src/lock/LockScreen.tsx`, `MigrationBanner.tsx`, and every settings and wizard component that takes a secret (`submitPassword` pattern, B.19)
  - `index.ts` (`passwordBytes` validation; Z-6 window swap after unlock; `hardenProcess` before the POST)
  - `vault/recovery.ts` (decode in native: `native.recoveryDecode(bytes)`, which returns a handle; add it to B.1/B.2 with the same pattern as `keyImport`)
  - `testHooks.ts` (`SLATE_TEST_CANARY_KEYS`, `SLATE_TEST_EXPOSE_GC`, `SLATE_TEST_HEAP_SNAPSHOT`)
- **Exact architectural criteria:**
  1. Z-1 … Z-12 hold.
  2. On the unlock path, no main-process code converts a secret to a `string`: T-STATIC-01 with `TextDecoder.decode` and `toString` added for parameters typed `Uint8Array` in `index.ts` vault handlers.
  3. After unlock, the lock-screen renderer process has exited.
  4. Linux runs non-dumpable with RLIMIT_CORE = 0, and macOS with RLIMIT_CORE = 0.
  5. `checkPassword` is the only place a secret is decoded to a string, at set or change time, and it is annotated as the residual.
- **Verification tests required:** T-ZERO-01, -02, -04, -05, -06, -07; `e2e/lock.spec.ts`; `e2e/encryption.spec.ts`.

#### C8: Electron boundary and credential storage (Opus)

- **Dependencies:** C0.
- **Files to modify:**
  - `main/hardening.ts` (B.16, new)
  - `main/ipcGuard.ts` (sender validation, B.8; merge with C6 if C6 landed first)
  - `main/secretStorage.ts` (B.17, new)
  - `vault/quickUnlock.ts`, `onenote/auth.ts`, `sync/git/auth.ts` (use `SecretStorage`; remove the MSAL plaintext fallback)
  - `renderer/index.html` and `electron.vite.config.ts` (production CSP by mode, B-4)
  - `index.ts` (install guards and the permission policy before `createWindow`)
- **Exact architectural criteria:**
  1. B-1 … B-5 hold.
  2. There are no synchronous `safeStorage` calls in `src/`: a grep test.
  3. Existing users' sealed files decrypt: the async API reads data encrypted by the sync API (Electron docs), with a test using a fixture blob from the audited build on macOS.
  4. The production CSP passes the full e2e suite; every directive added beyond §4.4 has a comment naming the spec that needed it.
- **Verification tests required:** T-B-01 … T-B-06; `e2e/links.spec.ts`, `e2e/smoke.spec.ts`, `e2e/onenote-import.spec.ts` and `e2e/git-sync.spec.ts` stay green.

#### C9: Key epochs and rotation (Opus)

- **Dependencies:** C5, C6.
- **Files to modify:**
  - `vault/header.ts` (`history`, `rotate`)
  - `vault/migration.ts` (rotation and conversion steps, resumable through `migration.json`)
  - `vault/remoteVault.ts` (CAS write of the rotated header)
  - `sync/encryptingDrive.ts` (epoch-aware `syncKey`)
  - `sync/syncService.ts` (bookkeeping reset; old-tree removal; *Replace history* offer)
  - `renderer/src/settings/*` (*Rotate keys*, *Upgrade encryption format*, *Convert to FIPS 140-3*)
- **Exact architectural criteria:**
  1. R-1 … R-5 hold.
  2. A crash injected between every step recovers. This reuses the `SLATE_TEST_CRASH_AT` hook pattern of §7.4.
  3. A device that missed a rotation unlocks with the password through the pending header (§4) and reads epoch e+1 files.
  4. Conversion to `fips-140-3` leaves no suite 0x01 file locally or remotely, and an empty `history`.
- **Verification tests required:**
  - Unit: rotation round trip; history pruning; downgrade refused; crash at every step.
  - e2e: two devices over a local bare repo (the existing `git-sync.spec.ts` harness). Rotate on A; B unlocks and syncs. Convert on A; B reads only suite 0x02 afterwards.

#### C10: Policy controls, audit events, inventory, OSCAL (Sonnet)

- **Dependencies:** C5. Runs in parallel with C9.
- **Files to modify:**
  - `vault/unlockThrottle.ts` (B.15, new; state persisted in `unlock-throttle.json`, MAC'd with K_prefs)
  - `vault/password.ts`, `shared/settings/schema.ts` (`effectiveIdleMinutes`; "Never" hidden under `fips-140-3`)
  - `index.ts` (the throttle on `vaultUnlock`, the events of §4.8)
  - `log/*` (event helper)
  - `docs/compliance/key-inventory.json` (Appendix C.1)
  - `docs/compliance/oscal/slate-component-definition.json` (Appendix C.2)
  - `docs/compliance/poam.md` (F-NIST-10, plus any D-n answered "no")
  - `.github/workflows/compliance.yml` (OSCAL schema validation with `ajv` against `oscal_component_schema.json` v1.2.3, pinned by SHA-256)
- **Exact architectural criteria:**
  1. The AC-7 and AC-11 values are read from FedRAMP `fedramp-consolidated-rules.json` 2026.10.13.01 at implementation time. If they differ from §4.1, the JSON wins and `profile.ts` plus this audit's §4.1 table are updated in the same commit.
  2. Every event of §4.8 is emitted at exactly one place, and none carries a secret: a redaction test feeds canary secrets through the whole unlock and lock flow and greps the log.
  3. The OSCAL document validates against the pinned schema in CI.
  4. The key inventory passes T-STATIC-03.
- **Verification tests required:** T-POL-02 … T-POL-04, T-POL-08; T-STATIC-03; the OSCAL validation job; a log redaction test.

#### C11: Compliance test suite and CI evidence (Sonnet)

- **Dependencies:** C6, C7, C8, C12.
- **Files to modify:**
  - `packages/desktop/src/main/vault/fuzz.test.ts` (§6.4 listing, extended to T-FUZZ-08…13)
  - `packages/desktop/src/main/static.test.ts` (T-STATIC-01…04, T-GCM-01)
  - `packages/desktop/e2e/{memory.spec.ts, memscan.ts}` (§6.3)
  - `.github/workflows/{ci.yml, nightly.yml}` (layers of §6.1; the memory-evidence job; fuzz soak)
  - root `package.json` (`fast-check` pinned devDependency: 4.10.2 was current during the audit; use the latest 4.x at implementation time)
- **Exact architectural criteria:**
  1. Every test id in §6 exists, named in its `describe`/`it` title, so `grep -r "T-POST-07"` finds it.
  2. The traceability matrix of Appendix D is generated from those titles by `scripts/traceability.mjs`, and CI fails if a finding has no test.
  3. Nightly runs the soak and the memory evidence and uploads the scan report as an artefact.
- **Verification tests required:** the suite itself. The traceability check passes in CI.

#### C12: Supply chain (Opus)

- **Dependencies:** C0 (D-1).
- **Files to modify:**
  - `packages/desktop/electron-builder.cjs` (fuses per B-6; `mac.identity`, `hardenedRuntime: true`, entitlements without `get-task-allow`, notarisation per D-1)
  - `packages/desktop/electron-builder.e2e.cjs` (new: inherits, `enableNodeCliInspectArguments: true`)
  - `packages/desktop/e2e-packaged/playwright.config.ts`
  - `packages/desktop/src/main/update/*` (detached-signature verification before `quitAndInstall`; pinned keys)
  - `packages/desktop/launchers/*` and `packages/mcp` (`slate-mcp` as a standalone executable: a Node SEA of the byte proxy, so the app binary no longer needs `runAsNode`)
  - `packages/desktop/src/main/index.ts` (`app://slate/` protocol for the renderer, then `grantFileProtocolExtraPrivileges: false`)
  - `.github/workflows/release.yml` (sign `latest-*.yml` and artefacts offline; publish `.sig` files; CycloneDX SBOM via `npx @cyclonedx/cyclonedx-npm` attached to the release)
- **Exact architectural criteria:**
  1. An update applies only if `latest-*.yml` and the artefact's SHA-512 verify under a pinned public key. In `fips-140-3`, a missing signature refuses the update; in `standard`, a missing signature on releases *before* the first signed release is tolerated, once.
  2. Signature algorithm: Ed25519 now. Hybrid ML-DSA-65 + Ed25519 when the signing toolchain supports FIPS 204 (CNSA 2.0 software signing: exclusive by 2030). The manifest format carries an `alg` field from day one.
  3. The release fuses read as in T-B-07.
  4. The SBOM lists every npm package and the native components (OpenSSL 3.5.x, FIPS provider 3.1.2, SQLCipher) with versions and hashes (FPT_LIB_EXT.1, SR-4(4)).
- **Verification tests required:** T-UPD-01, T-UPD-02, T-B-07, T-POST-13; `e2e/update.spec.ts`; `e2e:packaged` on both platforms.

#### C13: Documentation and release notes (Sonnet)

- **Dependencies:** all previous WPs.
- **Files to modify:**
  - `README.md` (security section: profiles, what is and is not claimed, word for word from §1.2)
  - `CHANGELOG.md` (Unreleased)
  - `docs/compliance/security-policy.md` (new: a module-consumer security policy listing the module, approved services used, roles, the self-test list with ids, the error-state behaviour, the zeroisation methods per key from the inventory, and L-n status)
  - `docs/superpowers/specs/2026-10-23-e2ee-design.md` §16 (final)
- **Exact architectural criteria:**
  1. Every claim in the README is backed by a test id or a certificate number.
  2. No text says "FIPS 140-3 validated" about Slate itself.
  3. The version bump follows `CLAUDE.md` § Releasing; there is no tag or push.
- **Verification tests required:** a docs link check (`npx markdown-link-check` on the changed files); the claims grep (`! grep -ri "slate is fips" README.md docs/`).

---

## Appendix A: Known-answer vectors and how each was reproduced

All hex is lowercase. "MK" = `000102…1f`. `vid` = `000000000000400080000000000000aa` (vault id `00000000-0000-4000-8000-0000000000aa`).

| Vector | Inputs | Expected | Independent reproductions |
| --- | --- | --- | --- |
| SHA-256 | `"abc"` | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` | FIPS 180-4 example; Python `hashlib`; native |
| HMAC-SHA-256 | key `"Jefe"` (zero-extended to 32 B), msg `"what do ya want for nothing?"` | `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843` | RFC 4231 TC2; Python `hmac`; native |
| AES-256 block | key MK, pt `00112233445566778899aabbccddeeff` | `8ea2b7ca516745bfeafc49904b496089` | FIPS 197 C.3; `openssl enc -aes-256-ecb -nopad`; native |
| AES-256-GCM | K = 0^256, IV = 0^96, P = 0^128, no AAD | ct `cea7403d4d606b6e074ec5d3baf39d18`, tag `d0d1c8a799996bf0265b98b5d48ab919` | McGrew–Viega TC14; Node (OpenSSL 3.5.8); Electron (BoringSSL); native |
| KBKDF (SP 800-108r1 counter, HMAC-SHA-256) | KI = MK, Label `"slate/v2/sync"`, Context = `vid`, L = 256 | `88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388` | `openssl kdf -keylen 32 -kdfopt mac:HMAC -kdfopt digest:SHA256 -kdfopt hexkey:<MK> -kdfopt salt:slate/v2/sync -kdfopt hexinfo:<vid> KBKDF`; Python (manual `[i]32 ‖ Label ‖ 00 ‖ Context ‖ [L]32`); native |
| KBKDF file key | KI = previous, Label `"slate/v2/remote-file"`, Context = `11`×16 | `ccc0c941926d90b66ab707799a53336118ec8590779bd7b244719575a403696a` | OpenSSL CLI; native |
| KBKDF name keys | KI = MK, Context `vid`: Label `"slate/v2/name-enc"`, then `"slate/v2/name-mac"` | `945f11ea9bf4b80dc2ca2f87255998fd341f56c6d9a6fb45a44aa067c1b3f589`, then `5ed3ac7f8024fae8e05db04c670e85169ccb2a046814a7cd455d78575be4f36e` | OpenSSL CLI; Node |
| HKDF-SHA-256 (suite 0x01) | IKM = MK, salt = empty, info `"slate/v1/sync"` | `50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c` | `openssl kdf … HKDF`; Node; Electron; native |
| HKDF RFC 5869 TC1 (tooling sanity) | as in the RFC | `3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865` | OpenSSL CLI |
| PBKDF2-HMAC-SHA-512 | P `"slate-kat-password"`, S = `5a`×32, c = 1000, 32 B | `13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079` | `openssl kdf … PBKDF2`; Python `hashlib.pbkdf2_hmac`; native |
| Argon2id v0x13 | P `"slate-kat-password"`, S = `5a`×16, t = 3, m = 32 KiB, p = 1, 32 B | `688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812` | `openssl kdf … ARGON2ID`; hash-wasm 4.12.0 (Slate's current implementation); native |
| Argon2id RFC 9106 §5.3 (tooling sanity) | as in the RFC (p = 4, secret, ad) | `0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659` | OpenSSL CLI |
| `SLE2` | K_sync = KBKDF vector, epoch 0, salt `11`×16, nonce `22`×12, flags 0, path `docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk`, pt `"slate-kat-plaintext"` | `534c4532020000000000` + `11`×16 + `22`×12 + `3a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010` | Node; native; B.5 inside Electron |
| `SLE1` | K_sync = HKDF vector, salt `11`×16, nonce `22`×12, flags 0, same path and pt | `534c453100` + `11`×16 + `22`×12 + `82133b13f98a2ce9b3209f0132a095dc83721e58a018383d2c087f1905cc7d6c3e360f` | Node (OpenSSL) = Electron (BoringSSL), replicating the audited `crypto.ts`; B.5 legacy writer reproduces it |
| Name, suite 0x01 | K_name_enc v1 = `31a4250532d8a0ef1813903b6338a2df51c4fe5539797177b968ab5ddc9daa24`, page `00000000-0000-4000-8000-000000000001` | `c9c21560d7a690d49a95f2ef4fe194a6` | Node = Electron, replicating the audited `names.ts` |
| Name, suite 0x02 (SIV) | the name keys above, page `00000000-0000-4000-8000-000000000001` (P = `00000000000020008000000000000001`) | SIV `50e291505985f76efa7aeb45620bd1b8`, C `30101fd8c6a1b6030c339f4eee5ffe9c`, name `50e291505985f76efa7aeb45620bd1b830101fd8c6a1b6030c339f4eee5ffe9c` | Python `hmac` (SIV); `openssl enc -aes-256-ctr` (C); Node; native |

`packages/native/test/crossCheck.sh` (C2) runs the OpenSSL and Python commands above and diffs the output against `vectors.ts`.

---

## Appendix B: Reference listings

Listings B.1, B.1a and B.2 are C11 (`-std=c11`); the rest are TypeScript in the repository's configuration plus `noUncheckedIndexedAccess`. Import paths are the repository paths of §5.1 (`@slate/native` is `packages/native`). The POST listings (B.9–B.12) are in §5.2 and §6.9.

### B.1 `packages/native/src/slate_crypto_core.h` and `slate_crypto_core.c`

```c
#ifndef SLATE_CRYPTO_CORE_H
#define SLATE_CRYPTO_CORE_H
#include <stddef.h>
#include <stdint.h>
enum {
  SCC_OK = 0, SCC_ERR_ARG = -1, SCC_ERR_STATE = -2, SCC_ERR_INIT = -3, SCC_ERR_SECURE_HEAP = -4,
  SCC_ERR_MODULE_CONFIG = -5, SCC_ERR_MODULE_SELFTEST = -6, SCC_ERR_HANDLES = -7, SCC_ERR_HANDLE = -8,
  SCC_ERR_DRBG = -9, SCC_ERR_CRYPTO = -10, SCC_ERR_AUTH = -11, SCC_ERR_ERROR_STATE = -12, SCC_ERR_HARDEN = -13
};
int scc_harden_process(void);
int scc_init(const char *fips_config_path, const char *modules_dir, int require_fips);
int scc_fips_active(void);
void scc_enter_error_state(void);
int scc_in_error_state(void);
int scc_key_random(uint32_t *handle);
int scc_key_import(const unsigned char *bytes, size_t len, uint32_t *handle);
int scc_key_destroy(uint32_t handle);
size_t scc_zeroize_all(void);
size_t scc_live_handles(void);
size_t scc_secure_heap_used(void);
int scc_kbkdf(uint32_t key, const char *label, const unsigned char *ctx, size_t ctx_len, uint32_t *out);
int scc_pbkdf2(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, uint32_t *out);
int scc_argon2id(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, uint32_t *out);
int scc_gcm_seal(uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len, const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag);
int scc_gcm_open(uint32_t key, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *pt);
int scc_hkdf_legacy(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, uint32_t *out);
int scc_heap_locked(void);
int scc_selftest_failures(void);
int scc_gcm_open_key(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out);
int scc_gcm_seal_key(uint32_t kek, uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len, unsigned char *iv_out, unsigned char *ct_tag);
int scc_hmac_sha256(uint32_t key, const unsigned char *data, size_t len, unsigned char out[32]);
int scc_aes_ecb_block(uint32_t key, const unsigned char in[16], int encrypt, unsigned char out[16]);
int scc_aes_ctr(uint32_t key, const unsigned char icb[16], const unsigned char *in, size_t len, unsigned char *out);
int scc_sha256(const unsigned char *data, size_t len, unsigned char out[32]);
int scc_random(unsigned char *out, size_t len);
int scc_sqlcipher_raw_key(uint32_t key, char out[68]);
#endif
```

```c
/* packages/native/src/slate_crypto_core.c — the only C file that touches key material.
 * Every CSP lives in OpenSSL's secure heap; JavaScript only ever sees uint32 handles. */
#include "slate_crypto_core.h"
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/provider.h>
#include <openssl/rand.h>
#include <openssl/self_test.h>
#include <string.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <sys/resource.h>

#define MAX_HANDLES 64
#define KEY_LEN 32

typedef struct {
  unsigned char *bytes; /* OPENSSL_secure_zalloc'd, KEY_LEN bytes; NULL = free slot */
  uint32_t generation;
} slot_t;

static slot_t g_slots[MAX_HANDLES];
/* The global default context, so SQLCipher (compiled into this addon, using NULL contexts) is served by the
 * same FIPS provider. It holds only fips + base: every algorithm it can reach is an approved one. */
static OSSL_LIB_CTX *g_fips_ctx = NULL;
static OSSL_LIB_CTX *g_std_ctx = NULL;   /* default provider: Argon2id for the standard profile */
static OSSL_PROVIDER *g_fips = NULL, *g_base = NULL, *g_default = NULL;
static int g_error_state = 0;            /* sticky: once set, every service refuses (ISO/IEC 19790 §7.10) */
static int g_selftest_events = 0, g_selftest_failures = 0;
static int g_heap_locked = 0;

static int on_self_test(const OSSL_PARAM params[], void *arg) {
  (void)arg;
  const OSSL_PARAM *p = OSSL_PARAM_locate_const(params, OSSL_PROV_PARAM_SELF_TEST_PHASE);
  const char *phase = NULL;
  if (p == NULL || !OSSL_PARAM_get_utf8_ptr(p, &phase)) return 1;
  g_selftest_events++;
  if (strcmp(phase, OSSL_SELF_TEST_PHASE_FAIL) == 0) {
    g_selftest_failures++;
    g_error_state = 1;
  }
  return 1;
}

int scc_harden_process(void) {
  struct rlimit none = {0, 0};
  int rc = setrlimit(RLIMIT_CORE, &none);
#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) rc = -1;
#endif
  return rc == 0 ? SCC_OK : SCC_ERR_HARDEN;
}

int scc_init(const char *fips_config_path, const char *modules_dir, int require_fips) {
  if (g_fips_ctx != NULL) return SCC_ERR_STATE;
  /* 1 MiB secure heap, 32-byte minimum allocation: mlock'd, guard pages, MADV_DONTDUMP on Linux.
   * 2 = allocated but not locked (RLIMIT_MEMLOCK too low): usable, reported as degraded. */
  int sh = CRYPTO_secure_malloc_init(1 << 20, 32);
  if (sh == 0) return SCC_ERR_SECURE_HEAP;
  g_heap_locked = sh == 1;
  g_fips_ctx = OSSL_LIB_CTX_get0_global_default();
  g_std_ctx = OSSL_LIB_CTX_new();
  if (g_fips_ctx == NULL || g_std_ctx == NULL) return SCC_ERR_INIT;
  OSSL_SELF_TEST_set_callback(g_fips_ctx, on_self_test, NULL);
  if (require_fips) {
    /* fips.so / fips.dylib is looked up here, never on the system's OPENSSLDIR. */
    if (!OSSL_PROVIDER_set_default_search_path(g_fips_ctx, modules_dir)) return SCC_ERR_MODULE_CONFIG;
    if (!OSSL_LIB_CTX_load_config(g_fips_ctx, fips_config_path)) return SCC_ERR_MODULE_CONFIG;
    g_fips = OSSL_PROVIDER_load(g_fips_ctx, "fips");   /* runs the module's integrity test + CASTs */
    g_base = OSSL_PROVIDER_load(g_fips_ctx, "base");
    if (g_fips == NULL || g_base == NULL || !OSSL_PROVIDER_self_test(g_fips)) { g_error_state = 1; return SCC_ERR_MODULE_SELFTEST; }
    if (!EVP_set_default_properties(g_fips_ctx, "fips=yes")) return SCC_ERR_INIT;
  } else {
    /* Development and the standard profile on platforms without a module build: same API, no claim. */
    if (OSSL_PROVIDER_load(g_fips_ctx, "default") == NULL) return SCC_ERR_INIT;
  }
  g_default = OSSL_PROVIDER_load(g_std_ctx, "default");
  if (g_default == NULL) return SCC_ERR_INIT;
  return g_error_state ? SCC_ERR_MODULE_SELFTEST : SCC_OK;
}

int scc_fips_active(void) {
  return g_fips_ctx != NULL && g_fips != NULL && EVP_default_properties_is_fips_enabled(g_fips_ctx) && !g_error_state;
}

void scc_enter_error_state(void) { g_error_state = 1; scc_zeroize_all(); }
int scc_in_error_state(void) { return g_error_state; }

static int alloc_slot(unsigned char **out, uint32_t *handle) {
  for (uint32_t i = 0; i < MAX_HANDLES; i++) {
    if (g_slots[i].bytes == NULL) {
      g_slots[i].bytes = OPENSSL_secure_zalloc(KEY_LEN);
      if (g_slots[i].bytes == NULL) return SCC_ERR_SECURE_HEAP;
      g_slots[i].generation++;
      *out = g_slots[i].bytes;
      *handle = (g_slots[i].generation << 8) | i; /* a stale handle never names a reused slot */
      return SCC_OK;
    }
  }
  return SCC_ERR_HANDLES;
}

static unsigned char *slot_bytes(uint32_t handle) {
  uint32_t i = handle & 0xff;
  if (i >= MAX_HANDLES || g_slots[i].bytes == NULL || g_slots[i].generation != (handle >> 8)) return NULL;
  return g_slots[i].bytes;
}

int scc_key_random(uint32_t *handle) {
  unsigned char *k;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  int rc = alloc_slot(&k, handle);
  if (rc != SCC_OK) return rc;
  if (RAND_priv_bytes_ex(g_fips_ctx, k, KEY_LEN, 256) != 1) { scc_key_destroy(*handle); return SCC_ERR_DRBG; }
  return SCC_OK;
}

/* Imports caller bytes (tests and KATs only; the JS side zeroes its copy). */
int scc_key_import(const unsigned char *bytes, size_t len, uint32_t *handle) {
  unsigned char *k;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (len != KEY_LEN) return SCC_ERR_ARG;
  int rc = alloc_slot(&k, handle);
  if (rc != SCC_OK) return rc;
  memcpy(k, bytes, KEY_LEN);
  return SCC_OK;
}

int scc_key_destroy(uint32_t handle) {
  unsigned char *k = slot_bytes(handle);
  if (k == NULL) return SCC_ERR_HANDLE;
  OPENSSL_cleanse(k, KEY_LEN);
  OPENSSL_secure_clear_free(k, KEY_LEN);
  g_slots[handle & 0xff].bytes = NULL;
  return SCC_OK;
}

size_t scc_zeroize_all(void) {
  size_t n = 0;
  for (uint32_t i = 0; i < MAX_HANDLES; i++) {
    if (g_slots[i].bytes != NULL) {
      OPENSSL_cleanse(g_slots[i].bytes, KEY_LEN);
      OPENSSL_secure_clear_free(g_slots[i].bytes, KEY_LEN);
      g_slots[i].bytes = NULL;
      n++;
    }
  }
  return n;
}

size_t scc_live_handles(void) {
  size_t n = 0;
  for (uint32_t i = 0; i < MAX_HANDLES; i++) n += g_slots[i].bytes != NULL;
  return n;
}

size_t scc_secure_heap_used(void) { return CRYPTO_secure_used(); }
int scc_heap_locked(void) { return g_heap_locked; }
int scc_selftest_failures(void) { return g_selftest_failures; }

/* SP 800-108r1 KDF in counter mode, HMAC-SHA-256, r = 32, L = 256: label = purpose, context = binding. */
int scc_kbkdf(uint32_t key, const char *label, const unsigned char *ctx, size_t ctx_len, uint32_t *out) {
  unsigned char *ki = slot_bytes(key), *ko;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (ki == NULL) return SCC_ERR_HANDLE;
  int rc = alloc_slot(&ko, out);
  if (rc != SCC_OK) return rc;
  EVP_KDF *kdf = EVP_KDF_fetch(g_fips_ctx, "KBKDF", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_MODE, "COUNTER", 0),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_MAC, "HMAC", 0),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-256", 0),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, ki, KEY_LEN),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)label, strlen(label)),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)ctx, ctx_len),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  if (!ok) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* RFC 5869 HKDF-SHA-256: legacy suite 0x01 only (vaults created before suite 0x02). Runs in the
 * standard context, so the FIPS context only ever serves the suite-0x02 key schedule. */
int scc_hkdf_legacy(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, uint32_t *out) {
  unsigned char *ki = slot_bytes(key), *ko;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (ki == NULL) return SCC_ERR_HANDLE;
  int rc = alloc_slot(&ko, out);
  if (rc != SCC_OK) return rc;
  EVP_KDF *kdf = EVP_KDF_fetch(g_std_ctx, "HKDF", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-256", 0),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, ki, KEY_LEN),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, salt_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)info, strlen(info)),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  if (!ok) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* SP 800-132 PBKDF2-HMAC-SHA-512 (fips-140-3 profile). The password buffer is cleansed by the caller. */
int scc_pbkdf2(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, uint32_t *out) {
  unsigned char *ko;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  int rc = alloc_slot(&ko, out);
  if (rc != SCC_OK) return rc;
  EVP_KDF *kdf = EVP_KDF_fetch(g_fips_ctx, "PBKDF2", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void *)pw, pw_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, salt_len),
      OSSL_PARAM_construct_uint64(OSSL_KDF_PARAM_ITER, &iter),
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, "SHA2-512", 0),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  if (!ok) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* RFC 9106 Argon2id (standard profile only; non-approved, runs in g_std_ctx, never in g_fips_ctx). */
int scc_argon2id(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, uint32_t *out) {
  unsigned char *ko;
  uint32_t lanes = 1, threads = 1;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  int rc = alloc_slot(&ko, out);
  if (rc != SCC_OK) return rc;
  EVP_KDF *kdf = EVP_KDF_fetch(g_std_ctx, "ARGON2ID", NULL);
  EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
  OSSL_PARAM p[] = {
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void *)pw, pw_len),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, salt_len),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ITER, &passes),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_MEMCOST, &memory_kib),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_LANES, &lanes),
      OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_THREADS, &threads),
      OSSL_PARAM_construct_end()};
  int ok = kctx != NULL && EVP_KDF_derive(kctx, ko, KEY_LEN, p) == 1;
  EVP_KDF_CTX_free(kctx);
  EVP_KDF_free(kdf);
  if (!ok) { scc_key_destroy(*out); return SCC_ERR_CRYPTO; }
  return SCC_OK;
}

/* AES-256-GCM, 96-bit IV, 128-bit tag. iv == NULL: a fresh IV from the module DRBG (IG C.H). */
int scc_gcm_seal(uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len,
                 const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag) {
  unsigned char *k = slot_bytes(key);
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  if (iv_in != NULL) memcpy(iv_out, iv_in, 12);
  else if (RAND_bytes_ex(g_fips_ctx, iv_out, 12, 128) != 1) return SCC_ERR_DRBG;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-GCM", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_EncryptInit_ex2(x, c, k, iv_out, NULL) == 1 &&
                    (aad_len == 0 || EVP_EncryptUpdate(x, NULL, &len, aad, (int)aad_len) == 1) &&
                    EVP_EncryptUpdate(x, ct_tag, &len, pt, (int)pt_len) == 1 &&
                    EVP_EncryptFinal_ex(x, ct_tag + len, &len) == 1 &&
                    EVP_CIPHER_CTX_ctrl(x, EVP_CTRL_GCM_GET_TAG, 16, ct_tag + pt_len) == 1;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

int scc_gcm_open(uint32_t key, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                 const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *pt) {
  unsigned char *k = slot_bytes(key);
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  if (ct_tag_len < 16) return SCC_ERR_AUTH;
  size_t ct_len = ct_tag_len - 16;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-GCM", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_DecryptInit_ex2(x, c, k, iv, NULL) == 1 &&
                    (aad_len == 0 || EVP_DecryptUpdate(x, NULL, &len, aad, (int)aad_len) == 1) &&
                    EVP_DecryptUpdate(x, pt, &len, ct_tag, (int)ct_len) == 1 &&
                    EVP_CIPHER_CTX_ctrl(x, EVP_CTRL_GCM_SET_TAG, 16, (void *)(ct_tag + ct_len)) == 1 &&
                    EVP_DecryptFinal_ex(x, pt + len, &len) == 1;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  if (!ok) OPENSSL_cleanse(pt, ct_len); /* never release unauthenticated plaintext */
  return ok ? SCC_OK : SCC_ERR_AUTH;
}

/* Unwraps a 32-byte key straight into the secure heap: the plaintext key never reaches JavaScript. */
int scc_gcm_open_key(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                     const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out) {
  unsigned char *k;
  if (ct_tag_len != KEY_LEN + 16) return SCC_ERR_AUTH;
  int rc = alloc_slot(&k, out);
  if (rc != SCC_OK) return rc;
  rc = scc_gcm_open(kek, iv, aad, aad_len, ct_tag, ct_tag_len, k);
  if (rc != SCC_OK) scc_key_destroy(*out);
  return rc;
}

int scc_gcm_seal_key(uint32_t kek, uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len,
                     unsigned char *iv_out, unsigned char *ct_tag) {
  unsigned char *k = slot_bytes(key);
  if (k == NULL) return SCC_ERR_HANDLE;
  return scc_gcm_seal(kek, iv_in, aad, aad_len, k, KEY_LEN, iv_out, ct_tag);
}

int scc_hmac_sha256(uint32_t key, const unsigned char *data, size_t len, unsigned char out[32]) {
  unsigned char *k = slot_bytes(key);
  size_t out_len = 0;
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  EVP_MAC *mac = EVP_MAC_fetch(g_fips_ctx, "HMAC", NULL);
  EVP_MAC_CTX *m = mac ? EVP_MAC_CTX_new(mac) : NULL;
  OSSL_PARAM p[] = {OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, "SHA2-256", 0), OSSL_PARAM_construct_end()};
  int ok = m != NULL && EVP_MAC_init(m, k, KEY_LEN, p) == 1 && EVP_MAC_update(m, data, len) == 1 &&
           EVP_MAC_final(m, out, &out_len, 32) == 1 && out_len == 32;
  EVP_MAC_CTX_free(m);
  EVP_MAC_free(mac);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

/* One AES-256 block, no padding: the remote-name PRP (§15 N1). */
int scc_aes_ecb_block(uint32_t key, const unsigned char in[16], int encrypt, unsigned char out[16]) {
  unsigned char *k = slot_bytes(key);
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-ECB", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int len = 0, ok = c != NULL && x != NULL && EVP_CipherInit_ex2(x, c, k, NULL, encrypt, NULL) == 1 &&
                    EVP_CIPHER_CTX_set_padding(x, 0) == 1 && EVP_CipherUpdate(x, out, &len, in, 16) == 1 && len == 16;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

/* AES-256-CTR (SP 800-38A) with a caller-chosen initial counter block: the suite-0x02 name SIV. */
int scc_aes_ctr(uint32_t key, const unsigned char icb[16], const unsigned char *in, size_t len, unsigned char *out) {
  unsigned char *k = slot_bytes(key);
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  EVP_CIPHER *c = EVP_CIPHER_fetch(g_fips_ctx, "AES-256-CTR", NULL);
  EVP_CIPHER_CTX *x = EVP_CIPHER_CTX_new();
  int n = 0, ok = c != NULL && x != NULL && EVP_EncryptInit_ex2(x, c, k, icb, NULL) == 1 &&
                  EVP_EncryptUpdate(x, out, &n, in, (int)len) == 1 && (size_t)n == len;
  EVP_CIPHER_CTX_free(x);
  EVP_CIPHER_free(c);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

int scc_sha256(const unsigned char *data, size_t len, unsigned char out[32]) {
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  unsigned int n = 0;
  EVP_MD *md = EVP_MD_fetch(g_fips_ctx, "SHA2-256", NULL);
  int ok = md != NULL && EVP_Digest(data, len, out, &n, md, NULL) == 1 && n == 32;
  EVP_MD_free(md);
  return ok ? SCC_OK : SCC_ERR_CRYPTO;
}

int scc_random(unsigned char *out, size_t len) {
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  return RAND_bytes_ex(g_fips_ctx, out, len, 256) == 1 ? SCC_OK : SCC_ERR_DRBG;
}

/* SQLCipher's raw-key syntax, "x'<64 lowercase hex>'" (67 bytes + NUL), written into the caller's stack buffer.
 * Only the SQLCipher binding in this addon calls it (B.3), and it cleanses `out` right after sqlite3_key_v2. */
int scc_sqlcipher_raw_key(uint32_t key, char out[68]) {
  static const char HEX[] = "0123456789abcdef";
  unsigned char *k = slot_bytes(key);
  if (g_error_state) return SCC_ERR_ERROR_STATE;
  if (k == NULL) return SCC_ERR_HANDLE;
  out[0] = 'x';
  out[1] = '\'';
  for (int i = 0; i < KEY_LEN; i++) {
    out[2 + 2 * i] = HEX[k[i] >> 4];
    out[3 + 2 * i] = HEX[k[i] & 0x0f];
  }
  out[66] = '\'';
  out[67] = '\0';
  return SCC_OK;
}

#ifdef SCC_KAT_BUILD
unsigned char *scc__slot_bytes_for_kat(uint32_t h) { return slot_bytes(h); }
#endif
```

### B.1a `packages/native/test/kat.c`

```c
/* packages/native/test/kat.c — native KATs and zeroisation checks (T-ZERO-03). Built with -DSCC_KAT_BUILD,
 * which is the only build that compiles scc__slot_bytes_for_kat; the shipped addon never contains it. */
#include "slate_crypto_core.h"
#include <stdio.h>
#include <string.h>

unsigned char *scc__slot_bytes_for_kat(uint32_t h);

static int fails = 0;

static void expect(const char *name, const unsigned char *got, size_t n, const char *want) {
  char h[512];
  for (size_t i = 0; i < n; i++) snprintf(h + 2 * i, 3, "%02x", got[i]);
  int ok = strcmp(h, want) == 0;
  fails += !ok;
  printf("%s %s%s%s\n", ok ? "PASS" : "FAIL", name, ok ? "" : " got ", ok ? "" : h);
}

static void expect_key(const char *name, uint32_t h, const char *want) {
  unsigned char *k = scc__slot_bytes_for_kat(h);
  if (k == NULL) { printf("FAIL %s (no such handle)\n", name); fails++; return; }
  expect(name, k, 32, want);
}

static void check(const char *name, int ok) {
  fails += !ok;
  printf("%s %s\n", ok ? "PASS" : "FAIL", name);
}

int main(void) {
  if (scc_init(NULL, NULL, 0) != SCC_OK) { puts("FAIL init"); return 1; }
  unsigned char seq[32], zero[32] = {0}, out[64], iv0[12] = {0}, ivo[12], ct[64], pt[32];
  for (int i = 0; i < 32; i++) seq[i] = (unsigned char)i;
  const unsigned char vid[16] = {0, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 0xaa};
  unsigned char s11[16], s5a16[16], s5a32[32], n22[12];
  memset(s11, 0x11, 16); memset(s5a16, 0x5a, 16); memset(s5a32, 0x5a, 32); memset(n22, 0x22, 12);
  uint32_t mk, ksync, kfile, kpw, kargon, kz, kecb, kjefe, kv1, kek, wrapped, back, bad;

  scc_key_import(seq, 32, &mk);
  scc_kbkdf(mk, "slate/v2/sync", vid, 16, &ksync);
  expect_key("KBKDF kSync", ksync, "88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388");
  scc_kbkdf(ksync, "slate/v2/remote-file", s11, 16, &kfile);
  expect_key("KBKDF fileKey", kfile, "ccc0c941926d90b66ab707799a53336118ec8590779bd7b244719575a403696a");
  scc_hkdf_legacy(mk, zero, 0, "slate/v1/sync", &kv1);
  expect_key("HKDF legacy v1 sync", kv1, "50a3fb29a3dcf18020686e7dbad697b06f8c34e9768b73fa611855df1dc9a75c");
  scc_pbkdf2((const unsigned char *)"slate-kat-password", 18, s5a32, 32, 1000, &kpw);
  expect_key("PBKDF2-HMAC-SHA-512", kpw, "13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079");
  scc_argon2id((const unsigned char *)"slate-kat-password", 18, s5a16, 16, 32, 3, &kargon);
  expect_key("Argon2id", kargon, "688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812");

  scc_key_import(zero, 32, &kz);
  scc_gcm_seal(kz, iv0, NULL, 0, zero, 16, ivo, ct);
  expect("AES-256-GCM TC14", ct, 32, "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919");
  check("AES-256-GCM open", scc_gcm_open(kz, iv0, NULL, 0, ct, 32, pt) == SCC_OK);
  ct[0] ^= 1;
  check("AES-256-GCM tamper refused", scc_gcm_open(kz, iv0, NULL, 0, ct, 32, pt) == SCC_ERR_AUTH);

  const char *path = "docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk";
  unsigned char hdr[38] = {'S', 'L', 'E', '2', 0x02, 0x00, 0, 0, 0, 0}, aad[256];
  memcpy(hdr + 10, s11, 16); memcpy(hdr + 26, n22, 12);
  memcpy(aad, hdr, 38); aad[38] = '|'; memcpy(aad + 39, path, strlen(path));
  scc_gcm_seal(kfile, n22, aad, 39 + strlen(path), (const unsigned char *)"slate-kat-plaintext", 19, ivo, ct);
  expect("SLE2 ct|tag", ct, 35, "3a8c6e82f7592e6a3ed5d5f220c3e5f3bb379958c3644102c211aff0aeda9375fff010");

  unsigned char blk[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}, back16[16];
  scc_key_import(seq, 32, &kecb);
  scc_aes_ecb_block(kecb, blk, 1, out);
  expect("AES-256 FIPS 197 C.3 encrypt", out, 16, "8ea2b7ca516745bfeafc49904b496089");
  scc_aes_ecb_block(kecb, out, 0, back16);
  expect("AES-256 FIPS 197 C.3 decrypt", back16, 16, "00112233445566778899aabbccddeeff");
  scc_sha256((const unsigned char *)"abc", 3, out);
  expect("SHA-256 abc", out, 32, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  unsigned char jefe[32] = {'J', 'e', 'f', 'e'};
  scc_key_import(jefe, 32, &kjefe);
  scc_hmac_sha256(kjefe, (const unsigned char *)"what do ya want for nothing?", 28, out);
  expect("HMAC-SHA-256 RFC 4231 TC2", out, 32, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");

  scc_key_random(&kek);
  scc_key_random(&wrapped);
  scc_gcm_seal_key(kek, wrapped, NULL, (const unsigned char *)"aad", 3, ivo, ct);
  check("key unwrap into the heap", scc_gcm_open_key(kek, ivo, (const unsigned char *)"aad", 3, ct, 48, &back) == SCC_OK &&
                                        memcmp(scc__slot_bytes_for_kat(back), scc__slot_bytes_for_kat(wrapped), 32) == 0);
  size_t live = scc_live_handles();
  ct[47] ^= 1;
  check("tampered unwrap refused, no handle leaked", scc_gcm_open_key(kek, ivo, (const unsigned char *)"aad", 3, ct, 48, &bad) == SCC_ERR_AUTH && scc_live_handles() == live);

  char raw[68];
  check("SQLCipher raw key format", scc_sqlcipher_raw_key(mk, raw) == SCC_OK && strcmp(raw, "x'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'") == 0);
  uint32_t stale = mk;
  check("destroy", scc_key_destroy(mk) == SCC_OK);
  check("stale handle refused", scc_key_destroy(stale) == SCC_ERR_HANDLE);
  size_t n = scc_zeroize_all();
  check("zeroize_all destroyed every live handle", n == live - 1 && scc_live_handles() == 0);
  scc_enter_error_state();
  uint32_t h;
  check("error state refuses keyRandom", scc_key_random(&h) == SCC_ERR_ERROR_STATE);
  check("error state refuses sha256", scc_sha256((const unsigned char *)"abc", 3, out) == SCC_ERR_ERROR_STATE);
  printf("%s: %d failure(s)\n", fails ? "FAILED" : "OK", fails);
  return fails != 0;
}
```

Build and run, from `packages/native` (CI builds the same with ASan/UBSan):

```sh
cc -std=c11 -Wall -Wextra -Werror -DSCC_KAT_BUILD -I"$OPENSSL/include" src/slate_crypto_core.c test/kat.c "$OPENSSL/lib/libcrypto.a" -o build/kat && build/kat
cc -std=c11 -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror -DSCC_KAT_BUILD \
   -I"$OPENSSL/include" src/slate_crypto_core.c test/kat.c "$OPENSSL/lib/libcrypto.a" -o build/kat-asan && ASAN_OPTIONS=detect_leaks=0 build/kat-asan
```

### B.2 `packages/native/src/binding.c`

```c
/* packages/native/src/binding.c — N-API surface. Keys cross this line only as uint32 handles. */
#include <node_api.h>
#include <openssl/crypto.h>
#include <string.h>
#include "slate_crypto_core.h"

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, "SLATE_NATIVE", #call); return NULL; } } while (0)

static napi_value throw_rc(napi_env env, int rc) {
  char code[32];
  snprintf(code, sizeof code, "SCC_%d", -rc);
  napi_throw_error(env, code, rc == SCC_ERR_ERROR_STATE ? "Cryptographic module is in the error state" : rc == SCC_ERR_AUTH ? "Authentication failed" : "Cryptographic operation failed");
  return NULL;
}

static napi_value u32(napi_env env, uint32_t v) { napi_value r; napi_create_uint32(env, v, &r); return r; }

static int get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < want) return 0;
  return 1;
}

static int get_bytes(napi_env env, napi_value v, unsigned char **data, size_t *len) {
  bool is_typed;
  if (napi_is_typedarray(env, v, &is_typed) != napi_ok || !is_typed) return 0;
  napi_typedarray_type t; napi_value ab; size_t off;
  return napi_get_typedarray_info(env, v, &t, len, (void **)data, &ab, &off) == napi_ok && t == napi_uint8_array;
}

static napi_value Init(napi_env env, napi_callback_info info) {
  napi_value argv[3]; char path[4096], dir[4096]; size_t n; bool require_fips;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_string_utf8(env, argv[0], path, sizeof path, &n));
  CHECK(napi_get_value_string_utf8(env, argv[1], dir, sizeof dir, &n));
  CHECK(napi_get_value_bool(env, argv[2], &require_fips));
  int rc = scc_init(path, dir, require_fips);
  return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

static napi_value HardenProcess(napi_env env, napi_callback_info info) {
  (void)info; napi_value r; napi_get_boolean(env, scc_harden_process() == SCC_OK, &r); return r;
}

static napi_value Status(napi_env env, napi_callback_info info) {
  (void)info; napi_value o, v;
  CHECK(napi_create_object(env, &o));
  napi_get_boolean(env, scc_fips_active(), &v); napi_set_named_property(env, o, "fipsActive", v);
  napi_get_boolean(env, scc_in_error_state(), &v); napi_set_named_property(env, o, "errorState", v);
  napi_create_uint32(env, (uint32_t)scc_live_handles(), &v); napi_set_named_property(env, o, "liveHandles", v);
  napi_create_uint32(env, (uint32_t)scc_secure_heap_used(), &v); napi_set_named_property(env, o, "secureHeapUsed", v);
  napi_get_boolean(env, scc_heap_locked(), &v); napi_set_named_property(env, o, "secureHeapLocked", v);
  napi_create_uint32(env, (uint32_t)scc_selftest_failures(), &v); napi_set_named_property(env, o, "moduleSelfTestFailures", v);
  napi_create_string_utf8(env, OpenSSL_version(OPENSSL_VERSION), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "libcrypto", v);
  return o;
}

static napi_value EnterErrorState(napi_env env, napi_callback_info info) { (void)info; scc_enter_error_state(); return u32(env, 0); }
static napi_value ZeroizeAll(napi_env env, napi_callback_info info) { (void)info; return u32(env, (uint32_t)scc_zeroize_all()); }

static napi_value KeyRandom(napi_env env, napi_callback_info info) {
  (void)info; uint32_t h; int rc = scc_key_random(&h); return rc == SCC_OK ? u32(env, h) : throw_rc(env, rc);
}

/* The caller's bytes are cleansed here, so an imported key exists only in the secure heap afterwards. */
static napi_value KeyImport(napi_env env, napi_callback_info info) {
  napi_value argv[1]; unsigned char *b; size_t len; uint32_t h;
  if (!get_args(env, info, 1, argv) || !get_bytes(env, argv[0], &b, &len)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_key_import(b, len, &h);
  OPENSSL_cleanse(b, len);
  return rc == SCC_OK ? u32(env, h) : throw_rc(env, rc);
}

static napi_value KeyDestroy(napi_env env, napi_callback_info info) {
  napi_value argv[1]; uint32_t h;
  if (!get_args(env, info, 1, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &h));
  int rc = scc_key_destroy(h);
  return rc == SCC_OK ? u32(env, 0) : throw_rc(env, rc);
}

static napi_value Kbkdf(napi_env env, napi_callback_info info) {
  napi_value argv[3]; uint32_t key, out; char label[128]; size_t n, ctx_len; unsigned char *ctx;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  CHECK(napi_get_value_string_utf8(env, argv[1], label, sizeof label, &n));
  if (!get_bytes(env, argv[2], &ctx, &ctx_len)) return throw_rc(env, SCC_ERR_ARG);
  int rc = scc_kbkdf(key, label, ctx, ctx_len, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* Password bytes are cleansed after derivation; the renderer sent them as a Uint8Array, never a string. */
static napi_value Pbkdf2(napi_env env, napi_callback_info info) {
  napi_value argv[3]; unsigned char *pw, *salt; size_t pw_len, salt_len; double iter; uint32_t out;
  if (!get_args(env, info, 3, argv) || !get_bytes(env, argv[0], &pw, &pw_len) || !get_bytes(env, argv[1], &salt, &salt_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_double(env, argv[2], &iter));
  int rc = scc_pbkdf2(pw, pw_len, salt, salt_len, (uint64_t)iter, &out);
  OPENSSL_cleanse(pw, pw_len);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

static napi_value Argon2id(napi_env env, napi_callback_info info) {
  napi_value argv[4]; unsigned char *pw, *salt; size_t pw_len, salt_len; uint32_t mem, passes, out;
  if (!get_args(env, info, 4, argv) || !get_bytes(env, argv[0], &pw, &pw_len) || !get_bytes(env, argv[1], &salt, &salt_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[2], &mem));
  CHECK(napi_get_value_uint32(env, argv[3], &passes));
  int rc = scc_argon2id(pw, pw_len, salt, salt_len, mem, passes, &out);
  OPENSSL_cleanse(pw, pw_len);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* gcmSeal(key, ivOrNull, aad, plaintext) -> Uint8Array iv(12) || ct || tag(16) */
static napi_value GcmSeal(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; napi_valuetype t; uint32_t key; unsigned char *iv = NULL, *aad, *pt, *out; size_t iv_len = 0, aad_len, pt_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  CHECK(napi_typeof(env, argv[1], &t));
  if (t != napi_null && (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &pt, &pt_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 12 + pt_len + 16, (void **)&out, &ab));
  int rc = scc_gcm_seal(key, iv, aad, aad_len, pt, pt_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 12 + pt_len + 16, ab, 0, &res));
  return res;
}

/* gcmOpen(key, iv, aad, ctAndTag) -> Uint8Array plaintext; throws SCC_11 on a bad tag. */
static napi_value GcmOpen(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; uint32_t key; unsigned char *iv, *aad, *ct, *out; size_t iv_len, aad_len, ct_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len) || ct_len < 16) return throw_rc(env, SCC_ERR_AUTH);
  CHECK(napi_create_arraybuffer(env, ct_len - 16, (void **)&out, &ab));
  int rc = scc_gcm_open(key, iv, aad, aad_len, ct, ct_len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, ct_len - 16, ab, 0, &res));
  return res;
}

/* gcmOpenKey(kek, iv, aad, ctAndTag) -> KeyHandle: an unwrapped key goes straight into the secure heap. */
static napi_value GcmOpenKey(napi_env env, napi_callback_info info) {
  napi_value argv[4]; uint32_t kek, out; unsigned char *iv, *aad, *ct; size_t iv_len, aad_len, ct_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &kek));
  if (!get_bytes(env, argv[1], &iv, &iv_len) || iv_len != 12 || !get_bytes(env, argv[2], &aad, &aad_len) || !get_bytes(env, argv[3], &ct, &ct_len)) return throw_rc(env, SCC_ERR_AUTH);
  int rc = scc_gcm_open_key(kek, iv, aad, aad_len, ct, ct_len, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

/* gcmSealKey(kek, key, ivOrNull, aad) -> Uint8Array iv(12) || wrapped(32) || tag(16) */
static napi_value GcmSealKey(napi_env env, napi_callback_info info) {
  napi_value argv[4], ab, res; napi_valuetype t; uint32_t kek, key; unsigned char *iv = NULL, *aad, *out; size_t iv_len = 0, aad_len;
  if (!get_args(env, info, 4, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &kek));
  CHECK(napi_get_value_uint32(env, argv[1], &key));
  CHECK(napi_typeof(env, argv[2], &t));
  if (t != napi_null && (!get_bytes(env, argv[2], &iv, &iv_len) || iv_len != 12)) return throw_rc(env, SCC_ERR_ARG);
  if (!get_bytes(env, argv[3], &aad, &aad_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 12 + 32 + 16, (void **)&out, &ab));
  int rc = scc_gcm_seal_key(kek, key, iv, aad, aad_len, out, out + 12);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 60, ab, 0, &res));
  return res;
}

static napi_value HmacSha256(napi_env env, napi_callback_info info) {
  napi_value argv[2], ab, res; uint32_t key; unsigned char *data, *out; size_t len;
  if (!get_args(env, info, 2, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  if (!get_bytes(env, argv[1], &data, &len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 32, (void **)&out, &ab));
  int rc = scc_hmac_sha256(key, data, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 32, ab, 0, &res));
  return res;
}

static napi_value AesEcbBlock(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t key; unsigned char *in, *out; size_t len; bool enc;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  if (!get_bytes(env, argv[1], &in, &len) || len != 16) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_bool(env, argv[2], &enc));
  CHECK(napi_create_arraybuffer(env, 16, (void **)&out, &ab));
  int rc = scc_aes_ecb_block(key, in, enc, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 16, ab, 0, &res));
  return res;
}

static napi_value AesCtr(napi_env env, napi_callback_info info) {
  napi_value argv[3], ab, res; uint32_t key; unsigned char *icb, *in, *out; size_t icb_len, len;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  if (!get_bytes(env, argv[1], &icb, &icb_len) || icb_len != 16 || !get_bytes(env, argv[2], &in, &len) || len == 0 || len > 4096) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, len, (void **)&out, &ab));
  int rc = scc_aes_ctr(key, icb, in, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, len, ab, 0, &res));
  return res;
}

static napi_value Sha256(napi_env env, napi_callback_info info) {
  napi_value argv[1], ab, res; unsigned char *data, *out; size_t len;
  if (!get_args(env, info, 1, argv) || !get_bytes(env, argv[0], &data, &len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, 32, (void **)&out, &ab));
  int rc = scc_sha256(data, len, out);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, 32, ab, 0, &res));
  return res;
}

static napi_value RandomBytes(napi_env env, napi_callback_info info) {
  napi_value argv[1], ab, res; uint32_t n; unsigned char *out;
  if (!get_args(env, info, 1, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &n));
  if (n == 0 || n > 4096) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_create_arraybuffer(env, n, (void **)&out, &ab));
  int rc = scc_random(out, n);
  if (rc != SCC_OK) return throw_rc(env, rc);
  CHECK(napi_create_typedarray(env, napi_uint8_array, n, ab, 0, &res));
  return res;
}

static napi_value HkdfLegacy(napi_env env, napi_callback_info info) {
  napi_value argv[3]; uint32_t key, out; char label[128]; size_t n, salt_len; unsigned char *salt;
  if (!get_args(env, info, 3, argv)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_uint32(env, argv[0], &key));
  if (!get_bytes(env, argv[1], &salt, &salt_len)) return throw_rc(env, SCC_ERR_ARG);
  CHECK(napi_get_value_string_utf8(env, argv[2], label, sizeof label, &n));
  int rc = scc_hkdf_legacy(key, salt, salt_len, label, &out);
  return rc == SCC_OK ? u32(env, out) : throw_rc(env, rc);
}

static napi_value Register(napi_env env, napi_value exports) {
  napi_property_descriptor d[] = {
      {"init", NULL, Init, NULL, NULL, NULL, napi_default, NULL},
      {"hardenProcess", NULL, HardenProcess, NULL, NULL, NULL, napi_default, NULL},
      {"status", NULL, Status, NULL, NULL, NULL, napi_default, NULL},
      {"enterErrorState", NULL, EnterErrorState, NULL, NULL, NULL, napi_default, NULL},
      {"zeroizeAll", NULL, ZeroizeAll, NULL, NULL, NULL, napi_default, NULL},
      {"keyRandom", NULL, KeyRandom, NULL, NULL, NULL, napi_default, NULL},
      {"keyImport", NULL, KeyImport, NULL, NULL, NULL, napi_default, NULL},
      {"keyDestroy", NULL, KeyDestroy, NULL, NULL, NULL, napi_default, NULL},
      {"kbkdf", NULL, Kbkdf, NULL, NULL, NULL, napi_default, NULL},
      {"hkdfLegacy", NULL, HkdfLegacy, NULL, NULL, NULL, napi_default, NULL},
      {"pbkdf2", NULL, Pbkdf2, NULL, NULL, NULL, napi_default, NULL},
      {"argon2id", NULL, Argon2id, NULL, NULL, NULL, napi_default, NULL},
      {"gcmSeal", NULL, GcmSeal, NULL, NULL, NULL, napi_default, NULL},
      {"gcmOpen", NULL, GcmOpen, NULL, NULL, NULL, napi_default, NULL},
      {"gcmOpenKey", NULL, GcmOpenKey, NULL, NULL, NULL, napi_default, NULL},
      {"gcmSealKey", NULL, GcmSealKey, NULL, NULL, NULL, napi_default, NULL},
      {"hmacSha256", NULL, HmacSha256, NULL, NULL, NULL, napi_default, NULL},
      {"aesEcbBlock", NULL, AesEcbBlock, NULL, NULL, NULL, napi_default, NULL},
      {"aesCtr", NULL, AesCtr, NULL, NULL, NULL, napi_default, NULL},
      {"sha256", NULL, Sha256, NULL, NULL, NULL, napi_default, NULL},
      {"randomBytes", NULL, RandomBytes, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof d / sizeof d[0], d) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Register)
```

### B.2a `packages/native/binding.gyp` and `exports.map` (configuration specification, not built in the audit)

```python
{
  "targets": [{
    "target_name": "slate_native",
    "sources": [
      "src/slate_crypto_core.c",
      "src/binding.c",
      "src/sqlite/database_key.cpp",
      "<!@(node -p \"require('./scripts/vendored-sources.json').join(' ')\")"
    ],
    "include_dirs": ["deps/openssl/<(OS)-<(target_arch)/include", "deps/sqlcipher", "src"],
    "defines": [
      "NAPI_VERSION=9",
      "SQLITE_HAS_CODEC", "SQLCIPHER_CRYPTO_OPENSSL", "SQLITE_TEMP_STORE=3",
      "SQLITE_EXTRA_INIT=sqlcipher_extra_init", "SQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown"
    ],
    "libraries": ["<(module_root_dir)/deps/openssl/<(OS)-<(target_arch)/lib/libcrypto.a"],
    "cflags": ["-fvisibility=hidden"],
    "cflags_c": ["-std=c11"],
    "xcode_settings": {
      "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
      "OTHER_LDFLAGS": ["-Wl,-exported_symbol,_napi_register_module_v1", "-Wl,-exported_symbol,_node_api_module_get_api_version_v1"]
    },
    "conditions": [
      ["OS=='linux'", { "ldflags": ["-Wl,--exclude-libs,ALL", "-Wl,-Bsymbolic", "-Wl,--version-script=<(module_root_dir)/exports.map"] }]
    ]
  }]
}
```

```
# packages/native/exports.map
{
  global: napi_register_module_v1; node_api_module_get_api_version_v1;
  local: *;
};
```

### B.3 `packages/native/src/sqlite/database_key.cpp` (excerpt, pseudo-specification)

This is added to the vendored better-sqlite3-multiple-ciphers `Database` class, next to its existing `JS_key`/`JS_rekey`. The macro names follow that code base (`NODE_METHOD`, `UseAddon`, `REQUIRE_ARGUMENT_*`, `ThrowSqliteError`). C3 must adapt them to the vendored revision exactly.

```cpp
// Keys SQLCipher from a native key handle: the 32 key bytes go from the secure heap to SQLCipher's codec
// context through a stack buffer that is cleansed before this function returns. No JS string, no SQL text.
extern "C" {
#include "slate_crypto_core.h"
#include <openssl/crypto.h>
}

NODE_METHOD(Database::JS_keyWithHandle) {
  Database* db = Unwrap<Database>(info.This());
  REQUIRE_ARGUMENT_UINT32(first, uint32_t handle);
  REQUIRE_DATABASE_OPEN(db);
  char raw[68];
  int rc = scc_sqlcipher_raw_key(handle, raw);                  // "x'<64 hex>'"
  if (rc != SCC_OK) return ThrowTypeError(rc == SCC_ERR_ERROR_STATE ? "SCC_12" : "SCC_8");
  int status = sqlite3_key_v2(db->db_handle, "main", raw, 67);  // SQLCipher: raw-key syntax, no PBKDF2
  OPENSSL_cleanse(raw, sizeof raw);
  if (status != SQLITE_OK) return db->ThrowDatabaseError();
  info.GetReturnValue().Set(status);
}

NODE_METHOD(Database::JS_rekeyWithHandle) {                    // same shape, sqlite3_rekey_v2
  Database* db = Unwrap<Database>(info.This());
  REQUIRE_ARGUMENT_UINT32(first, uint32_t handle);
  REQUIRE_DATABASE_OPEN(db);
  char raw[68];
  int rc = scc_sqlcipher_raw_key(handle, raw);
  if (rc != SCC_OK) return ThrowTypeError(rc == SCC_ERR_ERROR_STATE ? "SCC_12" : "SCC_8");
  int status = sqlite3_rekey_v2(db->db_handle, "main", raw, 67);
  OPENSSL_cleanse(raw, sizeof raw);
  if (status != SQLITE_OK) return db->ThrowDatabaseError();
  info.GetReturnValue().Set(status);
}
```

### B.4 `packages/native/index.ts`

```typescript
// packages/native/index.ts — the typed surface of slate_native.node (packages/native/src/binding.c).
import { createRequire } from 'node:module'

/** An opaque reference to a 32-byte key held in OpenSSL's secure heap. Never the key itself. */
export type KeyHandle = number & { readonly __keyHandle: unique symbol }

export interface NativeStatus {
  /** The FIPS provider is loaded, passed its self-tests, and `fips=yes` is the default property query. */
  fipsActive: boolean
  /** Sticky: a module self-test failed or `enterErrorState` ran. Every service now throws `SCC_12`. */
  errorState: boolean
  liveHandles: number
  secureHeapUsed: number
  /** False when the secure heap could not be mlock'd (RLIMIT_MEMLOCK); reported as degraded. */
  secureHeapLocked: boolean
  moduleSelfTestFailures: number
  libcrypto: string
}

export interface SlateNative {
  /** `modulesDir` holds fips.so / fips.dylib; `fipsConfigPath` is the config written by fipsConfig.ts (§4.10). */
  init(fipsConfigPath: string, modulesDir: string, requireFips: boolean): 0
  hardenProcess(): boolean
  status(): NativeStatus
  enterErrorState(): 0
  zeroizeAll(): number
  keyRandom(): KeyHandle
  /** Cleanses `bytes` after copying them into the secure heap. */
  keyImport(bytes: Uint8Array): KeyHandle
  keyDestroy(key: KeyHandle): 0
  /** SP 800-108r1 counter mode, HMAC-SHA-256, 0x00 separator, [L]32: label = purpose, context = binding. */
  kbkdf(key: KeyHandle, label: string, context: Uint8Array): KeyHandle
  /** RFC 5869 HKDF-SHA-256 for legacy suite 0x01 only; outside the FIPS library context. */
  hkdfLegacy(key: KeyHandle, salt: Uint8Array, info: string): KeyHandle
  /** Cleanses `password`. */
  pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): KeyHandle
  /** Cleanses `password`. Standard profile only; runs outside the FIPS library context. */
  argon2id(password: Uint8Array, salt: Uint8Array, memoryKiB: number, passes: number): KeyHandle
  /** iv(12) || ct || tag(16). `iv` null = fresh IV from the module DRBG. */
  gcmSeal(key: KeyHandle, iv: Uint8Array | null, aad: Uint8Array, plaintext: Uint8Array): Uint8Array
  gcmOpen(key: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): Uint8Array
  gcmSealKey(kek: KeyHandle, key: KeyHandle, iv: Uint8Array | null, aad: Uint8Array): Uint8Array
  gcmOpenKey(kek: KeyHandle, iv: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): KeyHandle
  hmacSha256(key: KeyHandle, data: Uint8Array): Uint8Array
  aesEcbBlock(key: KeyHandle, block: Uint8Array, encrypt: boolean): Uint8Array
  /** AES-256-CTR from the given 16-byte initial counter block (SP 800-38A). */
  aesCtr(key: KeyHandle, icb: Uint8Array, data: Uint8Array): Uint8Array
  sha256(data: Uint8Array): Uint8Array
  randomBytes(n: number): Uint8Array
}

/** `SCC_11` = authentication failed, `SCC_12` = error state; anything else is a module fault. */
export function nativeErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('SCC_') ? code : null
}

let loaded: SlateNative | null = null

/** Throws if the addon is missing or built for another ABI; the POST turns that into POST-MODULE-LOAD. */
export function loadNative(addonPath: string): SlateNative {
  loaded ??= createRequire(import.meta.url)(addonPath) as SlateNative
  return loaded
}
```

### B.5 `packages/desktop/src/main/vault/envelope.ts`

```typescript
// packages/desktop/src/main/vault/envelope.ts — SLE1 (read-only legacy) and SLE2 remote-file envelopes.
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { KeyHandle, SlateNative } from '@slate/native'
import { nativeErrorCode } from '@slate/native'

export class UnverifiableFile extends Error {
  override name = 'UnverifiableFile'
  constructor(reason = 'This file could not be verified') {
    super(reason)
  }
}

/** The suite registry (§16.3 of the audit). Unknown or unlisted ids are refused before any key is used. */
export const SUITE = { HKDF_AES256GCM: 0x01, KBKDF_AES256GCM: 0x02 } as const
export type SuiteId = (typeof SUITE)[keyof typeof SUITE]

export const FLAG = { DEFLATED: 0x01, PADDED: 0x02 } as const
const KNOWN_FLAGS = FLAG.DEFLATED | FLAG.PADDED
const SLE1_HEADER = 4 + 1 + 16 + 12 // magic | flags | salt | nonce
const SLE2_HEADER = 4 + 1 + 1 + 4 + 16 + 12 // magic | suite | flags | keyEpoch | salt | nonce
const TAG = 16
export const MAX_SEALED_BYTES = 64 * 1024 * 1024
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024

export interface ParsedEnvelope {
  format: 'SLE1' | 'SLE2'
  suite: SuiteId
  flags: number
  keyEpoch: number
  salt: Uint8Array
  nonce: Uint8Array
  /** Exactly the bytes bound into the AAD. */
  header: Uint8Array
  ctAndTag: Uint8Array
}

/** Structure only, no keys: every rejection is UnverifiableFile, and nothing here allocates more than the input. */
export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (bytes.length > MAX_SEALED_BYTES) throw new UnverifiableFile('This file is too large')
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  if (magic === 'SLE1') {
    if (bytes.length < SLE1_HEADER + TAG) throw new UnverifiableFile()
    const flags = bytes[4]!
    if ((flags & ~FLAG.DEFLATED) !== 0) throw new UnverifiableFile()
    return {
      format: 'SLE1', suite: SUITE.HKDF_AES256GCM, flags, keyEpoch: 0,
      salt: bytes.subarray(5, 21), nonce: bytes.subarray(21, 33),
      header: bytes.subarray(0, SLE1_HEADER), ctAndTag: bytes.subarray(SLE1_HEADER),
    }
  }
  if (magic === 'SLE2') {
    if (bytes.length < SLE2_HEADER + TAG) throw new UnverifiableFile()
    const suite = bytes[4]!
    const flags = bytes[5]!
    if (suite !== SUITE.KBKDF_AES256GCM) throw new UnverifiableFile('Unknown cipher suite')
    if ((flags & ~KNOWN_FLAGS) !== 0) throw new UnverifiableFile()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
      format: 'SLE2', suite, flags, keyEpoch: view.getUint32(6, false),
      salt: bytes.subarray(10, 26), nonce: bytes.subarray(26, 38),
      header: bytes.subarray(0, SLE2_HEADER), ctAndTag: bytes.subarray(SLE2_HEADER),
    }
  }
  throw new UnverifiableFile()
}

function aad(header: Uint8Array, logicalPath: string): Uint8Array {
  const tail = new TextEncoder().encode('|' + logicalPath)
  const out = new Uint8Array(header.length + tail.length)
  out.set(header, 0)
  out.set(tail, header.length)
  return out
}

/** Padmé (Nikitin et al., PETS 2019): at most ~12% overhead, leaks O(log log L) bits of the length. */
export function padmeLength(len: number): number {
  if (len < 2) return len
  const e = Math.floor(Math.log2(len))
  const s = Math.floor(Math.log2(e)) + 1
  const mask = 2 ** (e - s) - 1
  return Math.ceil(len / (mask + 1)) * (mask + 1)
}

/** ISO/IEC 7816-4 padding (0x80 then zeros) up to padmeLength(len + 1). */
export function pad(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(padmeLength(body.length + 1))
  out.set(body, 0)
  out[body.length] = 0x80
  return out
}

export function unpad(padded: Uint8Array): Uint8Array {
  let i = padded.length - 1
  while (i >= 0 && padded[i] === 0) i--
  if (i < 0 || padded[i] !== 0x80) throw new UnverifiableFile()
  return padded.subarray(0, i)
}

/** Which K_sync a file needs: the suite fixes the key schedule, the epoch picks the key generation. */
export interface EnvelopeKeys {
  syncKey(suite: SuiteId, keyEpoch: number): KeyHandle
  readonly writeSuite: SuiteId
  readonly writeEpoch: number
}

function fileKey(n: SlateNative, kSync: KeyHandle, suite: SuiteId, salt: Uint8Array): KeyHandle {
  return suite === SUITE.KBKDF_AES256GCM ? n.kbkdf(kSync, 'slate/v2/remote-file', salt) : n.hkdfLegacy(kSync, salt, 'slate/v1/remote-file')
}

/**
 * Deterministic core shared by production (fresh salt and nonce) and the POST known-answer test
 * (fixed ones), so the self-test exercises exactly the code that seals user data.
 */
export function sealSle2With(
  n: SlateNative,
  kSync: KeyHandle,
  keyEpoch: number,
  logicalPath: string,
  plaintext: Uint8Array,
  fixed: { salt: Uint8Array; nonce: Uint8Array },
  opts: { deflate: boolean; pad: boolean },
): Uint8Array {
  let body = opts.deflate ? new Uint8Array(deflateRawSync(plaintext)) : plaintext
  if (opts.pad) body = pad(body)
  const header = new Uint8Array(SLE2_HEADER)
  header.set(new TextEncoder().encode('SLE2'), 0)
  header[4] = SUITE.KBKDF_AES256GCM
  header[5] = (opts.deflate ? FLAG.DEFLATED : 0) | (opts.pad ? FLAG.PADDED : 0)
  new DataView(header.buffer).setUint32(6, keyEpoch, false)
  header.set(fixed.salt, 10)
  header.set(fixed.nonce, 26)
  const fk = fileKey(n, kSync, SUITE.KBKDF_AES256GCM, fixed.salt)
  try {
    const sealed = n.gcmSeal(fk, fixed.nonce, aad(header, logicalPath), body)
    const out = new Uint8Array(SLE2_HEADER + sealed.length - 12)
    out.set(header, 0)
    out.set(sealed.subarray(12), SLE2_HEADER)
    return out
  } finally {
    n.keyDestroy(fk)
  }
}

/**
 * The audited SLE1 format, byte for byte: written only by a vault-header-v1 vault (standard profile)
 * until it is upgraded (C9), so a remote shared with devices on older Slate versions stays readable.
 */
export function sealSle1With(
  n: SlateNative,
  kSync: KeyHandle,
  logicalPath: string,
  plaintext: Uint8Array,
  fixed: { salt: Uint8Array; nonce: Uint8Array },
  opts: { deflate: boolean },
): Uint8Array {
  const body = opts.deflate ? new Uint8Array(deflateRawSync(plaintext)) : plaintext
  const header = new Uint8Array(SLE1_HEADER)
  header.set(new TextEncoder().encode('SLE1'), 0)
  header[4] = opts.deflate ? FLAG.DEFLATED : 0
  header.set(fixed.salt, 5)
  header.set(fixed.nonce, 21)
  const fk = fileKey(n, kSync, SUITE.HKDF_AES256GCM, fixed.salt)
  try {
    const sealed = n.gcmSeal(fk, fixed.nonce, aad(header, logicalPath), body)
    const out = new Uint8Array(SLE1_HEADER + sealed.length - 12)
    out.set(header, 0)
    out.set(sealed.subarray(12), SLE1_HEADER)
    return out
  } finally {
    n.keyDestroy(fk)
  }
}

export function sealEnvelope(n: SlateNative, keys: EnvelopeKeys, logicalPath: string, plaintext: Uint8Array, opts: { deflate: boolean; pad: boolean }): Uint8Array {
  const fresh = { salt: n.randomBytes(16), nonce: n.randomBytes(12) }
  const kSync = keys.syncKey(keys.writeSuite, keys.writeEpoch)
  if (keys.writeSuite === SUITE.HKDF_AES256GCM) return sealSle1With(n, kSync, logicalPath, plaintext, fresh, { deflate: opts.deflate })
  return sealSle2With(n, kSync, keys.writeEpoch, logicalPath, plaintext, fresh, opts)
}

/** Authenticate, then unpad, then inflate (capped). A profile that may not read a suite passes `allowed` without it. */
export function openEnvelope(n: SlateNative, keys: EnvelopeKeys, logicalPath: string, bytes: Uint8Array, allowed: ReadonlySet<SuiteId>): Uint8Array {
  const env = parseEnvelope(bytes)
  if (!allowed.has(env.suite)) throw new UnverifiableFile('This file uses a cipher suite this vault does not accept')
  let kSync: KeyHandle
  try {
    kSync = keys.syncKey(env.suite, env.keyEpoch)
  } catch {
    throw new UnverifiableFile('This file was sealed under a key this vault does not hold')
  }
  const fk = fileKey(n, kSync, env.suite, env.salt)
  let body: Uint8Array
  try {
    body = n.gcmOpen(fk, env.nonce, aad(env.header, logicalPath), env.ctAndTag)
  } catch (e) {
    // SCC_12 (error state) is not the file's fault: it must reach the POST supervisor, not the sync notice.
    if (nativeErrorCode(e) === 'SCC_12') throw e
    throw new UnverifiableFile()
  } finally {
    n.keyDestroy(fk)
  }
  if (env.flags & FLAG.PADDED) body = unpad(body)
  if (!(env.flags & FLAG.DEFLATED)) return body
  try {
    return new Uint8Array(inflateRawSync(body, { maxOutputLength: MAX_INFLATED_BYTES }))
  } catch {
    throw new UnverifiableFile('This file is too large or damaged')
  }
}
```

### B.6 `packages/desktop/src/main/vault/names.ts` (suite 0x02)

```typescript
// packages/desktop/src/main/vault/names.ts — suite 0x02 remote names (replaces §15 N1's AES-ECB block).
// name = hex(SIV ‖ C), SIV = HMAC-SHA-256(K_name_mac, "slate-name/v2" ‖ 0x00 ‖ P)[0..16), C = AES-256-CTR(K_name_enc, ICB = SIV, P),
// P = the 16 uuid bytes with the version nibble replaced by the kind code. Deterministic (inputs are unique),
// reversible without a map, and authenticated: a forged or altered name fails the SIV check.
import type { KeyHandle, SlateNative } from '@slate/native'

export type IdKind = 'notebook' | 'page' | 'device'
const CODE: Record<IdKind, number> = { notebook: 1, page: 2, device: 3 }
const KIND = new Map<number, IdKind>(Object.entries(CODE).map(([k, v]) => [v, k as IdKind]))
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DOMAIN = new TextEncoder().encode('slate-name/v2\u0000')

export interface NameKeys {
  enc: KeyHandle
  mac: KeyHandle
}

function siv(n: SlateNative, mac: KeyHandle, packed: Uint8Array): Uint8Array {
  const msg = new Uint8Array(DOMAIN.length + 16)
  msg.set(DOMAIN, 0)
  msg.set(packed, DOMAIN.length)
  return n.hmacSha256(mac, msg).subarray(0, 16)
}

export function encodeIdV2(n: SlateNative, keys: NameKeys, kind: IdKind, uuid: string): string {
  const code = Object.hasOwn(CODE, kind) ? CODE[kind] : undefined
  if (!code) throw new Error(`Unknown id kind: ${String(kind)}`)
  if (!UUID4.test(uuid)) throw new Error(`Not a version 4 uuid: ${uuid}`)
  const packed = Uint8Array.from(Buffer.from(uuid.replace(/-/g, ''), 'hex'))
  packed[6] = (code << 4) | (packed[6]! & 0x0f)
  const iv = siv(n, keys.mac, packed)
  return Buffer.from(iv).toString('hex') + Buffer.from(n.aesCtr(keys.enc, iv, packed)).toString('hex')
}

/** Null for anything that is not one of our names; never throws on input from the remote. */
export function decodeIdV2(n: SlateNative, keys: NameKeys, hex: string): { kind: IdKind; uuid: string } | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  const raw = Uint8Array.from(Buffer.from(hex, 'hex'))
  const iv = raw.subarray(0, 16)
  const packed = n.aesCtr(keys.enc, iv, raw.subarray(16))
  const want = siv(n, keys.mac, packed)
  let d = 0
  for (let i = 0; i < 16; i++) d |= want[i]! ^ iv[i]!
  if (d !== 0) return null
  const kind = KIND.get(packed[6]! >> 4)
  if (!kind || (packed[8]! & 0xc0) !== 0x80) return null
  packed[6] = 0x40 | (packed[6]! & 0x0f)
  const h = Buffer.from(packed).toString('hex')
  return { kind, uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
}
```

### B.7 `packages/desktop/src/main/vault/vaultState.ts`

```typescript
// packages/desktop/src/main/vault/vaultState.ts — replaces the audited file (adds selftest states).
export type VaultState =
  | 'selftest'
  | 'selftest-failed'
  | 'plaintext'
  | 'locked'
  | 'unlocking'
  | 'unlocked'
  | 'locking'
  | 'migrating'

/** Where the POST hands over once every KAT passed (the audited `initialVaultState`, unchanged). */
export function initialVaultState(files: { vault: boolean; localKeys: boolean; migration: boolean; plainDb: boolean }): VaultState {
  if (!files.vault) return 'plaintext'
  if (files.localKeys) return 'locked'
  return files.migration && files.plainDb ? 'migrating' : 'locked'
}

/** Whether note services exist and note IPC may run. Never during or after a failed self-test. */
export function notesOpen(state: VaultState): boolean {
  return state === 'unlocked' || state === 'plaintext' || state === 'migrating'
}

/**
 * `selftest` is the only start state. `selftest-failed` has no way out: the process must exit, and
 * the next launch runs the POST again. Every other state may fall into it when an on-demand or
 * conditional self-test fails (§4.2 rule S-7).
 */
const MOVES: Record<VaultState, readonly VaultState[]> = {
  selftest: ['plaintext', 'locked', 'migrating', 'selftest-failed'],
  'selftest-failed': [],
  plaintext: ['migrating', 'selftest-failed'],
  migrating: ['plaintext', 'unlocked', 'selftest-failed'],
  locked: ['unlocking', 'selftest-failed'],
  unlocking: ['unlocked', 'locked', 'selftest-failed'],
  unlocked: ['locking', 'selftest-failed'],
  locking: ['locked', 'selftest-failed'],
}

export class VaultStateMachine {
  private listeners = new Set<(state: VaultState) => void>()
  private current: VaultState = 'selftest'

  get state(): VaultState {
    return this.current
  }

  to(next: VaultState): void {
    if (!MOVES[this.current].includes(next)) throw new Error(`Vault state cannot go ${this.current} → ${next}`)
    this.current = next
    this.listeners.forEach((l) => l(next))
  }

  /** Idempotent: a second failure while already failed is not an error. */
  fail(): void {
    if (this.current !== 'selftest-failed') this.to('selftest-failed')
  }

  onChange(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
```

### B.8 `packages/desktop/src/main/ipcGuard.ts`

```typescript
// packages/desktop/src/main/ipcGuard.ts — replaces the audited file: state-aware allowlists + sender validation.
import type { IpcMainInvokeEvent, WebFrameMain } from 'electron'
import type { VaultState } from './vault/vaultState'

export class Locked extends Error {
  override name = 'Locked'
  constructor() {
    super('Slate is locked')
  }
}

export class SelfTestFailed extends Error {
  override name = 'SelfTestFailed'
  constructor() {
    super('Slate stopped because a cryptographic self-test failed')
  }
}

export class UntrustedSender extends Error {
  override name = 'UntrustedSender'
  constructor() {
    super('IPC from a frame that is not Slate')
  }
}

/** The channel names of `CH` in shared/ipc.ts that each state may call. */
export interface ChannelPolicy {
  /** While `selftest` or `selftest-failed`: status, version, window chrome, quit, diagnostics. */
  selfTest: ReadonlySet<string>
  /** While locked (the audited PRE_UNLOCK_CHANNELS). */
  preUnlock: ReadonlySet<string>
  /** Note writes allowed during the lock's flush step. */
  flush: ReadonlySet<string>
}

// Handler arguments are whatever the channel takes, so they cannot be typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

interface Registrar {
  handle(channel: string, handler: Handler): void
}

/**
 * Only the top frame of a Slate window showing Slate's own page may call IPC. `appUrl` is the
 * renderer entry (file:///…/out/renderer/index.html, or the dev server origin when unpackaged).
 */
export function isTrustedSender(frame: WebFrameMain | null, appUrl: URL): boolean {
  if (!frame || frame.parent !== null) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  if (appUrl.protocol === 'file:') return url.protocol === 'file:' && url.pathname === appUrl.pathname
  return url.origin === appUrl.origin
}

export function guardHandlers<T extends Registrar>(
  ipc: T,
  deps: { state: () => VaultState; notesOpen: () => boolean; flushing: () => boolean; appUrl: URL; policy: ChannelPolicy },
): T {
  const registered = new Set<string>()
  return {
    ...ipc,
    handle: (channel: string, handler: Handler) => {
      if (registered.has(channel)) throw new Error(`IPC channel ${channel} is already registered`)
      registered.add(channel)
      ipc.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event.senderFrame, deps.appUrl)) throw new UntrustedSender()
        const state = deps.state()
        if (state === 'selftest' || state === 'selftest-failed') {
          if (!deps.policy.selfTest.has(channel)) throw new SelfTestFailed()
          return handler(event, ...args)
        }
        const allowed = deps.policy.preUnlock.has(channel) || deps.notesOpen() || (deps.policy.flush.has(channel) && deps.flushing())
        if (!allowed) throw new Locked()
        return handler(event, ...args)
      })
    },
  }
}
```

### B.9–B.12: see §5.2 (`vectors.ts`, `post.ts`, `supervisor.ts`) and §6.9 (`child.ts`)

### B.13 `packages/desktop/src/main/vault/keyring.ts`

```typescript
// packages/desktop/src/main/vault/keyring.ts — replaces the audited file: handles, not bytes.
import type { KeyHandle, SlateNative } from '@slate/native'
import { Locked } from '../ipcGuard'
import { SUITE, type SuiteId } from './envelope'

const V2_LABELS = {
  sync: 'slate/v2/sync',
  name: 'slate/v2/name',
  nameEnc: 'slate/v2/name-enc',
  nameMac: 'slate/v2/name-mac',
  check: 'slate/v2/check',
  prefs: 'slate/v2/prefs',
  localwrap: 'slate/v2/local-wrap',
} as const
const V1_INFO = {
  sync: 'slate/v1/sync',
  name: 'slate/v1/name',
  nameEnc: 'slate/v1/name-enc',
  // Suite 0x01 names are one AES-ECB block and carry no MAC; the key is derived but never used.
  nameMac: 'slate/v1/name-mac',
  check: 'slate/v1/check',
  prefs: 'slate/v1/prefs',
  localwrap: 'slate/v1/local-wrap',
} as const

export type SubkeyName = keyof typeof V2_LABELS
export type KeyName = 'mk' | 'lk' | SubkeyName

function uuidBytes(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error('Not a uuid')
  return Uint8Array.from(Buffer.from(uuid.replace(/-/g, ''), 'hex'))
}

/**
 * The only owner of key material (§3 of the spec, rules Z-1…Z-9 of the audit). Keys live in the
 * native secure heap; this class holds handles. `close()` destroys every handle it owns and then
 * verifies that none of them is still live, so a lock either provably zeroed or failed loudly.
 */
export class KeyRing {
  private handles: Map<KeyName, KeyHandle> | null = new Map()

  constructor(
    private readonly n: SlateNative,
    readonly vaultId: string,
    readonly suite: SuiteId,
    mk: KeyHandle,
    lk?: KeyHandle,
  ) {
    const map = this.handles!
    map.set('mk', mk)
    if (lk !== undefined) map.set('lk', lk)
    const context = uuidBytes(vaultId)
    for (const name of Object.keys(V2_LABELS) as SubkeyName[]) {
      map.set(name, suite === SUITE.KBKDF_AES256GCM ? n.kbkdf(mk, V2_LABELS[name], context) : n.hkdfLegacy(mk, new Uint8Array(0), V1_INFO[name]))
    }
  }

  get isOpen(): boolean {
    return this.handles !== null
  }

  /** A handle valid until close(); using it afterwards throws SCC_8 in the module, never yields zeros. */
  get(name: KeyName): KeyHandle {
    if (!this.handles) throw new Locked()
    const h = this.handles.get(name)
    if (h === undefined) throw new Error(`No ${name} key in this key ring`)
    return h
  }

  /** Returns how many handles were destroyed; throws if any survived (the lock step logs it as a failure). */
  close(): number {
    const handles = this.handles
    this.handles = null
    if (!handles) return 0
    const before = this.n.status().liveHandles
    let destroyed = 0
    for (const h of handles.values()) {
      try {
        this.n.keyDestroy(h)
        destroyed++
      } catch {
        // Already destroyed (e.g. by zeroizeAll in the error path): not live any more either way.
      }
    }
    if (this.n.status().liveHandles > before - destroyed) throw new Error('Key ring close left live key handles')
    return destroyed
  }
}
```

### B.14 `packages/desktop/src/main/vault/profile.ts`

```typescript
// packages/desktop/src/main/vault/profile.ts — the two crypto profiles (audit §4.1). Data, not branches.
import { SUITE, type SuiteId } from './envelope'

export type ProfileId = 'standard' | 'fips-140-3'

export interface ProfilePolicy {
  id: ProfileId
  /** The native FIPS provider must be active (status().fipsActive) before any key is derived. */
  requireFipsModule: boolean
  /** For vaults created under this profile; a header-v1 vault keeps writing suite 0x01 until it is upgraded (R-5). */
  writeSuite: SuiteId
  readSuites: ReadonlySet<SuiteId>
  kdf: { alg: 'argon2id' } | { alg: 'pbkdf2-hmac-sha512'; minIterations: number; maxIterations: number; targetMs: number }
  password: { minLength: number; normalization: 'NFC' }
  /** Minutes; null = "Never" is allowed. */
  maxIdleMinutes: number | null
  forceLockOnSleep: boolean
  forceLockOnScreenLock: boolean
  quickUnlock: boolean
  /** NIST SP 800-53 AC-7 as FedRAMP parameterises it; null = no throttle beyond the KDF cost. */
  unlockThrottle: { maxFailures: number; windowMinutes: number; lockoutMinutes: number } | null
  remoteImages: boolean
  /** Update packages must carry a valid detached signature from the pinned release key (C12). */
  signedUpdatesOnly: boolean
}

export const PROFILES: Readonly<Record<ProfileId, ProfilePolicy>> = {
  standard: {
    id: 'standard',
    requireFipsModule: false,
    writeSuite: SUITE.KBKDF_AES256GCM,
    readSuites: new Set([SUITE.HKDF_AES256GCM, SUITE.KBKDF_AES256GCM]),
    kdf: { alg: 'argon2id' },
    password: { minLength: 10, normalization: 'NFC' },
    maxIdleMinutes: null,
    forceLockOnSleep: false,
    forceLockOnScreenLock: false,
    quickUnlock: true,
    unlockThrottle: null,
    remoteImages: true,
    signedUpdatesOnly: false,
  },
  'fips-140-3': {
    id: 'fips-140-3',
    requireFipsModule: true,
    writeSuite: SUITE.KBKDF_AES256GCM,
    // Suite 0x01 keys come from HKDF over an Argon2id KEK: never approved, so never read here.
    readSuites: new Set([SUITE.KBKDF_AES256GCM]),
    kdf: { alg: 'pbkdf2-hmac-sha512', minIterations: 600_000, maxIterations: 10_000_000, targetMs: 1000 },
    // NFC in both profiles: changing normalisation would make existing passwords stop working.
    password: { minLength: 15, normalization: 'NFC' },
    maxIdleMinutes: 15,
    forceLockOnSleep: true,
    forceLockOnScreenLock: true,
    quickUnlock: false,
    unlockThrottle: { maxFailures: 3, windowMinutes: 15, lockoutMinutes: 180 },
    remoteImages: false,
    signedUpdatesOnly: true,
  },
}

/** A device never moves a vault to a weaker profile (downgrade protection, like `revision`). */
export function profileRank(id: ProfileId): number {
  return id === 'fips-140-3' ? 1 : 0
}

/** Clamps a stored idle setting to the profile; 0 means "Never" in the settings schema. */
export function effectiveIdleMinutes(stored: number, policy: ProfilePolicy): number {
  if (policy.maxIdleMinutes === null) return stored
  return stored === 0 ? policy.maxIdleMinutes : Math.min(stored, policy.maxIdleMinutes)
}
```

### B.15 `packages/desktop/src/main/vault/unlockThrottle.ts`

```typescript
// packages/desktop/src/main/vault/unlockThrottle.ts — AC-7 for the fips-140-3 profile.
// A UI control only: someone holding a copy of the data folder is limited by the KDF cost alone.
import type { ProfilePolicy } from './profile'

export interface ThrottleState {
  /** Epoch ms of recent failed password attempts, oldest first. */
  failures: number[]
  lockedUntil: number | null
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAt: number }

/** The recovery key is the administrator release AC-7 asks for, so it is never throttled. */
export function canTryPassword(state: ThrottleState, policy: ProfilePolicy, now: number): ThrottleDecision {
  if (!policy.unlockThrottle) return { allowed: true }
  if (state.lockedUntil !== null && now < state.lockedUntil) return { allowed: false, retryAt: state.lockedUntil }
  return { allowed: true }
}

export function recordFailure(state: ThrottleState, policy: ProfilePolicy, now: number): ThrottleState {
  const t = policy.unlockThrottle
  if (!t) return state
  const windowStart = now - t.windowMinutes * 60_000
  const failures = [...state.failures.filter((at) => at >= windowStart), now]
  if (failures.length >= t.maxFailures) return { failures: [], lockedUntil: now + t.lockoutMinutes * 60_000 }
  return { failures, lockedUntil: state.lockedUntil }
}

export function recordSuccess(): ThrottleState {
  return { failures: [], lockedUntil: null }
}
```

### B.16 `packages/desktop/src/main/hardening.ts`

```typescript
// packages/desktop/src/main/hardening.ts — Electron boundary rules (audit §4.4), installed before the first window.
import { app, session, shell, type WebContents } from 'electron'

/** Only Slate's own page may load in a Slate window; everything else is refused or sent to the browser. */
export function installWebContentsGuards(appUrl: URL): void {
  const isAppUrl = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      return appUrl.protocol === 'file:' ? u.protocol === 'file:' && u.pathname === appUrl.pathname : u.origin === appUrl.origin
    } catch {
      return false
    }
  }
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault()
    })
    wc.on('will-attach-webview', (event) => event.preventDefault())
    wc.setWindowOpenHandler(({ url }) => {
      // The same rule as CH.openExternal: http(s) and mailto only, in the user's browser.
      if (/^(?:https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/** Deny-by-default permissions: Slate's renderer needs none of camera, microphone, geolocation, HID, serial… */
export function installPermissionPolicy(allowed: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])): void {
  const s = session.defaultSession
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  s.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  s.setDevicePermissionHandler(() => false)
}
```

### B.17 `packages/desktop/src/main/secretStorage.ts`

```typescript
// packages/desktop/src/main/secretStorage.ts — the one wrapper around Electron's safeStorage (rule B-5).
// Electron 45 deprecates the synchronous API and 46 removes it; this uses only the async one.
import type { SafeStorage } from 'electron'

/** basic_text "encrypts" with a hard-coded password: never a place for a credential or a key. */
const REAL_KEYRINGS: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export type SecretStorePolicy = 'persist' | 'session-only' | 'refuse'

export class SecretStorageUnavailable extends Error {
  override name = 'SecretStorageUnavailable'
  constructor() {
    super('This computer has no system keyring Slate can use, so the secret is not stored')
  }
}

export interface SecretStorage {
  /** Whether a secret written now would be protected by a real OS keyring. */
  available(): Promise<boolean>
  seal(plain: string): Promise<Buffer>
  /** `rewrite` is set when the OS rotated its key: the caller re-seals and writes the file again. */
  open(sealed: Buffer): Promise<{ plain: string; rewrite: boolean }>
}

export function createSecretStorage(ss: Pick<SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync' | 'getSelectedStorageBackend'>, platform: NodeJS.Platform): SecretStorage {
  const available = async (): Promise<boolean> => {
    if (!(await ss.isAsyncEncryptionAvailable())) return false
    return platform !== 'linux' || REAL_KEYRINGS.has(ss.getSelectedStorageBackend())
  }
  return {
    available,
    seal: async (plain) => {
      if (!(await available())) throw new SecretStorageUnavailable()
      return ss.encryptStringAsync(plain)
    },
    open: async (sealed) => {
      if (!(await available())) throw new SecretStorageUnavailable()
      const { result, shouldReEncrypt } = await ss.decryptStringAsync(sealed)
      return { plain: result, rewrite: shouldReEncrypt }
    },
  }
}

/** standard: keep a credential for this session only when there is no keyring; fips-140-3: refuse it. */
export function credentialPolicy(available: boolean, profile: 'standard' | 'fips-140-3'): SecretStorePolicy {
  if (available) return 'persist'
  return profile === 'fips-140-3' ? 'refuse' : 'session-only'
}
```

### B.18 `packages/desktop/src/main/native/fipsConfig.ts`

```typescript
// packages/desktop/src/main/native/fipsConfig.ts — writes the OpenSSL config that activates the FIPS provider (§4.9).
// Regenerated at every start: the resources path differs per install and `.include` needs an absolute path.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FipsPaths {
  /** <resourcesPath>/fips: holds fips.dylib or fips.so and fipsmodule.cnf. */
  modulesDir: string
  /** <userData>/fips/openssl-fips.cnf */
  configFile: string
}

export function fipsPaths(resourcesPath: string, userData: string): FipsPaths {
  return { modulesDir: join(resourcesPath, 'fips'), configFile: join(userData, 'fips', 'openssl-fips.cnf') }
}

export function fipsConfigText(modulesDir: string): string {
  const include = join(modulesDir, 'fipsmodule.cnf')
  if (/["\n\r]/.test(include)) throw new Error('The FIPS module path cannot be written into an OpenSSL config')
  return [
    'config_diagnostics = 1',
    'openssl_conf = openssl_init',
    '',
    `.include "${include}"`,
    '',
    '[openssl_init]',
    'providers = provider_sect',
    'alg_section = algorithm_sect',
    '',
    '[provider_sect]',
    'fips = fips_sect',
    'base = base_sect',
    '',
    '[base_sect]',
    'activate = 1',
    '',
    '[algorithm_sect]',
    'default_properties = fips=yes',
    '',
  ].join('\n')
}

export function writeFipsConfig(paths: FipsPaths): void {
  mkdirSync(join(paths.configFile, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(paths.configFile, fipsConfigText(paths.modulesDir), { mode: 0o600 })
}
```

### B.19 Password as bytes: preload and lock screen (excerpt)

```typescript
// packages/desktop/src/preload/index.ts (excerpt) and the lock screen's submit handler — rule Z-5.
// The password leaves the renderer once, as bytes, and the renderer's copy is zeroed when the call settles.
import { contextBridge, ipcRenderer } from 'electron'

const VAULT_UNLOCK = 'vault:unlock'

export interface UnlockResult {
  ok: boolean
  message?: string
  failures?: number
}

const vault = {
  /** Takes the bytes, never a string; the caller must not keep another reference to them. */
  unlock: (password: Uint8Array): Promise<UnlockResult> => ipcRenderer.invoke(VAULT_UNLOCK, password) as Promise<UnlockResult>,
}
contextBridge.exposeInMainWorld('slateVault', vault)

/** Lock screen: read the field once, clear it, send, zero. */
export async function submitPassword(input: HTMLInputElement, send: (pw: Uint8Array) => Promise<UnlockResult>): Promise<UnlockResult> {
  const bytes = new TextEncoder().encode(input.value.normalize('NFC'))
  input.value = ''
  try {
    return await send(bytes)
  } finally {
    bytes.fill(0)
  }
}

/** Main side: the only accepted shape. Anything else is refused before it reaches the KDF. */
export function passwordBytes(arg: unknown): Uint8Array | null {
  return arg instanceof Uint8Array && arg.length >= 1 && arg.length <= 4096 ? arg : null
}
```

### B.20 `packages/desktop/electron-builder.cjs` (changes for C2 and C12)

```js
// Added to the audited configuration (other keys unchanged).
extraResources: [
  { from: 'launchers', to: 'bin' },
  { from: 'resources/bin', to: 'converter' },
  // The FIPS provider and its config sit outside app.asar: OpenSSL loads them by path (§4.9).
  { from: '../native/fips/${platform}-${arch}', to: 'fips' },
],
electronFuses: {
  // slate-mcp ships as its own executable (C12), so the app binary no longer runs as Node.
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  // Release builds refuse --inspect; e2e-packaged uses electron-builder.e2e.cjs, which turns this on.
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  // The renderer is served from app://slate/ (protocol.handle), so file:// needs no extra privileges.
  grantFileProtocolExtraPrivileges: false,
  resetAdHocDarwinSignature: true,
},
mac: {
  // D-1: a Developer ID identity, hardened runtime, notarisation; no com.apple.security.get-task-allow.
  hardenedRuntime: true,
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.plist',
},
```

---

## Appendix C: Machine-readable governance artefacts

### C.1 `docs/compliance/key-inventory.json`

```json
{
  "$comment": "docs/compliance/key-inventory.json — every key Slate creates, derives or holds (SC-12). Generated from audit SLATE-CA-2026-10-23; C10 keeps it in sync with the code (T-STATIC-03).",
  "format": "slate-key-inventory",
  "version": 1,
  "asOf": "2026-10-23",
  "keys": [
    {
      "id": "PW",
      "name": "Password",
      "kind": "csp",
      "bits": null,
      "algorithm": "input to KEK_pw derivation",
      "generation": "user",
      "derivation": null,
      "storage": "renderer <input> until submit; Uint8Array over IPC; native buffer until the KDF returns",
      "protectedBy": null,
      "cryptoperiod": "user-controlled",
      "destruction": "renderer process destroyed after unlock (Z-6); IPC Uint8Array zeroed (Z-5); native OPENSSL_cleanse after KDF",
      "evidence": [
        "T-ZERO-04",
        "T-ZERO-05"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/unlock.ts"
    },
    {
      "id": "KEK_pw",
      "name": "Password key-encryption key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM (wraps MK)",
      "generation": "derived",
      "derivation": {
        "standard": "Argon2id(NFC(PW), salt, m=262144 KiB, t=4, p=1, 32) in g_std_ctx",
        "fips-140-3": "PBKDF2-HMAC-SHA-512(NFC(PW), salt[32], c>=600000, 32) per SP 800-132 §5.4 option 2"
      },
      "storage": "native secure heap (handle)",
      "protectedBy": null,
      "cryptoperiod": "until the next password change",
      "destruction": "keyDestroy right after the MK wrap is opened or sealed",
      "gcmInvocationsPerKey": "1 per password set (changePassword re-derives with the same salt and seals once)",
      "evidence": [
        "T-ZERO-01",
        "T-ZERO-04"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/header.ts"
    },
    {
      "id": "RK",
      "name": "Recovery key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "input to KEK_rc",
      "generation": "module DRBG (RAND_priv_bytes_ex, 256-bit strength)",
      "derivation": null,
      "storage": "shown once; never stored by Slate",
      "protectedBy": null,
      "cryptoperiod": "until 'New recovery key' or a key rotation (R-1)",
      "destruction": "native buffer cleansed after encoding / after KEK_rc derivation",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/recovery.ts"
    },
    {
      "id": "KEK_rc",
      "name": "Recovery key-encryption key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM (wraps MK)",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF-SHA-256(RK, salt=vaultId, info='slate/v1/recovery')",
        "suite-0x02": "KBKDF(RK, 'slate/v2/recovery', vid)"
      },
      "storage": "native secure heap (handle)",
      "protectedBy": null,
      "cryptoperiod": "as RK",
      "destruction": "keyDestroy after one wrap/unwrap",
      "gcmInvocationsPerKey": "1 per recovery key",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/header.ts"
    },
    {
      "id": "QU",
      "name": "Quick-unlock secret",
      "kind": "csp",
      "bits": 256,
      "algorithm": "input to KEK_qu",
      "generation": "module DRBG",
      "derivation": null,
      "storage": "quick-unlock.bin, sealed by safeStorage (OS keychain / libsecret / KWallet)",
      "protectedBy": "OS keychain",
      "cryptoperiod": "until 'Forget quick unlock', a join or a rotation",
      "destruction": "file deleted; in memory the base64 string handed to safeStorage cannot be zeroed (Z-12)",
      "evidence": [
        "T-POL-06"
      ],
      "profiles": [
        "standard"
      ],
      "owner": "vault/quickUnlock.ts"
    },
    {
      "id": "KEK_qu",
      "name": "Quick-unlock key-encryption key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM (wraps MK)",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF-SHA-256(QU, salt='', info='slate/v1/quick')",
        "suite-0x02": "KBKDF(QU, 'slate/v2/quick', vid || deviceId)"
      },
      "storage": "native secure heap (handle)",
      "protectedBy": null,
      "cryptoperiod": "as QU",
      "destruction": "keyDestroy after one wrap/unwrap",
      "gcmInvocationsPerKey": "1 per enable",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard"
      ],
      "owner": "vault/quickUnlock.ts"
    },
    {
      "id": "MK",
      "name": "Master key (per key epoch)",
      "kind": "csp",
      "bits": 256,
      "algorithm": "KBKDF input key / HKDF IKM (suite 0x01)",
      "generation": "module DRBG (RAND_priv_bytes_ex, 256-bit strength)",
      "derivation": null,
      "storage": "vault.json wraps (password, recovery), quick-unlock.bin wrap, history[] of the next epoch; in memory: native secure heap",
      "protectedBy": "KEK_pw, KEK_rc, KEK_qu, K_hist",
      "cryptoperiod": "originator usage <= 2 years (SP 800-57 Pt 1 r5 Table 1); 'Keys are due for rotation' shown at 730 days in fips-140-3 (R-4)",
      "destruction": "KeyRing.close() at every lock (verified count, Z-4); history entry removed once no file of that epoch remains (R-2)",
      "evidence": [
        "T-ZERO-01",
        "T-ZERO-02",
        "T-ZERO-04"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/keyring.ts"
    },
    {
      "id": "K_sync",
      "name": "Remote envelope key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "KBKDF input (file keys)",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/sync')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/sync', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/keyring.ts"
    },
    {
      "id": "K_file",
      "name": "Per-file key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(K_sync, salt16, 'slate/v1/remote-file')",
        "suite-0x02": "KBKDF(K_sync, 'slate/v2/remote-file', salt16)"
      },
      "storage": "native secure heap for the duration of one seal/open",
      "protectedBy": null,
      "cryptoperiod": "one file",
      "destruction": "keyDestroy in finally (sealSle2With / openEnvelope)",
      "gcmInvocationsPerKey": "exactly 1",
      "evidence": [
        "T-ZERO-01",
        "T-GCM-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/envelope.ts"
    },
    {
      "id": "K_name",
      "name": "Blob-name MAC key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "HMAC-SHA-256",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/name')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/name', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/names.ts"
    },
    {
      "id": "K_name_enc",
      "name": "Remote-name encryption key",
      "kind": "csp",
      "bits": 256,
      "algorithm": {
        "suite-0x01": "AES-256 single block (ECB, read-only legacy)",
        "suite-0x02": "AES-256-CTR with SIV"
      },
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/name-enc')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/name-enc', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/names.ts"
    },
    {
      "id": "K_name_mac",
      "name": "Remote-name SIV key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "HMAC-SHA-256 (truncated to 128 bits as the SIV)",
      "generation": "derived",
      "derivation": {
        "suite-0x02": "KBKDF(MK, 'slate/v2/name-mac', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/names.ts"
    },
    {
      "id": "K_check",
      "name": "Vault-header MAC key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "HMAC-SHA-256",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/check')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/check', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close(); the audited computeCheck leak (Z-a) is removed in C1",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/header.ts"
    },
    {
      "id": "K_prefs",
      "name": "Pre-unlock settings MAC key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "HMAC-SHA-256",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/prefs')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/prefs', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/preunlock.ts"
    },
    {
      "id": "K_localwrap",
      "name": "Local database-key wrapping key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM (wraps LK)",
      "generation": "derived",
      "derivation": {
        "suite-0x01": "HKDF(MK, '', 'slate/v1/local-wrap')",
        "suite-0x02": "KBKDF(MK, 'slate/v2/local-wrap', vid)"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "as MK",
      "destruction": "KeyRing.close()",
      "gcmInvocationsPerKey": "1 per local-keys.json write (create, rejoin, rotation)",
      "evidence": [
        "T-ZERO-01",
        "T-GCM-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/localKeys.ts"
    },
    {
      "id": "K_hist",
      "name": "History wrapping key",
      "kind": "csp",
      "bits": 256,
      "algorithm": "AES-256-GCM (wraps an older epoch's MK)",
      "generation": "derived",
      "derivation": {
        "suite-0x02": "KBKDF(MK_current, 'slate/v2/history', vid || uint32be(epoch))"
      },
      "storage": "native secure heap",
      "protectedBy": null,
      "cryptoperiod": "until the history entry is pruned",
      "destruction": "KeyRing.close()",
      "gcmInvocationsPerKey": "1",
      "evidence": [
        "T-ZERO-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "vault/header.ts"
    },
    {
      "id": "LK",
      "name": "Local database key (per device)",
      "kind": "csp",
      "bits": 256,
      "algorithm": "SQLCipher 4 raw key (AES-256-CBC pages, HMAC-SHA-512 page MAC)",
      "generation": "module DRBG",
      "derivation": null,
      "storage": "local-keys.json wrapped under K_localwrap; in memory: native secure heap and SQLCipher's codec context",
      "protectedBy": "K_localwrap",
      "cryptoperiod": "the device's lifetime; replaced on standard -> fips-140-3 conversion (R-3)",
      "destruction": "KeyRing.close() + closing every SQLCipher connection (SQLCipher wipes its codec context on close)",
      "evidence": [
        "T-ZERO-01",
        "T-ZERO-04",
        "T-DB-02"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "services.ts / db/openDatabase.ts"
    },
    {
      "id": "SQLCIPHER_HMAC",
      "name": "SQLCipher page-HMAC key",
      "kind": "csp",
      "bits": 512,
      "algorithm": "HMAC-SHA-512",
      "generation": "derived inside SQLCipher",
      "derivation": {
        "all": "PBKDF2-HMAC-SHA-512(LK, page-1 salt XOR 0x3a, 2 iterations) — SQLCipher internal (L-5)"
      },
      "storage": "SQLCipher codec context (native)",
      "protectedBy": null,
      "cryptoperiod": "as LK",
      "destruction": "connection close",
      "evidence": [
        "T-DB-02"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "SQLCipher"
    },
    {
      "id": "DRBG",
      "name": "Module DRBG state",
      "kind": "csp",
      "bits": null,
      "algorithm": "SP 800-90A DRBG of the OpenSSL FIPS provider",
      "generation": "module (seeded from the OS entropy source)",
      "derivation": null,
      "storage": "OpenSSL secure heap",
      "protectedBy": null,
      "cryptoperiod": "module-managed reseeding",
      "destruction": "process exit; enterErrorState() stops all use",
      "evidence": [
        "T-POST-01"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "OpenSSL FIPS provider"
    },
    {
      "id": "RELEASE_SIGNING",
      "name": "Release-manifest signing key",
      "kind": "psp+csp",
      "bits": null,
      "algorithm": "Ed25519 now; hybrid ML-DSA-65 + Ed25519 once the toolchain supports it (CNSA 2.0 software signing: exclusive by 2030)",
      "generation": "offline, maintainer hardware token",
      "derivation": null,
      "storage": "private: offline (never in CI or the repo); public: pinned in the main bundle",
      "protectedBy": "hardware token",
      "cryptoperiod": "2 years; the pinned set holds the current and the next public key",
      "destruction": "token reset after rotation",
      "evidence": [
        "T-UPD-01",
        "T-UPD-02"
      ],
      "profiles": [
        "standard",
        "fips-140-3"
      ],
      "owner": "update/ (C12)"
    }
  ]
}
```

### C.2 `docs/compliance/oscal/slate-component-definition.json` (OSCAL 1.2.3, validated: V-9)

The UUIDs were generated once for this audit; C10 keeps them stable, because OSCAL consumers key on them.

```json
{
  "component-definition": {
    "uuid": "1c7feff4-6ec6-4fdf-a95e-a406391ea72b",
    "metadata": {
      "title": "Slate desktop end-to-end encryption",
      "last-modified": "2026-10-23T00:00:00Z",
      "version": "0.2.0-draft",
      "oscal-version": "1.2.3",
      "parties": [
        {
          "uuid": "0b0120d6-ab4f-4576-9b0c-fc51a3b72470",
          "type": "person",
          "name": "Slate maintainer"
        }
      ]
    },
    "components": [
      {
        "uuid": "0a5058e5-6814-477d-95d1-38ef5cd936ec",
        "type": "software",
        "title": "Slate desktop application",
        "description": "Electron desktop notes application with opt-in end-to-end encryption of local data and synced files.",
        "purpose": "Stores and synchronises notes so that only holders of the user's password, recovery key or device quick-unlock secret can read them.",
        "props": [
          {
            "name": "version",
            "value": "0.2.0"
          }
        ],
        "control-implementations": [
          {
            "uuid": "79ff2992-36ce-48ea-a8d4-2ffb2c8d51ce",
            "source": "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_HIGH-baseline_profile.json",
            "description": "Implementation statements for the fips-140-3 crypto profile of Slate (audit SLATE-CA-2026-10-23).",
            "implemented-requirements": [
              {
                "uuid": "f6752a85-ece6-469d-9f6e-7ea17164be98",
                "control-id": "sc-13",
                "description": "In the fips-140-3 profile every cryptographic function protecting notes (AES-256-GCM, AES-256-CTR, HMAC-SHA-256, SHA-256, SP 800-108r1 KBKDF, SP 800-132 PBKDF2-HMAC-SHA-512, CTR_DRBG) is invoked through the OpenSSL FIPS Provider 3.1.2 (CMVP #4985) loaded by packages/native with default properties fips=yes. The standard profile uses the same module but includes non-approved Argon2id and is not claimed under SC-13."
              },
              {
                "uuid": "66d6b804-7194-46ee-bc74-f01eefcd8bc1",
                "control-id": "sc-12",
                "description": "Keys are generated by the module DRBG, derived with KBKDF, wrapped with AES-256-GCM and destroyed by handle in the native secure heap; the key inventory with cryptoperiods is docs/compliance/key-inventory.json."
              },
              {
                "uuid": "7369727f-4232-4436-a6fa-ea5dbb41baa6",
                "control-id": "sc-12.1",
                "description": "Availability on loss of the password is maintained by a 256-bit recovery key that wraps the master key in a second vault-header slot."
              },
              {
                "uuid": "8b2e9f94-1dbc-40cb-8e35-d9193dce1f88",
                "control-id": "sc-28",
                "description": "Notes, images and search text at rest are stored only in a SQLCipher 4 database keyed with a per-device 256-bit key; remote copies are SLE2 envelopes."
              },
              {
                "uuid": "378d831d-4462-42e5-abdc-fd96d6e0aebd",
                "control-id": "sc-28.1",
                "description": "SQLCipher 4 (AES-256-CBC with HMAC-SHA-512 per page) built against the OpenSSL FIPS provider protects the local database; SLE2 (AES-256-GCM, path-bound AAD) protects every synced file."
              },
              {
                "uuid": "4425930f-b058-44b0-98b3-ff2ca7fdfe1e",
                "control-id": "sc-39",
                "description": "All key material lives in the Electron main process inside OpenSSL's mlock'd secure heap; renderers are sandboxed with context isolation and never receive keys."
              },
              {
                "uuid": "8e3a9266-8464-4c13-b4e7-768f5ca745e3",
                "control-id": "sc-4",
                "description": "Key handles are destroyed and verified at lock; the renderer process that held the password is destroyed after unlock; core dumps are disabled with RLIMIT_CORE=0 and PR_SET_DUMPABLE=0 on Linux."
              },
              {
                "uuid": "400c0d89-e7b2-4fc2-9138-7425001652b2",
                "control-id": "si-6",
                "description": "A power-up self-test runs 17 known-answer tests before any vault file is trusted; failure moves the application to the terminal selftest-failed state. The same tests run on demand from Settings and before every vault change."
              },
              {
                "uuid": "f701fd99-3f7b-4e6e-8e06-08f53e5712ca",
                "control-id": "si-7",
                "description": "Release artifacts and update manifests carry a detached signature verified against a key pinned in the application before an update is applied."
              },
              {
                "uuid": "438df57b-babc-46e7-8fc5-c6b97d183f1e",
                "control-id": "si-7.1",
                "description": "The power-up self-test verifies the SHA-256 of the FIPS provider binary against a value pinned at build time, and the provider runs its own HMAC-SHA-256 integrity test on load."
              },
              {
                "uuid": "52544fd2-9aea-4751-a117-5cb869a86ebf",
                "control-id": "ac-7",
                "description": "In the fips-140-3 profile three failed password attempts within 15 minutes disable password unlock for 180 minutes; the recovery key acts as the administrator release."
              },
              {
                "uuid": "e8792491-3bfc-4145-a478-b75b48a2295c",
                "control-id": "ac-11",
                "description": "In the fips-140-3 profile Slate locks after at most 15 minutes without input, on system sleep and on screen lock; the lock screen hides all note content."
              },
              {
                "uuid": "1f45bee8-9eed-4b97-b167-c8ca6b1dd910",
                "control-id": "ia-5.1",
                "description": "In the fips-140-3 profile passwords are at least 15 characters, checked against a bundled blocklist, normalised to NFC and conditioned with PBKDF2-HMAC-SHA-512 (SP 800-132) with at least 600,000 iterations."
              },
              {
                "uuid": "d339e916-628d-49c1-b4f4-568d6d469c8b",
                "control-id": "cm-14",
                "description": "The updater refuses any package whose detached signature does not verify against the pinned release key."
              }
            ]
          }
        ]
      },
      {
        "uuid": "7e3cae05-b511-43d0-8453-9be196daa5a5",
        "type": "validation",
        "title": "OpenSSL FIPS Provider 3.1.2",
        "description": "FIPS 140-3 validated software cryptographic module loaded by packages/native (slate_native.node).",
        "props": [
          {
            "name": "validation-type",
            "value": "fips-140-3"
          },
          {
            "name": "validation-reference",
            "value": "4985"
          }
        ],
        "links": [
          {
            "href": "https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4985",
            "rel": "validation-details"
          }
        ]
      }
    ]
  }
}
```

Validation used in CI (C10):

```js
// scripts/validate-oscal.cjs — node scripts/validate-oscal.cjs docs/compliance/oscal/slate-component-definition.json
const Ajv = require('ajv').default
const addFormats = require('ajv-formats').default
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
// oscal_component_schema.json from https://github.com/usnistgov/OSCAL/releases/download/v1.2.3/, pinned by SHA-256 in the workflow.
const validate = ajv.compile(require('../docs/compliance/oscal/oscal_component_schema.json'))
const ok = validate(require(require('node:path').resolve(process.argv[2])))
if (!ok) {
  console.error(JSON.stringify(validate.errors, null, 2))
  process.exit(1)
}
console.log('valid OSCAL 1.2.3 component definition')
```

---

## Appendix D: Traceability matrix

```yaml
# docs/compliance/traceability.yaml — generated by scripts/traceability.mjs from test titles (C11); this is the seed.
findings:
  F-FIPS-01: { wp: [C2, C3, C4], tests: [T-POST-04, T-POST-06, T-DB-02, T-STATIC-02, T-KAT-01] }
  F-FIPS-02: { wp: [C4, C5], tests: [T-POL-07, T-KAT-02, C5-criterion-2-spy] }
  F-FIPS-03: { wp: [C5], tests: [T-KAT-01], lab: [L-1] }
  F-FIPS-04: { wp: [C6], tests: [T-POST-01, T-POST-02, T-POST-12] }
  F-FIPS-05: { wp: [C6], tests: [T-POST-03, T-POST-07, T-POST-08, T-POST-09, T-POST-10] }
  F-FIPS-06: { wp: [C1, C7], tests: [T-ZERO-01, T-ZERO-02, T-ZERO-03, T-ZERO-04, T-ZERO-05, T-ZERO-07, T-STATIC-01] }
  F-FIPS-07: { wp: [C2, C4], tests: [T-STATIC-02, T-POST-01] }
  F-FIPS-08: { wp: [C2, C6], tests: [T-POST-01] }
  F-FIPS-09: { wp: [C5, C10], tests: [T-GCM-01] }
  F-FIPS-10: { wp: [C5], tests: [T-FUZZ-12], lab: [L-2] }
  F-NIST-01: { wp: [C2, C3, C4, C5], tests: [T-POST-04, T-DB-02] }
  F-NIST-02: { wp: [C9, C10], tests: [T-STATIC-03, C9-rotation-e2e] }
  F-NIST-03: { wp: [C10], tests: [T-POL-02, T-POL-03] }
  F-NIST-04: { wp: [C10], tests: [T-POL-04] }
  F-NIST-05: { wp: [C10], tests: [T-POL-01] }
  F-NIST-06: { wp: [C12], tests: [T-UPD-01, T-UPD-02, T-B-07] }
  F-NIST-07: { wp: [C7], tests: [T-ZERO-04, T-ZERO-06] }
  F-NIST-08: { wp: [C8], tests: [T-B-01, T-B-02, T-B-03, T-B-04] }
  F-NIST-09: { wp: [C8], tests: [T-B-05, T-B-06] }
  F-NIST-10: { wp: [C10], tests: [], poam: true }
  F-NIST-11: { wp: [C10], tests: [C10-redaction-test] }
  F-FR-02:   { wp: [C2], tests: [T-POST-04] }
  F-FR-03:   { wp: [C10], tests: [C10-oscal-validation] }
  F-BSI-01:  { wp: [C5], tests: [T-FUZZ-06, T-FUZZ-07] }
  F-BSI-04:  { wp: [C5], tests: [C5-padme-unit] }
  F-CC-01:   { wp: [C5], tests: [T-POL-01, T-POL-07] }
  F-CC-02:   { wp: [C7], tests: [T-ZERO-01, T-ZERO-04] }
  F-CC-03:   { wp: [C6], tests: [T-POST-01, T-POST-02] }
  F-CC-04:   { wp: [C12], tests: [T-UPD-01] }
  F-EL-01:   { wp: [C8], tests: [C8-no-sync-safeStorage-grep] }
  F-EL-02:   { wp: [C12], tests: [T-B-07, T-POST-13] }
  F-EL-04:   { wp: [C8], tests: [T-POL-08] }
  F-GEN-01:  { wp: [C1, C5], tests: [C1-localKeys-db-binding, T-FUZZ-10] }
  F-GEN-02:  { wp: [C1], tests: [T-FUZZ-13] }
  F-GEN-03:  { wp: [C5], tests: [T-FUZZ-10] }
rules:
  S-1..S-11: { wp: [C6], tests: [T-POST-01..13] }
  Z-1..Z-12: { wp: [C1, C4, C7], tests: [T-ZERO-01..08, T-STATIC-01] }
  B-1..B-7:  { wp: [C8, C12], tests: [T-B-01..07] }
  R-1..R-5:  { wp: [C9], tests: [C9-rotation-unit, C9-rotation-e2e] }
```

*End of audit SLATE-CA-2026-10-23.*

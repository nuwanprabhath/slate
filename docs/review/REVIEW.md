# Review checklist

What a review agent (`.claude/agents/security-reviewer.md`, `.claude/agents/architecture-reviewer.md`)
applies to `git diff <base>...<branch>`. Read the diff, then the files it touches in full, then what
they import. Cite `file:line` for every finding. A finding nobody can reproduce or locate is not a
finding.

## Which review a branch needs

`reviewTier` in `scripts/agents/review-gate.mjs` decides, and `merge-wp` and the Stop hook use it:

| Tier | When | Review file (main checkout) |
| --- | --- | --- |
| Security | Any path in `tools/guards/security-paths.txt` (vault, db, sync, native, the IPC door, preload, CSP, hardening, update, packaging, manifests, configs, the product-rule `spec/` tests, the guard layer), any file named in an allowlist, or a risky change anywhere (child process, crypto, `process.env`, skips, inline lint comments, ungated IPC policies, TLS or window security, SQL text, `require`, a removed `expect(`) | `.agent-reports/reviews/<branch with / as ->.md`, by the security reviewer (Security and Compliance sections) |
| Architecture | Other main-process code (`tools/guards/architecture-paths.txt`: the rest of `src/main` and `src/shared`, `src/mcp`, `packages/{sync,mcp,importer}/src`) with nothing risky in it | `<branch with / as ->.architecture.md`, by the architecture reviewer (Architecture section); a security review also covers it |
| None | Renderer and editor code, docs, and plain test files with nothing risky | — |

Plain test files never set a tier by their path; their risky lines (a skip, a removed expectation) do.

**Every finding names the guard that should have caught it** (a `slate/*` rule, a guard test, a
type, a hook), **or proposes one**: the check, where it lives, and the real line from this diff it
would have failed on. A review that only finds bugs leaves the next agent free to repeat them; the
`correct` skill (`.claude/skills/correct/SKILL.md`) turns the proposal into the check.

## Security

- **Keys.** Key bytes live in the `KeyRing` (and, after C4, only behind `@slate/native` handles).
  No new copy (`Buffer.from(key)`, `Buffer.concat`, `.toString`, template literal, `JSON.stringify`,
  `structuredClone`, `postMessage`, `workerData`: audit Z-2). Every buffer holding a key or password
  is zeroed in `finally`, owned by one function (Z-1, Z-3). Services keep no key after their
  constructors (phase 10 F1 #7). Outside main/vault and main/db a `KeyBytes` is used only through
  `withKeyBytes(key, fn)` and zeroed with `zeroKey`; look at every `ring.get(`, `vaultKeyBuffer(`
  and `.toString('hex'|'base64')` the review gate lists as "key material" (red team G2-5, G2-8).
- **Secrets.** No secret, password, token, key or note content in logs (`log.*` gets ids, counts and
  our own error messages), errors shown to the user, IPC results, settings or files outside the vault.
  `safeStorage` only through the sanctioned module; no plaintext fallback (B-5).
- **IPC.** Every new channel: `CH` entry, `CHANNEL_POLICY` row with the least access that works
  (`pre-unlock` needs a reason), one handler on the registrar, every argument validated in main
  (type, length, range), nothing trusted from the renderer (paths, ids, URLs). No new `send` channel
  that does something while locked.
- **Renderer.** No Node, Electron, network or eval; no HTML from strings; the CSP not loosened; no
  `webPreferences` weakened; `openExternal` only through `openExternalSafe`.
- **Crypto.** No new primitive outside `vault/crypto.ts` (after C4: outside `@slate/native`). AEAD
  with a fresh IV per seal; associated data binds the path or id; no ECB, no `Math.random`, no
  home-made KDF; constant-time compares for MACs.
- **Files.** Vault files through `writeJsonAtomic`; paths from the renderer never reach `fs`; temp
  files cleaned; permissions `0o600` for anything secret; crash at every step leaves the old state
  or the new one, never a mix (look for the crash test).
- **Sync.** Nothing leaves the machine unsealed (`EncryptingDrive`); a hostile remote cannot stop
  sync or overwrite local data silently; only the sync branch is fetched.
- **Update.** Downloads verified against the manifest digest; no new trust in an unsigned source.
- **Logging.** Through the logger only; redaction stays in `src/shared/redact.ts`.
- **Tests.** The change has a test that fails without it; security behaviour is tested at the
  cheapest layer that proves it (a main-process test beats an e2e spec); no `.only`, no unexplained
  `.skip`; test hooks added to `TEST_HOOK_VARS` and scrubbed when packaged.

## Architecture

- **Boundaries.** Each import respects the package table in `docs/architecture/golden-paths.md`.
- **One owner per state.** `services()` owns everything that touches notes; the vault state machine
  owns the vault state; no second cache of either.
- **Golden paths.** New IPC, settings, vault files, crypto, tables, test hooks, dependencies, URLs,
  windows and e2e specs follow `golden-paths.md`. A new way of doing one of those is a finding unless
  the branch also updates `golden-paths.md` and the check.
- **Guards untouched.** No growth in `tools/guards/allowlists/*.json` (except an approved
  dependency) or `eslint-suppressions.json`; no disable comment for a guard rule; no edit to a guard
  file outside a guardrail branch.

## Compliance

Each work package of phase 11 implements audit `docs/reviews/compliance_audit.md` (SLATE-CA-2026-10-23)
as amended by `docs/compliance/decisions.md`. Check the finding (`F-*`), rule (`S-*`, `Z-*`, `B-*`,
`R-*`) and test (`T-*`) ids the branch claims against its code and test titles. A claimed id with no
code or test behind it is a finding.

## Severity

| Severity | Meaning | Merge? |
| --- | --- | --- |
| Critical | Key or note content exposed, auth or the vault gate bypassable, remote code execution, data loss | Blocks |
| High | A rule in the table above broken in a reachable path; a security claim with no test | Blocks |
| Medium | A rule broken in an unreachable or test-only path; a missing guard for a new invariant | Blocks unless the maintainer accepts it in writing |
| Low | Clarity, naming, a comment that states history | Does not block |

## Output

Write the review to `.agent-reports/reviews/<branch with / as ->.md` in the **main checkout** (for `phase11/g1`: `phase11-g1.md`); merge-wp reads reviews only there, where an agent in an isolated worktree cannot write:

```
# <Security|Architecture> review: <branch>

Reviewed: <full sha of the branch head reviewed>
Base: <base sha>

## Findings

### <SEVERITY>: <one-line title>
- Where: <file:line>
- What: <what is wrong, and how it is reached>
- Fix: <the change>
- Guard: <the check that should have caught it, or the one to add (rule/test, file, the line it fails on)>

## Checked and cleared
- <what you looked at and why it is fine>

VERDICT: APPROVE
```

The last line is exactly `VERDICT: APPROVE` or `VERDICT: CHANGES`. Any Critical, High or unaccepted
Medium finding means `VERDICT: CHANGES`. `scripts/agents/merge-wp.sh` merges a branch that touches a
security path only when this file approves the branch's current head.

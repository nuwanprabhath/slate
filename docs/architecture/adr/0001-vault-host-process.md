# 0001. A vault host process for the database, crypto, sync and search

- **Proposed:** 2026-11-12, work package A3 of the 2026-11-10 architecture review (finding F5).
- **Recommendation of this record:** **defer the host process; proceed now with the `index.ts` split
  (stage 1) and the per-subsystem yielding of stage 2.** The reasoning is in "Decision".
- **Decision (maintainer, accept / reject / defer):** &nbsp;
  <!-- maintainer: write accept, reject or defer and the date on the line above. Do not fill this in for them. -->

## Context

### What the review said, and what measurement corrected

The review's finding F3 framed vault-proportional work as a keystroke-latency problem: sync scans and
decodes every document "on the thread that routes key presses", with Loro-decode figures of 0.21 s at
500 pages and 1.7 s at 2,000 (synthetic pages, Node, SQLite and SQLCipher cost excluded).

**That framing was wrong, and work package D4 corrected it by measurement.** Typing is local to the
renderer. Key latency stayed inside the product budget at every vault size tested, during a sync that
was scanning the whole vault:

| vault | key latency p50 / p95 | budget | source |
| --- | --- | --- | --- |
| 500 pages, first sync | 9.2 / 17.1 ms | median < 16 ms, p95 < 33 ms | report D4B, load 15.9 |
| 2,000 pages, first sync | 9.2 / 17.6 ms | same | report D4B, load 19.8 |

What stops is **the main process**, and with it everything the renderer asks of main: saving, opening a
page, search, images. The probe measures this directly as the round trip of `CH.appVersion`, a handler
that returns a string, so its latency is purely main's event-loop latency.

### Where that leaves the problem after Track B

Work package B3 (merged) made sync touch only documents that changed. The steady state is now fixed and
needs nothing from this record:

| vault | steady-state sync, worst main round trip | bar | source |
| --- | --- | --- | --- |
| 500 pages | **9.2 ms** | 100 ms | report D4B, load 15.9 |
| 2,000 pages | **34.4 ms** | 100 ms | report D4B, load 19.8 |

Before B3, the same measurement was 6,669.9 ms at 500 pages and 64,599.1 ms at 2,000 (report D4, loads
22.7 and 29.6). B3 closed a gap of two to three orders of magnitude.

What remains is every path that is *inherently* vault-proportional, of which the first sync against a
fresh remote is the one now measured:

| vault | first sync against a new remote, worst main-process stall | source |
| --- | --- | --- |
| 500 pages | **4,143.6 ms** (also 4,326.3 / 4,480.5 / 5,845.5 ms) | report D4B, loads 15.9 / 21.5 / 24.8 / 24.9 |
| 2,000 pages | **35,596.0 ms** (also 44,828.6 / 63,869.4 ms) | report D4B, loads 19.8 / 21.4 / 98.4 |

So the live case for this record is not "sync steals the keystroke thread". It is that **main still owns
the SQLCipher database, every vault key, the search index, the importer and the in-app MCP server, and
any one of them doing vault-proportional work freezes everything the person can see.** The first sync is
the measured instance; the review's F5 lists the unmeasured others by code reading: the full search-index
build (`searchIndex.ts:69`) is not time-sliced, a user regex runs over every indexed row in main
(`searchIndex.ts:102-104`) so a backtracking pattern freezes the app including the idle lock, the in-app
MCP `search` decodes every shared page per query (`packages/mcp/src/tools.ts:89`), and a notebook edit
issues one `UPDATE` per page (`searchIndex.ts:184`).

A related defect is being fixed separately as work package B8 and is **not** an argument for this record:
`gitRunner.ts` allows 10 s for a local git command and 60 s for a network one, which is not enough for
git over 2,000+ files, so `gitError` turns the timeout into an `OfflineError` and a large vault's first
sync ends `offline` and can never be put on a remote (report D4B: pushed 0, states
`idle-synced -> syncing -> offline -> syncing -> offline`, load 21.4). That is a timeout bug, fixable in
place.

### The constraint that makes this hard

`packages/native/index.ts` refuses to load the addon off the main thread:

> `if (!isMainThread) throw new Error('@slate/native loads on the main thread only')`
> — "The addon's state is process-wide: only the main thread may hold it (review N3; binding.c refuses
> too)."

`binding.c` refuses as well. SQLCipher is reached only through `databaseClass(native)`, so the database
cannot be moved to a `worker_threads` worker at all. A **`utilityProcess`** is a different matter: it is
its own OS process with its own main thread, so the addon would load there legitimately, with no change
to the module's rule. That is why the only shape worth evaluating is a process, not a thread.

### The second half of F5: the composition root

`packages/desktop/src/main/index.ts` is 1,106 lines, of which roughly 980 are one `app.whenReady()`
closure holding about twenty mutable variables — `makingTestVault`, `lastSelfTest`, `selfTestFailure`,
`prefs`, `flushing`, `auth`, `currentDbFile`, `updates`, `failures`, `passwordChangedElsewhere`,
`preunlockTampered`, `screenLock`, `locking`, `quitting`, `flushSeq`, `mcp`, `quickUnlockFailed` and
more — spanning lock, quit, migration, quick unlock and the self-test. Lifecycle fixes keep landing in
that one function because the state they need is only visible there.

Work package C4 (merged) is the useful evidence about how tractable splitting it is. C4 took the quit
sequence out of `index.ts` and expressed it as `runShutdown` beside `runLock` in
`vault/lockSequence.ts`, factoring the bounded flush and the per-step `attempt` wrapper so that lock and
quit share one handshake instead of two. The ordered steps are an interface (`LockSteps`) that
`index.ts` supplies and a test can drive: C4's DoD case is a fake renderer holding one unwritten edit
and a fake store that refuses writes once closed. C4's own report notes it deliberately did not
restructure `index.ts` because this record owns that question. The lesson is positive and specific: a
lifecycle concern comes out cleanly when its *steps* are named as an interface and the mutable state
stays behind `VaultStateMachine` and an injected steps object. It is also narrow — C4 moved a sequence,
not ownership of state.

## Options considered

### A. Do nothing beyond Track B

Steady-state sync is inside budget (9.2 ms / 34.4 ms). The remaining freeze is a first sync, which
happens once per vault per remote, and the release note wording D4B proposes is honest about it.
Cost: zero. Leaves the first-sync freeze, the un-sliced index build, the regex-in-main freeze and the
MCP per-query scan — and leaves `index.ts` as it is, so lifecycle fixes keep landing in one closure.

### B. Vault host process (`utilityProcess`) owning keys, database, sync and search

Main keeps windows, menus, the IPC registrar and message routing. Everything that holds a key or reads
the vault moves to one child process.

- **How a typed secret reaches the host without passing through main.** Today the lock window sends the
  password or recovery key as `SecretBytes` over IPC to main, which checks the shape, passes the bytes
  to the module, and zeroes its copies (`vaultIpc.ts`'s `secretHandler` zeroes every secret argument on
  every exit; `slate/secret-bytes-stay-bytes` and `slate/secrets-out-of-react-state` enforce the rest).
  With a host, main would be a party to the secret for no reason. The accepted shape is instead: main
  creates a `MessageChannelMain`, hands one port to the `utilityProcess` at spawn and **transfers the
  other port to the lock window**, so `submitSecret` posts the bytes over a port whose other end is the
  host. Main never sees them; it only routes the port, once, before any secret exists.
  - This collides with a guardrail as written: `slate/ipc-through-registrar` names `MessageChannelMain`
    specifically, because a raw channel "skips the vault gate (`CHANNEL_POLICY`) and the rejection log".
    The guardrail is right, and the collision is resolvable only by making the port a *registrar
    concept*: `createIpc` mints and transfers vault ports, each with its own policy row saying which
    states it may be live in, and the port is revoked on `locking`. A port minted anywhere else stays
    refused. **This is the single largest piece of design work in option B, and it is in the security
    path.** It is not a line of config.
  - `secretHandler`'s zeroing still applies, in the host, with the same guard test pointed at the host's
    handler table.
- **Self-test gate, `failClosed`, `hardenProcess`.** All three are properties of *the process that holds
  the module*, so all three move to the host and none of them can stay only in main.
  - `hardenProcess()` is called from `native/cryptoModule.ts:139` after load; it makes the process
    non-dumpable with no core file. In option B the **host** must be hardened before the first key, and
    main — which no longer holds keys — keeps its own call, since it still handles the sudo secret in
    `update/ipc.ts`. Two hardened processes, not one.
  - The POST must gate the host: the module starts gated (`postGate`) and nothing runs until `runPost`
    passed, the vault starts in `selftest`, `selftest-failed` is terminal. Today main both runs the POST
    and refuses IPC outside `SELF_TEST_POLICY`'s channels. Split, the host runs the POST and owns the
    verdict, and main must refuse the same channels *on the host's word*, which means the host's state is
    authoritative and main's copy is a cache. A cache of the gate state is a new failure mode: if the
    host dies between verdict and report, main must treat the absence of a verdict as failure, not as
    "not yet".
  - `failClosed` (`vault/selftest/supervisor.ts:75`) today enters the module's error state, closes every
    connection and drives `VaultStateMachine`. In the host, the module error state and the connections
    are in the host; the state machine, the windows and the lock screen are in main. Fail-closed
    therefore becomes a two-process protocol, and the honest requirement is stronger than it sounds:
    **host death from any cause must be indistinguishable from `failClosed`** — main must treat an
    unexpected host exit as a self-test failure and show the terminal error page, or a crash becomes a
    silent downgrade. `FaultSupervisor`'s "wait until the current self-test ends" logic has to survive
    that crossing.
- **FIPS boundary statement in `docs/compliance/security-policy.md`.** The claim in §1 says every
  cryptographic operation that protects notes is performed by the FIPS provider in its approved mode,
  that Slate runs a power-up self-test, enters a terminal error state on any failure, and destroys key
  material at lock. Nothing in that claim is about *which* process, so the claim itself survives. What
  must change is the surrounding description, in four places: (1) §1's "Host library … statically linked
  into `@slate/native`" gains the statement that the module is loaded in exactly one process, the vault
  host, and that main holds no key material; (2) the power-up self-test sentence must say the POST runs
  in the host before any key and that the host's terminal error state is propagated to the UI process;
  (3) the "destroys key material at lock" sentence must cover host exit as well as lock, since killing
  the host is now a way key material ends; (4) a new caveat belongs beside the existing ones (Slate not
  validated, TLS outside the module, malware-as-the-user outside the threat model): **the port that
  carries a typed secret from the lock window to the host is Slate's own IPC, not the module's, and is
  outside the module boundary** — exactly the status the existing text already gives OS entropy and TLS.
  The `crypto-module.json` record and the OSCAL component definition need the same process statement.
  Also: `vault/fipsProfile.test.ts`, `tools/guards/selfTest.test.ts` and the `addon.test.ts` / `kat.c`
  gate cases all assert against a single-process arrangement and would have to be re-expressed.
- **Cost of the hop.** See "Measured baseline": the per-keystroke cost is **not measured**, and the
  measured neighbouring numbers suggest it is small and not on the keystroke path at all.

### C. Host process for sync and search only, keys and database staying in main

Avoids the secret-port design, the FIPS boundary rewrite and the two-process fail-closed protocol. But
sync and search cannot work without reading the vault, and the database can only be opened where the
addon is — so this option needs either a second SQLCipher connection in the host (which means the key is
in the host, i.e. option B's problems arrive anyway) or a request-per-document channel back into main,
which puts the vault-proportional work back on main's loop. **Rejected as incoherent given
`index.ts:230`.** It is recorded because it is the obvious first idea.

### D. Keep one process; make each vault-proportional path yield

Time-slice the search-index build, bound the user regex (or run it over batches with a yield between),
page the MCP search, batch the notebook `UPDATE`, and chunk the first sync's scan so main's loop
breathes between documents. No new process, no boundary change, no secret-port design. Each fix is
local and separately testable, and `e2e/perf-vault-scale.spec.ts` (D4/D4B) already measures the main
round trip, so each one has a ready scoreboard. What it does not give: a hard guarantee. Yielding is a
discipline every future main-process author must keep, and nothing in the guard layer enforces it, where
a process boundary would make the mistake impossible.

### E. Split `index.ts` into lifecycle modules behind `VaultStateMachine`, with no process change

The review's stage 1, on its own: `lifecycle/{lock,quit,migration,quickUnlock,selfTest}.ts`, each
exporting a steps interface and a sequence, as C4 did for lock and quit. No behaviour change, no
boundary change, directly testable, and a prerequisite for option B in any case.

## Decision

**Recommended: defer option B. Do E now, then D. Revisit B only on evidence E and D cannot produce.**

The numbers are the reason, and they point away from the large refactor:

1. **The problem B was proposed to solve has mostly been solved by a cheaper change.** B3 took the
   steady-state main stall from 6,669.9 ms to 9.2 ms at 500 pages and from 64,599.1 ms to 34.4 ms at
   2,000 (reports D4 and D4B). A 100 ms bar is met with 3x headroom at 2,000 pages. Proposing a
   process-boundary rewrite the week a 700x improvement landed inside one process is not supported by
   the evidence.
2. **What remains is one measured freeze, and it is a once-per-vault event.** 4.1 s at 500 pages and
   35.6 s at 2,000 on first sync against a new remote (D4B). That is bad and must be fixed; it does not
   on its own justify moving every key in the product into a new process, because chunking that one scan
   (option D) addresses exactly it, with the probe already in place to prove it.
3. **The cost side of B is concentrated in the security path, and is not measurable in advance.** The
   secret port must become a registrar concept without weakening `slate/ipc-through-registrar`; the POST
   verdict becomes a cross-process cache whose absence must fail closed; host death must be
   indistinguishable from `failClosed`; and four statements plus two machine-readable records in the
   compliance set have to be rewritten and re-audited. Every one of those is a place where a mistake is
   silent and serious — a vault that opens when the self-test did not pass is worse than a vault that
   freezes for 35 s. The performance gain, against the post-B3 baseline, is the first-sync stall and the
   unmeasured F5 paths; the risk is the vault's own gate.
4. **The composition-root half of F5 is real, independent of B, and cheap.** C4 proved the pattern works
   on the hardest sequence in the file. Option E is where the review's complaint ("lifecycle fixes keep
   landing in the same function") is actually paid off, and it is a prerequisite for B, so doing it first
   costs nothing even if B is later accepted.

**Deferral is conditional, not permanent.** Reopen this record if any of these becomes true:

- Any of F5's unmeasured paths is measured over 100 ms on main after being sliced — i.e. option D is
  tried on it and fails. (The regex-over-every-row path is the likeliest, since a backtracking pattern
  has no safe slice size.)
- Steady-state sync exceeds 100 ms at a vault size people actually have; the committed probe runs at 500
  pages and should be raised as evidence arrives.
- A product requirement arrives that needs the database open while the UI process is replaced — a
  renderer crash-recovery or a live-update requirement would make B structural rather than performance
  work.
- Third-party plugin code is ever admitted (ADR 0002), which changes the threat model: then "main holds
  every key beside the decrypted notes" stops being merely a performance statement.

### Staged plan (the order to do it in, whatever is decided about B)

- **Stage 1 — `index.ts` split, behind `VaultStateMachine`.** `lifecycle/{lock,quit,migration,
  quickUnlock,selfTest}.ts`. Each module exports a steps interface and a sequence in C4's shape
  (`runLock`/`runShutdown`); `index.ts` keeps construction and supplies the steps. Mutable state moves
  with its sequence, with one owner each, and nothing new reads `vault.state` that did not before. No
  behaviour change; the DoD test for each module is a fake-steps test, as `lockSequence.test.ts` is.
  **Recommended now.** Blocked only on Track C releasing `index.ts`.
- **Stage 2 — make each vault-proportional path yield (option D), each with a probe assertion.** First
  the first-sync scan, then the search-index build, then the user regex, then MCP search, then the
  notebook `UPDATE`. `e2e/perf-vault-scale.spec.ts` is the scoreboard; the steady-state case already
  asserts the 100 ms bar, and each new path should get a case next to it. **Recommended now,
  sequenced after B8's git timeouts, since a large vault cannot complete a first sync until then.**
- **Stage 3 — spike the host boundary, no migration.** Only if stage 2 leaves a path over the bar. Spawn
  a `utilityProcess` that loads `@slate/native`, runs the POST there, and measures: addon load and POST
  cost in a child, the transferred-port round trip under load, and crash propagation. Decide B on those
  numbers, not on this record's reasoning.
- **Stage 4 — migrate, keys first.** Keys and database, then sync, then search, then the importer and
  MCP. Each step keeps `failClosed` provable across the boundary before the next begins, and the
  compliance edits land with the step that makes them true, not after.

## Consequences

**If deferred (the recommendation).**

- The first-sync freeze stays until stage 2 reaches it; the release note D4B drafted is the honest
  user-facing statement in the meantime.
- F5's unmeasured paths stay unmeasured until each is probed. The commitment this record makes is to
  measure before optimising, which is CLAUDE.md's own judgment call.
- The guarantee stays a discipline: nothing stops a future main-process change from reintroducing an
  unbounded loop. The counterweight is the committed probe, which asserts the 100 ms bar in CI at 500
  pages — weaker than a process boundary, and the honest cost of deferring.
- Every key still lives beside the decrypted notes in main. That is tolerable **only** while all code in
  main is first-party; see ADR 0002.
- Stage 1 still lands, so the composition-root finding is closed either way.

**If accepted.**

- Main holds no key material, and a vault-proportional stall can no longer reach the UI process. That is
  the whole prize and it is a real one.
- The FIPS boundary statement, `crypto-module.json`, the OSCAL component definition and the self-test
  guard tests all change together, and the compliance audit (SLATE-CA-2026-10-23) needs a delta review
  before the claim can be made again. Expect that to gate the release, not the code.
- Two hardened processes, one module, one POST, and a fail-closed path that must survive a crash it
  cannot see directly. A new terminal state ("host gone") appears in `VaultStateMachine`.
- `slate/ipc-through-registrar` must grow to cover transferred ports rather than be excepted. If the
  design cannot do that, B should be rejected rather than merged with a disabled guard.
- Every e2e spec that assumes one process (`lock`, `quit-clean`, `selftest`, `memory`) is rewritten, and
  `pkill` cleanup in the test harness must account for the child.

## Measured baseline

All figures are from this release's work packages, on the same machine: Apple M4, 10 cores, macOS 27.2.1,
Electron e2e with the window hidden, SQLCipher vault, git remote a local bare repo on the same disk. **The
machine was shared with other agents throughout; the 1-minute load average is given with every number, and
the lowest load during any measurement was 15.9.** Key latency is the load-sensitive measurement; the
main-process stalls are two to three orders of magnitude clear of that noise.

| What | 500 pages | 2,000 pages | Source |
| --- | --- | --- | --- |
| Steady-state sync, worst main round trip (post-B3) | 9.2 ms (load 15.9) | 34.4 ms (load 19.8) | D4B |
| Steady-state sync, worst main round trip (pre-B3) | 6,669.9 ms (load 22.7) | 64,599.1 ms (load 29.6) | D4 |
| First sync against a new remote, worst main stall | 4,143.6 ms (load 15.9); also 4,326.3 / 4,480.5 / 5,845.5 | 35,596.0 ms (load 19.8); also 44,828.6 / 63,869.4 | D4B |
| Key latency p50 / p95 during first sync | 9.2 / 17.1 ms | 9.2 / 17.6 ms | D4B |
| Main round trip, idle (`CH.appVersion`, p50 / p95) | 0.2 / 0.3 ms | 0.2 / 0.4 ms | D4B |
| Loro decode only, no SQLite/SQLCipher (review's own figure) | 0.21 s per run | 1.7 s per run | review F3 |

Product bars, for reference: wall-clock key latency median < 16 ms and p95 < 33 ms, page open < 100 ms
(`packages/desktop/e2e/spec/perf.spec.ts`); the probe's main round-trip bar is 100 ms.

### The cost of the hop per keystroke append: unmeasured

Nobody has measured a `utilityProcess` hop in this codebase, and this record invents no number. What is
known, and what it bounds:

- **An append is not on the keystroke's critical path.** `packages/editor/src/saveQueue.ts` coalesces
  writes per document, keeps one `append` in flight, serialises flushes and exports from the version the
  store has acknowledged. A key press mutates the Loro document in the renderer and renders; the append
  follows asynchronously. So an added hop lengthens *save* latency, not key latency — which is also why
  key latency survived a 35 s main stall in D4B.
- **The nearest measured quantity** is one renderer↔main round trip on an idle vault: 0.2 ms p50, 0.3-0.4
  ms p95, with a 3.0 ms p95 seen at load 22.7 (D4, D4B). A main↔host hop is the same mechanism
  (Chromium IPC between processes), so the same order is the reasonable expectation — but it is an
  expectation, not a measurement.
- **What stage 3 must measure before B is accepted:** append round trip renderer→main→host→main→renderer
  at p50/p95/max against the current renderer→main→disk path, on an idle and a loaded machine; the
  addon load and POST cost in a child process; and the worst-case transfer cost of an update, since the
  bytes now cross two boundaries instead of one.

Two further numbers this record would want and does not have: the search-index build time and the
worst-case user-regex scan at 500 and 2,000 pages. Both are code-reading findings in F5 (`searchIndex.ts`
lines 69 and 102-104) and **neither has been measured**. They should be measured with D4's probe before
stage 2 touches them.

---
name: prune-tests
description: Measure Slate's test suite, find tests that cost time without catching anything the rest of the suite would not (no unique coverage, duplicates across layers, e2e cases that need no real app, one-off bug tests whose code is gone), speed up, move, merge or delete them within the guard layer's rules, and report before and after numbers. Use for "tests are slow", "prune the tests", "reduce test time", "duplicate tests", or every few releases.
---

# Prune tests

The suite only grows: every fix adds a test and nothing takes one away. This skill does the taking
away. Run it every few releases. It ends with numbers, measured on the same machine before and
after: wall time, tests, files and lines per layer, and the coverage the suite lost (none).

A test is worth its cost when it would fail for a bug nothing else would catch. The work is to find
the tests that would not, then speed up, move, merge or delete them, and **prove that each removal
loses nothing**. Coverage finds candidates but does not decide: a line that ran is not a line that
anything checked.

Slate's guard layer limits what pruning may touch, more than most repos do. Read "What the guards
allow" before deciding anything.

## 0. Measure first

```sh
node .claude/skills/prune-tests/measure.mjs before                 # unit, main, guards, e2e, one at a time
node .claude/skills/prune-tests/measure.mjs before unit main       # just these layers
```

| Layer | What runs | Time (M-series Mac, 0.6.3) |
| --- | --- | --- |
| `unit` | `npm test`: the `packages/*/vitest.config.ts` projects (core, desktop renderer and shared, editor, importer, mcp, native, sync) | 26 s, 822 tests |
| `main` | `npm run test:main`: `packages/desktop/src/main` under Electron's Node, with the native module | 122 s, 1208 tests |
| `guards` | `npm run guards`: `tools/guards` and the lint rules' tests | 15 s, 710 tests |
| `e2e` | `npm run e2e`: builds, then Playwright over `packages/desktop/e2e`, UI scenarios included | the longest layer by far |

The script writes `.agent-reports/test-stats/before/`, which holds `summary.json`, each layer's
per-file and per-test seconds, and `slowest.md`. That folder is gitignored.

- Nothing else may run on the machine meanwhile: no agents, no second suite, no `ui:review`. Other
  load makes the times noise.
- Read `slowest.md`. The time is never spread evenly, and the top 25 files of each layer usually
  hold most of it.

Before an e2e run, check that the native addon and the Electron binary are in place: an `npm ci`
can drop the binary, and `node node_modules/electron/install.js` restores it. E2E windows stay
hidden (`SLATE_E2E=1`). Each run's temp root is removed at teardown (`e2e/tmpRoot.ts`); still,
check `df -h` between long runs. Never `pkill` Electron: other checkouts run it too.

## 1. Find the time outside the tests

Most of the time to win usually comes from how the suite runs, not from any one test. Check these
first. Each is cheap to find and changes no assertion.

- **Parallelism.** In `summary.json`, compare each layer's `seconds` (wall time) with `fileSeconds`
  (the sum of its file times). If they are close, the layer runs one file at a time.
  - Playwright runs with `workers: 1` (`packages/desktop/playwright.config.ts`). Each test launches
    its own app on its own `SLATE_USER_DATA`, so most specs could run side by side.
  - Some specs cannot: the clipboard ones (`box-clipboard`, `spec/clipboard`), focus and caret
    specs, the perf specs (`spec/perf*`, `perf-*`), and anything using the OS keychain. Put those in
    a serial project or `test.describe.configure({ mode: 'serial' })`.
  - Try two to four workers and run the layer three times. Fix a test that fails under load by
    waiting on its condition, never by going back to serial.
- **A long pole.** A layer can't finish before its slowest file. In `unit`,
  `sync/test/simulation.test.ts` (20 s) and `sync/test/gitDrive.test.ts` (18 s) set the 26 s wall
  time on their own. Split such a file by `describe`, or make its world cheaper.
- **The slowest file's setup.** Time the hooks against the tests: put `performance.now()` around the
  `beforeEach` work and write the result to a file, because Vitest swallows a passing test's
  console. A world that costs 0.3 s per test can be built once, copied, or split across workers.
  - Vaults with a real KDF are the usual cost in `main`. A test that does not test the KDF takes
    the cheap parameters `vault/testVault.ts` uses (`WeakKdfOption`, which unlock accepts only
    in tests).
- **Fixed waits hit in full.** A test that takes almost exactly a timeout is waiting one out:
  Playwright's 30 s, or an `expect.poll` timeout. Usually it is proving that something does not
  happen, or a fixture does not do what the real thing does.
- **A fresh app launch per case.** Launching and unlocking costs seconds. Where the cases of a spec
  only read state, one launch in `test.beforeAll` can serve the whole `describe`. Several specs
  (`sync.spec.ts`, `git-sync.spec.ts`, `onenote-import.spec.ts`) already build their shared world
  there.
- **Work no assertion needs.** `reviewUi` saves a screenshot for every theme and width, in every
  `npm run e2e`. Only a person reviewing them needs the files; the audit does not. But
  `e2e/ui/review.ts` is a guard file, so changing it is the maintainer's call: report what it costs.

## 2. Find candidates

Work from the most expensive layer down. One e2e test costs as much time as dozens of unit tests.

| Signal | How | Finds |
| --- | --- | --- |
| No unique coverage | `node .claude/skills/prune-tests/overlap.mjs files` runs each Vitest file alone (unit and main) with V8 coverage, about 11 min. Then run `overlap.mjs within <file>` for a slow or flagged file. | files and tests whose every covered byte another file also covers, and the file that contains most of each |
| e2e that needs no real app | Read each slow spec against what only the real app has: windows, the lock and unlock flow, native menus, the clipboard, the OS keychain, git remotes, the packaged protocols. | e2e cases that only check something a pure function decides (layout maths, markdown, sync age text, the settings schema). That function can have a unit test in `core`, `editor` or `desktop/src/renderer`. |
| Same behaviour in two layers | For each e2e or main case, search the cheaper layers for the same assertion, e.g. `grep -rn '<testid or function>' packages/*/test packages/desktop/src`. | the costlier copy. Keep one wiring test per behaviour in the costlier layer and drop the rest. |
| One-off bug tests | Run `git log --format='%h %s' -- <test file>` and read the test's own comment. Does the code it guarded still exist (`git log -S`)? Does a type, a `slate/*` lint rule or a guard test now make the bug impossible? | regression tests whose code was deleted or rewritten, or whose bug a guard now prevents |
| Weak tests | `requireAssertions` already fails a test with no assertion. Look for assertions that would hold if the code returned nothing: `toBeDefined()`, only "does not throw", a check on a mock's own return. | tests that cost time and catch nothing: strengthen them or delete them |
| Slow for no reason | In `slowest.md`, look for fixed waits, real timers where `vi.useFakeTimers` would do, a launch per case, a real KDF where the test helpers' cheap one would do, and `expect.poll` waiting out a timeout to prove absence. | time to cut without losing a single assertion |
| Near duplicates | In `overlap.mjs`, a "most contained by" share of 95% or more in both directions, or `it.each`-shaped copies | tests to merge into one table-driven test |

About the overlap numbers:

- Coverage is Node's own (`NODE_V8_COVERAGE`), so no coverage package is needed. It is counted in
  bytes of the code Vite hands to V8, not in source lines. Compare bytes between runs; don't read
  them as a percentage of a file.
- A module's top-level code is left out: every file that imports the module runs it.
- Each run uses its package's own Vitest config, wrapped in `.agent-reports/` to add
  `coverageHook.mjs`. The pinned configs are never edited.
- A file that covers nothing (the guard tests, KAT vectors read through the native module, script
  tests) reads source or exercises C, not product TypeScript. Judge it by what it asserts.
- A file that fails during the overlap run is reported, and its coverage is partial. Run it alone
  to see why. A long file can time out only because another file runs beside it
  (`vault/rekey.test.ts` did). Delete its `cover-*.json` and rerun with `--jobs 1`.
- Keep `.agent-reports/test-stats/overlap/` between the before and after runs: `union.before.json`
  in it is what `lost` compares against.

## 3. What the guards allow

These rules decide what pruning may touch, whatever the overlap numbers say.

- **A package never ends up with fewer test files than it had on the base.** The ratchet is
  `tools/guards/testConfig.test.ts`, "no package lost test files". Merge or delete *cases*; empty a
  file into its neighbour only with the maintainer, who decides file-level deletions.
- **A removed test case needs a `Removed-Tests-Reason:` trailer.** The Stop hook
  (`definition-of-done.mjs`) refuses lost tests without one.
- **A removed `expect(` sends the branch to review** (`scripts/agents/review-gate.mjs`). The review
  file needs the proof below.
- **The skip count only shrinks.** Never skip a test instead of deleting it.
- **Test configs and test scripts are pinned** (`testConfig.test.ts`, the `vitest*.config.ts` guard
  files, the root `package.json`). Changing a Vitest pool or include list is a guard change: it
  needs the lead's signed unlock and a `Guardrail-Change:` trailer. Propose it; don't route around
  it. `playwright.config.ts` is not a guard file.

**Never delete, whatever coverage says:**

- **Product-rule specs**: `packages/*/test/spec/**` and `packages/desktop/e2e/spec/**` (the
  `@product-rule` header). They are guard files, and their expectations only grow.
- **Tests whose title carries an audit or test id**: `T-STATIC-…`, `T-ZERO-…`, `T-POST-…`, `T-B-…`,
  `T-FUZZ-…`, `T-POL-…`, `T-KAT-…`, the `C5-criterion-…` names.
  - `scripts/traceability.mjs --check` (CI) fails when an id is in no title.
  - Merging such a test keeps its title. After any move, regenerate the matrix with
    `node scripts/traceability.mjs` and commit `docs/compliance/traceability.yaml`.
- **The guard tests** (`tools/guards`) and the lint rules' tests: they read source rather than run
  it, so they show no coverage, and they guard everything.
- **Security tests**: the vault and key ring, zeroisation, `KeyBytes`, the lock gate and IPC guard,
  hardening and protocols, the paste sanitiser, sync encryption, log redaction, crash survival
  (`expectNotesSurviveCrash`), and the native KAT and vectors. A security bug costs far more than
  the test does, however small the test.
- **Property and fuzz tests** (`fast-check`, `T-FUZZ`): they cover inputs, not lines.
- **`smoke.spec.ts`, and every UI scenario** (`e2e/ui/*.ui.spec.ts`): a UI scenario is a screenshot
  and an audit as well as a test (`.claude/skills/ui-review/SKILL.md`).
- **A test whose assertion is the only one on a value the person sees** (text, a count, an order),
  even if another test runs the same lines without checking that value.

## 4. Decide, case by case

For each candidate, pick one of these, in this order of preference:

1. **Speed it up.** Same assertions, less time: one launch shared across a `describe`, a fake
   clock, the cheap KDF, a shorter honest window for "nothing happens", no needless build. Nothing
   is lost, so only the times need proving.
2. **Move it down a layer.**
   - An e2e case that checks only what a pure function decides becomes a unit test of that function.
   - A `main` case that needs neither Electron nor the native module becomes a `desktop` unit test.
   - The assertion stays the same. If the e2e case also proves wiring, keep it and drop only the
     facets the unit test now covers.
3. **Merge.** Tests that set up the same world and check facets of one behaviour become one test,
   or one `it.each` table, in the same file. Every assertion of each survives in the merged test.
4. **Delete.** Only when the proof below holds.

**Proof for a deletion or a merge.** Record it in the commit message and in the review file.

1. **Coverage does not drop.**
   - Before the first change, run `overlap.mjs files`. It saves `union.before.json`.
   - After the change, run `overlap.mjs files` again. It reruns only the test files that changed;
     add `--fresh` if anything under `src/` changed.
   - Then run `overlap.mjs lost`. It must print "nothing … is uncovered now" and exit 0.
2. **Mutation check.** Break the code the deleted test was about: invert the condition it guarded,
   return early, or drop the call. Show that a remaining test fails. If none fails, the deleted test
   was the only check on that code: keep it, or move its assertion into the test that ran the lines.
   Undo the mutation.
3. **For a one-off bug test, name what makes the bug impossible now**: the deleted code
   (`git log -S`), or the type, `slate/*` rule or guard test that prevents it.

## 5. Keep it from growing back

- The definition of done already asks for a test in the cheapest layer (root `CLAUDE.md`). A review
  that sees an e2e case checking only a pure function sends it down a layer.
- If the e2e count keeps climbing, propose a budget to the maintainer: a guard test that counts the
  e2e tests against a committed number. Adding it is a guard change, so the maintainer decides.

## 6. Measure again and report

```sh
node .claude/skills/prune-tests/measure.mjs after
node .claude/skills/prune-tests/compare.mjs before after   # writes after/compare.md
node .claude/skills/prune-tests/overlap.mjs lost
```

- Measure on the same machine with nothing else running. Every layer must pass in both runs.
- Report:
  - the compare table;
  - the `lost` result;
  - each change with its kind (sped up, moved, merged, deleted) and the seconds it saved;
  - for each deletion, its proof.
- Commit one kind of change per commit. Test-only commits carry `No-Red-Test-Reason:`, and commits
  that remove cases carry `Removed-Tests-Reason:`.
- Follow the version and changelog rule for every change. Work on a branch and merge with merge-wp,
  as for any work package.

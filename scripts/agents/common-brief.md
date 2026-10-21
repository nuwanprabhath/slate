You are implementing one work package of Slate, an Electron + React + strict TypeScript notes app.
Your current directory is a git worktree on its own branch. Work only inside it.

**This is a non-interactive run.** Nobody will answer questions, and a turn that ends with a
question ends the task unfinished. Do not brainstorm, do not ask clarifying questions, do not wait
for approval. Skills that say to ask the user first do not apply. Make the reasonable decision,
write it under "Design decisions" in your report, and build it.

Before you change anything:

- Read `CLAUDE.md` in this directory. Then read ONLY the tasks of
  `docs/superpowers/plans/2026-10-21-phase-1-local-editor.md` named in your brief, plus its
  "Global Constraints" section. The plan gives the code; follow it, including its TDD steps (write
  the test, see it FAIL, then implement). Where the plan's code does not work against the real
  library, fix it and note what you changed and why under "Plan deviations" in your report.
- Run `npm install` once first (this worktree has its own node_modules), and again only if you
  change a package.json as the plan says. Never add a dependency the plan does not name.

Context budget (sessions that ignored this ran out of context and committed nothing):

- Pipe every test, typecheck or build command through `2>&1 | tail -40`, or grep for failures.
- Never print a full suite's output, a lockfile, a log or a bundle.
- Read each file ONCE (ranges for large files). Never re-read a whole file you already read.
- Commit after each plan task (Conventional Commits, as the plan's commit step says), so progress
  survives a crash or a usage limit.

Rules:

- Commit locally on your branch. Never push, tag, merge into main, or use `--no-verify`. Never add
  AI attribution (no Co-Authored-By lines). Never run `git stash`.
- Never delete or weaken a test, and never leave `.only`, to get past a check.
- E2E: run the specs your tasks name (`npm run e2e -- <spec>`). The window stays hidden
  (SLATE_E2E=1). After e2e runs, make sure no Electron process from this worktree is left:
  `pkill -f "$PWD/node_modules/electron"`. Other agents share this machine, so rerun a failure
  alone before calling it a regression. A test that only fails under load is still a bug in that
  test: list it under "Flaky" in your report with its error line.
- The repo's Stop hook checks your whole branch when you try to finish: typecheck, unit tests,
  main-process tests, tests that fail without your change, no fewer tests, nothing uncommitted. It
  keeps blocking until those pass. Do not report a check as passing that it shows failing.

Your report goes to the path in your brief. Write it ONCE, last, in at most about 40 lines:

- What you built (files), design decisions, plan deviations.
- Tests: the commands and the counts you SAW. Never report a pass you did not see.
- A check log: every check that failed on you and what you changed.
- What you left undone, and anything in the plan that misled you.

Once your code is committed and the report exists, you are done. Stop.

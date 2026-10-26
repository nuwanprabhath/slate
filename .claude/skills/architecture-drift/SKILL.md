---
name: architecture-drift
description: Measure how far Slate's code has drifted from its sanctioned patterns since a base revision (the last review, phase or release), report the trend, and hand each new drift class to the `correct` skill. Use for "architecture drift", "has the architecture held", "audit since <version or phase>", or after every phase of agent-written work packages.
---

# Architecture drift

Rules a machine checks hold through agent-written phases; rules that live only in prose, or in a
helper's existence, do not. This skill measures which is which, so drift is caught one phase after
it starts, not five.

## Inputs

- A base revision. Default: the merge commit that closed the previous phase (`git log --merges`),
  or the previous release tag. State which one you used.

## Steps

1. **Size the change.** `git log --oneline <base>..HEAD` and `git diff --stat <base>..HEAD -- packages tools`.
   List new modules, IPC channels (`CH`), settings, tables, dependencies and windows.
2. **Debt trend.** Compare at the base and now (a temporary `git worktree add`, never a stash):
   the entry counts of `eslint-suppressions.json` and of every `tools/guards/allowlists/*.json`.
   Each should be smaller or equal; growth is only legitimate in `dependencies.json`, with a
   maintainer approval in the commit or review that added it.
3. **Unchecked-pattern counts at both revisions** (`git grep -c`), things no rule covers yet:
   - `as unknown as` and other double casts; `!` non-null assertions outside `main/vault`;
   - `eslint-disable` comments per file, and what they disable;
   - `process.env` reads outside `testHooks.ts` that are not `SLATE_*`;
   - `webContents.send(` with a non-`CH` channel; `services()` held in a variable past one call;
   - new `useState`/`useEffect` in `renderer/src/App.tsx`, files over 400 lines.
4. **Rules with no enforcer.** Read `CLAUDE.md` ("Guardrails", "Product rules", "Never"),
   `docs/architecture/golden-paths.md` and nested `CLAUDE.md` files. List every rule whose
   enforcement is prose only, and check whether new code broke it.
5. **New code without a home.** For each new module: did it follow its golden path (registrar,
   `env()`, `openExternalSafe`, `writeJsonAtomic`, `openDatabase`, the window factory)? Did a new
   invariant get a check and a row in the rule table?
6. **Report** as a trend table (rule | enforced by | held? | evidence) and save it as
   `docs/reviews/<date>-drift.md`.
7. **Hand off.** Every drift class that happened twice is input for the `correct` skill; list them
   in priority order (security first).

Read-only until step 7. Do not fix code while measuring.

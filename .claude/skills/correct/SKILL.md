---
name: correct
description: Turn a mistake agents made in Slate into one the repo makes impossible, choosing architecture first, then types, then a lint rule or guard test whose error names the fix, then a behaviour test, and writing a docs rule only when nothing else can check it. Use for /correct, after every review that finds something, or when the maintainer corrects the same thing a second time.
disable-model-invocation: true
---

# Correct

Agents keep making the same mistakes until the repo stops them. Change the repo so the next agent
cannot make this one. Assume every contributor sees only the files it opened, copies the nearest
example, and takes the shortest path that passes the checks.

**When:** the lead runs this after every review (`.agent-reports/reviews/*.md`) that has a finding,
and whenever the maintainer corrects the same thing twice. A review finding already names the guard
that should have caught it (`docs/review/REVIEW.md`); this skill builds that guard.

## Find the mistake classes

Read, newest first:

- review files under `.agent-reports/reviews/` (each finding's "Guard:" line);
- work-package briefs and reports, `.agent-reports/*/F*.md` and `*.report.md` (the F-briefs are
  review-fix lists: each item is a mistake that shipped);
- `git log --grep='^fix'` and the diffs of those commits;
- the audit's findings (`docs/reviews/compliance_audit.md`, `F-*`), and `docs/compliance/decisions.md`;
- the rule table in `CLAUDE.md` ("Guardrails"): a rule broken anyway is not enforced well enough.

Group the mistakes into classes. A class counts once it happened twice, or once if it was a security
finding.

## Fix each class at the highest level that works

1. **Architecture.** One owner, one way: `createIpc` is the only registrar, `env()` the only reader
   of `SLATE_*`, `openExternalSafe` the only URL opener, `writeJsonAtomic` the only vault writer.
2. **Types.** Make the bad state unwritable: `CHANNEL_POLICY: Record<keyof typeof CH, …>` (a channel
   without a decision does not compile), `Channel` instead of `string`, `env(name: TestHookVar | AppEnvVar)`,
   per-package tsconfigs (no Node types in core or editor).
3. **A check whose error names the fix**, in order of preference:
   - a `slate/*` lint rule: an entry in `tools/eslint-rules/sanctioned.mjs` (`import` or `syntax`
     kind, `files`, `allow`, a `message` that names the accepted path first, then why), or its own
     module in `tools/eslint-rules/` registered in `plugin.mjs` `CUSTOM` when a selector cannot say
     it; plus RuleTester cases (`sanctioned.test.mjs` or `<rule>.test.mjs`);
   - a dependency-cruiser layer (`.dependency-cruiser.cjs`);
   - a guard test in `tools/guards/` (or `packages/desktop/src/main/static.test.ts` for an audit
     `T-STATIC` id), with a reasoned allowlist in `tools/guards/allowlists/` if real exceptions exist;
   - a hook: `.claude/hooks/guard-edits.mjs`, `definition-of-done.mjs`, `.githooks/*`.

   If existing code already breaks the new rule, fix the cheap sites in the same change; baseline the
   rest with `tools/lint/node_modules/.bin/eslint . --suppress-rule slate/<name>`. The ratchet
   (`tools/guards/ratchet.test.ts`) then lets that baseline only shrink.
4. **A behaviour test** in the cheapest layer that proves it (unit, main-process, then e2e).
5. **A line in `CLAUDE.md` or `docs/architecture/golden-paths.md`**, last, and only for a judgment
   call no check can make.

Guard files are protected by `guard-edits.mjs`: this work happens on a branch the lead listed in
`$(git rev-parse --git-common-dir)/slate-guardrails-unlock`.

## Prove it

Each new check must fail on the real past mistake: re-create the bad code from the commit, review
or brief that found it (as a RuleTester `invalid` case, or a fixture the guard test reads) and show
the failure. A check that never failed has not been shown to work. Then `npm run lint`,
`npm run guards`, `npm run typecheck`, `npm test` and `npm run test:main` pass on the tree.

## Keep the rule table

Add or tighten the row in `CLAUDE.md` "Guardrails" (`| Rule | Enforced by | Since |`) in the same
commit, and delete any prose the check now enforces. A constraint written as a code comment
("never…", "must stay…") is a rule nothing enforces: move it up a level and let the `trim-comments`
skill delete the prose.

**Reply:** each class with its evidence (commit, review, brief item), the level chosen and why a
higher one did not work, the check, and the output showing it failing on the real mistake.

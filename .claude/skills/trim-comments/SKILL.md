---
name: trim-comments
description: Cut the comments in a Slate diff (or a folder) down to the ones that carry a fact the code cannot, and flag the code whose surprise a comment was apologising for so it can be renamed, typed or reshaped. Use when reviewing an agent's branch before merging, when /correct finds a constraint written as prose, or when asked to clean comments.
---

# Trim comments

Every agent that opens a file reads its comments, so a comment costs context in every session that
touches the file. A comment earns its place only by saying something a reader needs that the code,
the test names and git cannot say. Slate's rule (`CLAUDE.md`): comments say why, not what, and carry
facts that still hold, not history.

The default is to keep the reasons next to the code: a measured finding stays even when it is about
our own code, and doubt is flagged for the lead rather than deleted.

## When it runs

- **Every agent branch, before the lead merges it**: spawn the trimmer on the branch's diff and
  apply what survives your review.
- **Every `/correct`**: a constraint written as prose ("never…", "do not remove…") is a rule nothing
  enforces. `/correct` moves it to a check; this skill deletes the prose.

## Scope

The caller's files, folder or diff. Default: the current branch's diff against its base, working
tree included. Source only (`packages/*/src`, `tools/`, `scripts/`); test names and test comments
are statements about behaviour and are out of scope unless the caller names them.

## Steps

1. **Spawn the trimmer**: a subagent whose prompt is [`references/trimmer.md`](references/trimmer.md)
   verbatim, then the scope. It edits comments only and reports.
2. **Review its diff, every hunk.** Reject any change to code (not a comment), the deletion of a
   keep (see the reference's list; restore it), a comment rewritten into a different claim, and a
   flag naming code outside the scope. When unsure whether a deleted comment held a measured fact,
   `git log -S'<phrase>'` finds the commit that added it: a commit that fixed a bug the comment
   describes means keep it, shortened to the fact.
3. **Act on `RESHAPE` flags.** Trivial ones (a rename, a narrower type, a named function) in the
   same change; ones that need design go to the report as open work.
4. **Constraint comments** become checks via `/correct` when a check is possible; the comment then
   goes. Otherwise it stays and the report lists it as unenforced.
5. **Verify**: `npm run typecheck && npm run lint` (comments carry `eslint-disable` reasons, which
   the lint requires), and the tests of any file whose code changed.
6. **Report**: comment lines removed, restorations, reshapes done, reshapes open, constraints
   enforced or left in prose.

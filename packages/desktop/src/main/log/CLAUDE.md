# The diagnostic log

Read with the root CLAUDE.md; this covers `src/main/log/`: when it writes, what it must never
contain, and where redaction happens. Ported from Apiary's diagnostic log.

`src/main/log/` writes `<userData>/logs/slate.log` when the user switches on Settings → Diagnostics
(`debugLog`). Four rules, and they are the feature:

- **Note content is never passed to it.** Not redacted, never passed. No scrubbing makes a notebook
  safe to hand to someone else, so page text, box text, titles of pages or sections and search
  queries do not go in. Log *what the app did*, never *what the user wrote*. Ids, counts, durations
  and error messages from our own code are fine; the arguments of an IPC call are not (the IPC
  wrapper logs the channel and the error only).
- **Off is the default, and off means nothing**: no directory, no file, and `log.*` returns at once.
- **Redaction happens inside the logger** (`src/shared/redact.ts`), not at call sites, so it cannot be
  forgotten: the home directory becomes `~`, credential-shaped strings are stripped, long fields are
  truncated. Add a rule there and every call gets it.
- **It must never break the app.** Every entry point swallows its own errors. A full disk stops
  logging; it does not stop the thing being logged.

`@slate/sync` and other packages do not import this: main passes a `ScopedLog` (`log.scoped(scope)`)
into the services that log. Rotation is by size (`rotation.ts`): the active file rolls at a fifth of
the budget and the oldest archives go first.

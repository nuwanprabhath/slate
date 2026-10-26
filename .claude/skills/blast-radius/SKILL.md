---
name: blast-radius
description: Find what a Slate change could break outside its own diff (the vault and its files, the encrypted database, sync remotes, IPC and the lock gate, the packaged build, other devices and older versions) and prove the one fact it is safe because of by running real code. Use for "blast radius of X", "what could this break", "is this safe to merge", or before merging a diff you don't fully trust.
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Listing callers is not the job: grep does
that in a second. The job is the breakage grep does not show.

## Don't trust your own writeup

A writeup that sounds right reads the same whether or not it is true. Find the one or two facts the
change's safety depends on and push each as far down this list as is cheap, then say where it stopped:

1. You said so. Worth nothing alone.
2. You pointed at the line: a real `file:line` here, or in the library's source in `node_modules`.
3. You walked the failure step by step and showed it cannot be reached.
4. You ran it: a unit or main-process test, or a short script that calls the real code and fails
   loud if you are wrong.
5. You reproduced it in the running app (an e2e spec with `npm run e2e -- <spec>`).

## Steps

1. **Read the change.** The diff, every symbol it adds, changes or removes, and what now behaves
   differently that the diff does not spell out. `git log -p` on the touched files shows why they
   were shaped that way; nested `CLAUDE.md` files and the specs under `docs/` often name the bug a
   line exists to prevent.
2. **Find the one fact it is safe because of** ("the guard checks the vault state before the handler
   runs"). If it holds, most of the maybes clear at once. Spend the time here.
3. **Look where grep stops.** In this repo, check each of these the change touches:
   - **The vault on disk.** `vault.json`, local keys, the pre-unlock file, recovery files: what a
     crash at each step leaves (`writeJsonAtomic`), what a vault written by the previous release
     looks like after this change, and what an older release does with a vault this one wrote.
   - **The encrypted database.** Schema changes (`DocStore` constructor), the plaintext → encrypted
     migration (`db/migrateToEncrypted.ts`), stray copies left by a crash, key handling (Z rules).
   - **Sync and other devices.** Remote formats (`SLE1`, remote names, the vault header) are read by
     every device, including ones on an older version; a hostile or corrupt remote must not stop
     sync or overwrite local notes.
   - **IPC and the lock.** A new or changed channel's `CHANNEL_POLICY` row, what it does while
     locked or locking, what the lock screen renderer can reach, and the flush window.
   - **The packaged build.** Test hooks are scrubbed (`TEST_HOOK_VARS`), fuses and asar
     (`electron-builder.cjs`), native modules from `app.asar.unpacked`, the `slate-mcp` launcher,
     `latest-*.yml`.
   - **Processes.** The MCP socket and CLI share the database: a second connection, the
     single-instance lock, `slate-mcp` relaying while the app locks.
   - **Platforms.** macOS keychain vs Linux secret service (`safeStorage` backends), XDG paths,
     the custom title bar on Linux.
   - **Performance.** The 16 ms keystroke and 100 ms page-open budgets (`e2e/spec/perf.spec.ts`).
4. **Be honest about each risk.** Give it a likelihood and a cost. Keep confirmed risks; list the
   ones you checked and cleared separately. Cite a real `file:line`. A search that finds nothing is
   still an answer. Never invent a caller or an API.
5. **Prove the one fact.** Write the test or script, run it, paste what happened. A test that proves
   it permanently belongs in the repo; a throwaway goes in your scratchpad.

## What to hand back

- **What it does**, including the part that is not obvious from the diff.
- **The one fact it is safe because of**, the level from the list above you reached, and the proof.
  If you could not prove it, write "unproven".
- **Risks**: how each breaks, `file:line`, likelihood and cost, how to check.
- **Cleared**: what you checked and why it is fine.
- **Before you merge**: the cheapest test or repro that would catch the real bug, and the guard
  (a `slate/*` rule or guard test) that would stop it recurring, for the `correct` skill.

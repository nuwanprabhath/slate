# Changelog

All notable changes to Slate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.6] - 2026-11-14

Twenty findings from the fuzzing layer added in 0.7.4, fixed. Most were found by harnesses rather
than by anyone meeting them, so for most of them nothing you did was broken; the ones that could
reach you are first.

### Fixed

- Deleting a page could stop your next edit to another page from reaching your other devices. The
  store numbered each change from the highest number in use, and deleting the page that held the
  highest one let the next edit reuse it, so a sync that had already passed that number never saw
  the edit. Numbers now come from a counter that only ever goes up (FX-6).
- Searching for a phrase containing a control character no longer fails with a database error. Such
  a character cannot match anything in a note, so it is now ignored rather than passed to the
  database, where it cut the phrase short (FX-21). An agent could reach this through the search tool
  as well.
- Reading many pages at once -- a search, an agent, an import -- no longer holds all of their memory.
  Slate frees the memory a page's contents use as soon as it has read them; it had been waiting for
  a later cleanup that, in a long run of reads, never came. A large shared library could exhaust the
  memory available to notes and leave the app unable to open any page until it restarted
  (FX-30, FX-32, FX-33, FX-34, FX-35, FX-36, FX-37).
- A OneNote page file that cannot be read is now reported by name, with the rest of the import
  continuing, instead of failing with an internal error message (FX-9).
- Sync refuses a file from a remote whose folder does not name a page or notebook Slate made,
  counts it as unverified, and carries on with the rest of the sync. A remote had been able to
  choose the names of documents created on your machine (FX-10).
- Saving a theme no longer accepts an oversized value that could freeze the window, and the idle
  lock with it, for seconds (FX-7).
- Pasted pictures load only from http, https or Slate's own store; any other source is dropped
  rather than kept and drawn broken (FX-11). Pasting a stray table cell keeps its text when the
  paste is cleaned again (FX-12), and pasting very deeply nested HTML lands its text instead of
  failing (FX-14).
- The AI access server no longer closes when a client sends more than 10 MiB without a line break;
  it refuses that line and keeps every complete line that came before it, however the stream was
  split (FX-22, FX-23). `slate-mcp` refuses an overlong line in both directions, at the same limit
  the app uses, instead of buffering it without one (FX-19).
- The update check no longer fails on an unusual processor name (FX-20), sync refuses branch names
  git itself rejects where you type them rather than failing later (FX-17), git's error output is
  capped so a broken remote cannot grow memory without limit (FX-18), and a log read through
  redaction twice reports the true number of characters dropped (FX-15).

### Changed

- hono 4.13.18 for five advisories, and the TipTap, Playwright and `@hono/node-server` updates from
  0.7.5's Dependabot group (#14, #15, #16). None of hono's advisories reach Slate: they are in its
  HTTP server, which Slate never starts, and no part of it is shipped in the app.

### Internal

- Core owns the lifetime of every Loro handle it reads, through one scope
  (`packages/core/src/handles.ts`), and a type-aware lint rule (`slate/loro-handles-through-scope`) holds core and the main process to
  it; the editor is outside it, because it holds handles deliberately while a box is open. Four separate
  fixes had each patched one caller before the cause was understood: a document is pinned while any
  handle read from it is alive, and such a handle is released only in a task of its own, so code
  that never yields frees nothing however often it calls `free()` (FX-36, FX-38).
- The nightly fuzz soak passes at full depth. Three harnesses failed there for reasons of their own
  -- a timeout that did not scale with the run count, key handles a model never returned, and the
  event loop never turning so that nothing was ever finalised -- which had been hiding whatever the
  soak might otherwise find (FX-29, FX-30, FX-31). A sync fault simulation replays exactly from its
  seed (FX-25), and a cost check compares mean times only, so machine load no longer fails it
  (FX-26).
- The paste sanitiser's strongest property now runs with no exclusions, which unblocks the planned
  Chromium differential harness (FX-11). `<svg><template>` was recorded as a defect and is not one:
  it is a bug in the test environment's HTML serialiser, which ignores namespaces (FX-13).

## [0.7.5] - 2026-11-14

### Fixed

- An edit made while a sync's pull failed no longer stays "mine" for ever. The cursor that says which
  documents a run considers was stored as soon as the pushes landed, so a run whose pull then failed --
  offline, a stall, a crash -- left that document out of every later run: nothing was appended to it, no
  later sync moved its conflict base, and the pushed edit stayed unsynced however many syncs finished
  afterwards. A change another device made after pulling that edit was then reported as a conflict, and a
  box that device deleted came back as a restored copy. The cursor now moves only once the pull has moved
  the bases, so the document is considered again (decoded, not uploaded a second time) until one sync
  finishes. Found by the sync fault simulation (FX-24); the failing scenario is pinned as a test.
- The crypto module answers a non-boolean flag with its own error code instead of a raw N-API failure.
  `aesEcbBlock` and `init` read their flag through a macro meant for building results, so `null`, a
  number or a `Boolean` object arrived in JavaScript as a `SLATE_NATIVE` error naming an internal
  function, with no `SCC_` code for a caller to handle. Every flag is now read strictly and refused with
  `SCC_1`, and nothing changes for a valid argument (FX-28).

### Changed

- The TipTap editor suite moves to 3.33.0, Playwright to 1.65.0, and `@hono/node-server` to 2.1.8 for a
  moderate advisory (Dependabot #14 and #15, folded into this release). `@hono/node-server` reaches
  Slate as a dependency of `@modelcontextprotocol/sdk`, which `@slate/mcp` declares as a runtime
  dependency; it is not shipped, because nothing in Slate imports the SDK's HTTP transport and the
  packaged app carries only built output, no `node_modules`. (Corrected in 0.7.6: this entry first
  said it was a development dependency of a test harness, which was the wrong reason for a right
  conclusion.)

### Internal

- The sync fault simulation replays exactly from its seed. Box and conflict ids were drawn from the
  system's random source rather than the plan, so a failing plan could not be reproduced, shrunk or
  pinned; they now come from the seed, and three replay properties check it (FX-25).
- The nightly fuzz soak runs as it was meant to. Its main half silently dropped the timeout and worker
  count npm ate from the command line, and ran without the FIPS provider, so fifteen vault suites failed
  on every cryptographic operation. Both are fixed, and the soak is split into two jobs so neither half
  runs out of time.
- The content fuzz harness releases the documents it builds, and a path oracle in the IPC fuzz tests no
  longer rejects a legitimate name beginning with two dots -- the same mistake the backup containment
  check had, now one predicate in both places.

## [0.7.4] - 2026-11-13

### Fixed

- Find and search refuse more regular expressions that could freeze the app. 0.7.3 refused a pattern
  whose groups repeat unboundedly, like `(a+)+$`, but that covered only one shape: an audit measured
  `(a|a)+$` taking 5.1 s against 26 characters, `(.*a){12}$` never returning at all, and `a.*b.*c`
  taking 339 s against 20,000. Overlapping alternatives under a quantifier, a bounded repeat of a
  variable-width group, and chained `.*` are now refused too, and the find bar shows them as an error
  the way it already did. A static rule cannot be complete and this one over-refuses a little:
  `(cat|car)+` and `(\w+\s){3}` are now refused, while `(foo|bar)+`, `\w+@\w+`, `a+b+`,
  `[A-Z]{2,4}-\d+` and `https?://\S+` still work.
- Importing a OneNote page with thousands of hyperlink field codes in one paragraph no longer fails.
  The importer restarted its scan of the whole page after each field code and recursed to do it, so
  8,000 codes (a 320 KB page) threw `Maximum call stack size exceeded`; 1,000 took 148 ms and 3,000
  took 1.16 s. It now makes one pass, and 50,000 codes complete.
- A huge error message from a git remote no longer stalls the app for minutes. Every failed git
  command's whole output is written to the diagnostic log, where it passes through redaction, and two
  redaction rules were quadratic in the length of the text: 1 MiB of a dotted string took 151 s, of
  which 703 ms per 132 KB came from the `scheme://user:password@` rule alone. Redaction now reads at
  most 16 KiB of a field and says how much it dropped. The length is chosen by the remote, so a broken
  or hostile server could trigger it.
- A OneNote backup whose converter index names a page outside its own folder no longer reads that
  file, and an image or attachment whose name begins with two dots is no longer shown as broken: the
  containment test accepted a path escaping the folder in one place and rejected a legitimate name in
  another, and both now use one predicate.
- The MCP server no longer corrupts text an agent reads or writes. The proxy decoded each chunk of the
  stream on its own, so a character split across two chunks became replacement characters -- `5€`
  arrived as `5` and three of them -- which meant an agent could read text the notes never held. The
  relay now stays in bytes.
- A sync provider that answers `Retry-After: -1` no longer removes the backoff entirely. The wait was
  clamped only at the top, so a negative value gave a negative delay, which retries at once and made
  the retry budget look larger than it was.

### Changed

- The TipTap editor suite moves to 3.32.3 (Dependabot #13). Clearing formatting on a nested list now
  turns every level into paragraphs, and code highlighting no longer re-runs when only the selection
  changes.

### Added

- A fuzzing layer across every boundary where Slate reads bytes it did not write: 21 new harnesses
  covering the document store and save queue, the native crypto core under AddressSanitizer and
  UndefinedBehaviorSanitizer, the N-API boundary, sync against a hostile remote and over the real
  database, the paste sanitiser and static rendering, the OneNote importer and backup boundary, the
  IPC handlers and validators, the MCP transport, proxy and private boxes, log redaction, the search
  index and the update feed parsers. They run on every pull request with a fixed seed and at depth
  nightly (`docs/reviews/2026-11-12-fuzzing-plan.md`).

### Documentation

- POAM-10 is corrected. The three hits the 0.7.1 and 0.7.2 measurements recorded in Chromium's
  allocator came substantially from the test itself: it returned the recovery key over Playwright's
  protocol, which the main process serves, so every call pushed another copy through main's IPC
  buffers. With that return masked, the 0.7.3 run finds no copy of the key anywhere in main after a
  lock -- 0 hits in every mapping. The earlier conclusion that a freed Chromium IPC payload keeps a
  copy past a lock is not supported.

## [0.7.3] - 2026-11-12

### Fixed

- The in-page find bar no longer freezes the window on a pattern like `(a+)+$`. With regex search on,
  the pattern was compiled and matched on the window's own thread, where a pattern whose groups repeat
  unboundedly takes exponential time: a 40-character line took over a minute in a test before this.
  Such a pattern is now refused the way an unparseable one already was, and the find bar shows it as an
  error. Slate's whole-library search had refused them all along; only the in-page find had not.

### Security

- Copying a recovery key no longer leaves it in the main process. A copy told main to read the
  clipboard back and keep the text, so the key sat in memory as a string that cannot be zeroed and
  outlived the lock -- the defect T-ZERO-09 found in 0.7.0, on a path that test never walked. Main now
  records only when a copy happened and clears the clipboard on that alone. The cost is that a lock
  within two minutes of copying from Slate clears the clipboard even if you copied something else
  afterwards (`docs/compliance/poam.md` POAM-10).
- T-ZERO-09 no longer carries the key through the main process itself: it returned the key from the
  page over Playwright's protocol, which the main process serves, so the test's own copy could not be
  told apart from the app's. The key now comes back masked. POAM-10 records that the channel leaving
  the remaining copies is therefore not yet established, and that the clipboard, the selection, the
  accessibility tree and printing reach the main process too.

### Changed

- Electron 45.2.3, vitest 5.1.0, vite 8.3.6, @vitejs/plugin-react 6.2.1, @azure/msal-node 7.2.0 and
  dependency-cruiser 18.7.2 (Dependabot #12, applied here because CI refuses a bot's commit that
  touches a guard file).

## [0.7.2] - 2026-11-12

### Security

- T-ZERO-09 now holds a generated recovery key to zero in memory Slate allocates, and records what
  Chromium's freed IPC buffers still hold instead of failing on it. The 0.7.1 fix closed every copy
  Slate owns (measured: the V8 strings are gone, and `discard()` zeroes the bytes main keeps); what
  remains is the IPC payload that carried the key to the window, which no JavaScript can reach and no
  change here can zero. The test still fails if those buffers ever hold anything but the displayed
  text, so the 32-byte secret appearing there would be caught (`docs/compliance/poam.md` POAM-10).

## [0.7.1] - 2026-11-12

### Security

- A recovery key Slate generated no longer survives in the main process's memory after you lock the
  vault. T-ZERO-09, which first ran on v0.7.0's release build, found the key's text still in main's V8
  heap after a lock and two full garbage collections: `encodeRecovery` built it as a JavaScript string,
  and a string cannot be zeroed. The key is now written, kept, saved to file and handed to the window as
  bytes, which are zeroed when the vault locks; only the window, whose process exits after unlock, turns
  it into text. The 32-byte secret itself was never exposed (`docs/compliance/poam.md` POAM-10).
- The Z-5 watch that checks no main-process path turns a secret into text now measures only the range a
  conversion renders. It had been blaming `Buffer#toString(encoding, start, end)` for the whole buffer,
  so the unused tail of a 64 KiB file-read buffer counted as a leak.

## [0.7.0] - 2026-11-12

This release implements the architecture, performance and security review in
`docs/reviews/2026-11-10-architecture_review.md`. Two of its findings were data loss.

### Fixed

- An edit is no longer lost when the store refuses a write. Slate retries until it sticks, and says
  "Not saved, retrying" in the toolbar meanwhile. Before this, one rejected write (a full disk, a busy
  database, a vault being re-keyed) silently made every later edit of that session unloadable.
- Tidying a page's history no longer discards edits that could not yet be applied. A page that arrived
  from another device before the edit it depends on could be destroyed permanently by the next tidy-up.
- Quitting Slate now writes the edit you just typed instead of losing it, and your recovery key is
  never sent back from the page to be saved.
- Sync now looks only at the pages that changed. On a 2,000-page vault a routine sync froze the app
  for over a minute; it is now under 35 ms. The first sync against a new remote still pauses the app
  (about 4 s for 500 pages, 36 s for 2,000) — that one is measured and tracked, not yet fixed.
- A large vault can now be put on a git remote at all. Git's command deadlines were far too short for
  thousands of files, so the first sync failed and reported "Offline" forever. Deadlines now scale
  with the number of files, a stalled transfer is told apart from a slow one, and a timeout says it
  timed out instead of claiming you are offline.
- Searching no longer freezes the app: the first index is built in slices and resumes after a restart,
  and a slow or runaway search pattern stops early and says the results are partial. A hostile pattern
  could previously hold the whole app, idle lock included, for over a minute.
- Opening a page with many boxes, and typing on one, no longer slows down as the page grows. An
  imported page closed before it finished loading is tidied up the next time it is opened.
- A plugin panel that fails now shows a "Try again" fallback instead of blanking the app, and plugins
  can no longer clash over a command id, a shortcut or a settings write.
- Note saving is faster: the store prepares each statement once and counts a page's pending updates in
  memory instead of on every edit.

### Security

- The AI tool layer can no longer see a private box's content at all. It was previously handed the
  whole page and trusted by convention not to look; it now receives a redacted projection, and a
  property test calls every registered tool looking for a leak.
- Main checks every value the window sends it before acting on it, and refuses anything malformed.
- Slate remembers in the main process which OneNote backup files you chose, so only the file dialog —
  never the page — decides what an import reads.
- Slate refuses a git remote URL, branch or repository name that git would read as an option or a
  remote helper.
- The page security policy is now sent as a response header as well as a meta tag, and workers are
  forbidden outright. Trusted Types is enabled in report-only mode: enforcing it would break the
  editor, because the violations come from inside the TipTap library, not from Slate.
- A FIPS 140-3 vault refuses to unlock when the renderer is not sandboxed (the AppImage case), instead
  of only warning. The standard profile keeps the warning.
- Network calls during sync have deadlines and are cancelled when a sync is abandoned; a retry can no
  longer be told to wait a day; and two operations can no longer collide on one git clone.

### Changed

- Releases now run the full CI gate — lint, guards, traceability, unit, main-process, e2e and the
  memory evidence — and refuse a tag that is not on `main`. Version 0.6.7 was published from a commit
  whose end-to-end tests were failing; that is no longer possible.
- The release carries `traceability-evidence.json`: proof that every traced compliance test actually
  ran and passed on the released commit, with the manual checks listed separately. The matrix
  previously proved only that a test existed.
- Architecture guards: each package is held to its declared imports, module cycles are refused, the
  AI tool layer cannot hold a page, and every IPC handler must check its arguments.
- The main-process and unit test suites no longer fail on a busy machine: every slow case now declares
  a budget measured from what it actually does.
- The vault's parse-cost bound is now relative to a benign parse rather than a fixed number of
  milliseconds, so it measures the code instead of the machine. The old bound would not have noticed
  a 400-fold slowdown.
- Two decision records are added under `docs/architecture/adr/`: one on moving the vault out of the
  main process (recommends deferring, with measurements), one on plugin isolation (recommends keeping
  plugins built-in only). Both await the maintainer's decision.
- `linkedom` 0.18.15 in the importer; `eslint` 10.14.0 and `globals` 17.14.0 in the lint toolchain.

### Internal

- New test coverage the review asked for: a sync fault-injection harness (dropped, stalled, duplicated
  and reordered calls, and a crash mid-sync), a private-box canary across every AI tool, a vault-scale
  responsiveness probe, and a memory-evidence check that a generated recovery key is gone after a lock.

## [0.6.7] - 2026-11-08

### Changed

- Electron is updated to 45.2.1 (Chromium 156.0.8078.75, with upstream security fixes), and the
  TipTap editor libraries to 3.32.2. Notes and editing behave as before.

## [0.6.6] - 2026-11-07

Carries 0.6.5's changes, which were never published.

### Fixed

- Text typed into a new box could disappear when another device synced the page at the moment the box
  was made: that device filled the box's still-empty content with its own empty paragraph, which could
  win over the text. A box is now created together with its content, so no device ever sees it empty.
  Update every device that syncs: a box made by an earlier version can still be emptied this way.

## [0.6.5] - 2026-11-07 (not released: held for the fix in 0.6.6; shipped in 0.6.6)

### Changed

- Loro, the document library under every note, is updated to 1.17.1. Notes, sync and encryption behave
  as before.

### Security

- The build's packaging tools use minimatch 11.0.3, which fixes GHSA-g3hv-75wg-m249 (the advisory now
  covers versions 7 to 11.0.0). It is used only to build the app and does not ship in it; the
  packaged files are the same.

## [0.6.4] - 2026-11-07

Carries 0.6.3's changes, which were never published.

### Changed

- The macOS arm64 build and tests run on GitHub's macOS 15 runners: the macOS 14 image was retired and
  cancelled the 0.6.3 release before it built. The minimum macOS is unchanged: 13, Electron 45's.

## [0.6.3] - 2026-11-04 (not released: the macOS 14 build runner was retired; shipped in 0.6.4)

### Fixed

- **Copy as Markdown keeps a backslash before a `|` in a table cell.** It used to disappear when the Markdown was read back or rendered.
- **"Synced to GitHub" only for GitHub.** A git remote that merely had `github.com` somewhere in its address was called GitHub.

### Security

- The result the update installer leaves behind is checked and read through one open file, so it cannot be swapped between the check and the read; it is still refused when it is a link or anything but a small regular file, and never read past its size cap. The release now packages Electron 45.1.0, the version tests run on (a guard test keeps the two equal).
- Code scanning (CodeQL) is on for the repository; every finding is fixed or dismissed with its reason.
- Updated: Electron 45.1.0, electron-builder 26.18.0, electron-updater 6.8.11, @azure/msal-node 7.1.2, @modelcontextprotocol/sdk 1.32.2, and the lint tools. minimatch 11.0.1 in the lint tools (GHSA-g3hv-75wg-m249).

## [0.6.2] - 2026-11-04

### Added

- **Pages remember where you were.** Going to another page and back returns to the place you had scrolled to, not the top, so you can go back and forth to copy things across. It lasts while Slate is open. The find bar still wins: a page opened with a find match shows the match.

### Changed

- **Install and restart on the AppImage too.** The AppImage's banner now has the same single *Install and restart* as the .deb and macOS, in place of *Download and install* followed by *Restart and install*. It checks every file of the release, downloads it and restarts into the new version; it needs no password. If Slate has not restarted 30 seconds later, the banner offers *Try again*.

### Security

- body-parser 2.4.0 (GHSA-27r3-jxmh-p828: a compressed request body with bytes after it could hold the parser up). It comes in with the MCP SDK.

## [0.6.1] - 2026-11-02

### Fixed

- A setting changed in the first moments after launch (from the menu, say) could be undone: the page's first read of the settings, taken before the change, could arrive after it and overwrite it, leaving the editors on the old value until the next change. The first read now applies only when no change has arrived, and not at all once the page has stopped following the settings. This is the likely cause of the occasional failure of the Markdown Shortcuts end-to-end test on Ubuntu; it was not reproduced on purpose.

## [0.6.0] - 2026-11-02

### Added

- **Install and restart** on macOS and Ubuntu (.deb). The update banner installs the new version and restarts into it; *Download* stays beside it for doing it by hand.
  - **The password.** When sudo needs your password, the banner asks for it. It is typed into a secret field, sent as bytes straight to sudo's standard input, and never saved, logged or shown again. A wrong one is said so, with the field ready for another try; Cancel keeps the download.
  - **Ubuntu:** the checked `.deb` is installed with `apt-get` while Slate runs, then deleted, and the new version starts once Slate has quit. Started from a systemd user service, it gets a unit of its own so it outlives the old one.
  - **macOS:** once Slate has quit, a helper swaps the new `Slate.app` in, clears its quarantine, deletes the dmg and opens Slate again. It works where your account owns the app and its folder (the usual case), and as root only where root owns the folder and everything above it; anywhere else (a root-owned app in a folder you can change, a group-writable folder, a disk image) it says so and leaves the install to you. If anything fails, the old app is put back, the dmg is kept and the next start says why. A copy macOS runs read-only (from a quarantined download) is refused with what to do.
  - **Checked again before it runs:** the downloaded file must still hash to the sha512 the signed update feed names for it, or nothing is installed. Root copies the file into a folder only it can write and checks that copy, so replacing the download after the check changes nothing. Root runs only the scripts shipped in the app's own Resources, by path, and only when your account can change neither them nor the folder they replace things in; your password is the only thing sent to sudo. Where that is not so (a root-owned `Slate.app` in a folder you can change), Install and restart says so and leaves the install to you.
  - **A failed install** keeps the download and offers *Try again*, *Open installer*, *Show in folder* or the install command.

## [0.5.1] - 2026-10-31

### Fixed

- At 800 px on Linux the toolbar took three rows instead of two: its system font is wider than macOS's. The inline code and code block buttons are now drawn as icons, and the toolbar's buttons and groups sit a little closer together.
- Sync's git commands no longer take their repository from git's own environment variables (`GIT_DIR` and others). A Slate started from a terminal inside a git hook or `git rebase --exec` would have synced with that repository instead of the notes'.

## [0.5.0] - 2026-10-31

### Added

- **Move and copy boxes.** Click a box's title bar to select it (Cmd/Ctrl+click adds more). Cmd/Ctrl+X marks it to move (faded, dashed outline), Cmd/Ctrl+C copies it, and after a click anywhere, on this page or another, Cmd/Ctrl+V puts it there. Cmd/Ctrl+D duplicates it in place. Esc cancels a move, undo reverses a paste, and Edit → Cut, Copy and Paste work on selected boxes too.
- **Find and replace.** The find bar's ▸ (or Edit → Replace…, ⌥⌘F / Ctrl+H) shows a replace row with Replace, Replace All (one undo step), Preserve Case and regular-expression groups (`$1`…`$9`, `$&`). Find in Notes can replace across pages: Replace All… lists every match by page with tick boxes, and replaces only the ticked ones. If the notes changed since the search, it asks you to review again instead.
- **To-do lists**, from the toolbar or Cmd/Ctrl+Shift+9: click a box to tick it. They copy as `- [ ]` / `- [x]`.
- **Alignment** of paragraphs and headings, from the toolbar or Cmd/Ctrl+Alt+Shift+L, Cmd/Ctrl+Shift+E and Cmd/Ctrl+Shift+R.
- **Subscript and superscript**, from "More text styles" on the toolbar (with strikethrough) or Cmd/Ctrl+Shift+, and Cmd/Ctrl+Shift+.
- **Indent and move lines.** Tab and Shift+Tab indent paragraphs and headings; Alt+Shift+Up/Down moves the current line, or a list item with its sub-items.
- **Format painter**: the brush on the toolbar copies the selected text's formatting onto the next text you select; double-click it to keep it on until Esc.
- **Fold headings**: the ▸ beside a heading folds its section. Folds stay on this device and are not saved; Find opens a fold to show a match inside it.
- **Resize pictures**: click one and drag a corner. Double-click a corner for the original size.
- **Drag pictures anywhere**, as in OneNote: a picture you drag sits exactly where you let go in its box, beside, below or over the text, and the box grows to hold it. Drag it (or selected text) into another box, or onto an empty part of the page to put it in a new box. Hold Option (Ctrl on Linux) when you let go to copy instead. Undo puts it back in one step.
- **Underline misspelled words** (Settings → Autocorrect, off by default). Slate never changes your text, and on Linux it is not available, because it would download dictionaries from the internet.
- **Print and export as PDF**: File → Print… (Cmd/Ctrl+P) and File → Export Page as PDF… (Cmd/Ctrl+Shift+P) lay the page out as on screen, scaled to the paper's width, dark on white in any theme. A PDF is readable by you only (except on disks without permissions, such as a FAT or exFAT USB stick), and Slate will not write into another account's file.
- **Right-click menu** on text: Cut, Copy, Paste, Paste as Plain Text, Copy as Markdown and Select All. Copy as Markdown is also in the Edit menu (Cmd/Ctrl+Alt+Shift+C).

### Changed

- The toolbar fits on one row in a new window and on two at 800 px; the font picker reads "Font".
- Copied HTML keeps alignment and indent as well as colour, and pasting inside Slate keeps alignment and to-do ticks.

### Fixed

- Typing no longer records a needless change for every unset paragraph setting on each keystroke, which doubled what a page stores and syncs.
- In a box made taller than its text, a click or shift+click in the empty space below the text now goes to the end of the text, so shift+clicking there selects everything from the caret down, pictures included. It used to select the text above instead.

### Older versions

A page edited in 0.5.0 opens on a device still running 0.4.3: to-do items show as bullets, aligned or indented text as plain left-aligned text, subscript as normal text and a picture you placed in its box on its own line. 0.4.3 keeps the formatting unless that line is edited there. Update every device to 0.5.0.

## [0.4.3] - 2026-10-30

### Fixed

- Copying text together with pictures and pasting it into another app now brings the pictures too. Notes showed a "?" for each one and OneNote dropped them, because the copy pointed at Slate's private image store; the pictures now go onto the clipboard themselves. Cut does the same.
- Pictures embedded in pasted HTML (from Slate, Word or a web page) are stored like a pasted picture file, instead of inside the page, where they made the page and every sync of it larger.

## [0.4.2] - 2026-10-30

### Added

- A pasted web or mail address (http, https, mailto, www.) becomes a link, whether it is pasted into a box, onto the canvas or inside other text. Paste as plain text leaves it as text, and Settings → Autocorrect → **Make pasted web addresses links** turns it off.

### Changed

- A clicked picture's highlight is a 3 px ring in the theme's accent colour, drawn just inside the picture so it never covers the lines around it.

### Fixed

- Typing no longer stalls when you pause and start again on a long page. Slate re-indexed the page for search in the meantime by rebuilding it from the database, and the window's key presses waited behind that. It now updates only what changed. Saving's occasional clean-up of a page's history also waits until you stop typing.
- Shift+click from the line above a picture to the line below it selected the picture with nothing to show it; a picture inside a selection now shows the same ring as a clicked one.

## [0.4.1] - 2026-10-29

### Changed

- Slate is now licensed under the Apache License 2.0 (it was MIT).
- Buttons have a clear outline and fill in every theme; in Folio and the other light themes they no longer blend into the panel.
- A focused field or dropdown shows one ring, the same everywhere, instead of two.
- Settings keeps its heading and close button in view while the section scrolls.
- Settings → Security → Post-quantum readiness: **Check now** says when it ran and what it found (the key exchange and when it was seen), and the vault format line names the devices it is waiting for and says this computer is ready.

### Fixed

- The vault format upgrade could wait for this computer itself, when its own device record was still the one 0.3.0 wrote.
- "Waiting for 1 device" was shown when sync was off or the device list could not be read; it now says which.

### Documentation

- A report of what the post-quantum release built and what is still open (`docs/reviews/quantum-proof-implementation.md`).

## [0.4.0] - 2026-10-29

### Added

- Settings → Security shows how well your notes are protected against future quantum computers: the note encryption, the vault format, what each sync connection negotiated (with **Check now**) and the update signature type.
- Settings → Sync: **Require post-quantum key exchange** (off by default). When it is on, Slate syncs only over a connection that uses one.
- A short banner while the vault format updates.
- Settings → Security → cryptographic module lists the post-quantum algorithms that are available and says they are not part of the validated module. The diagnostics export gains the vault format version and the key exchange seen for each sync host (host names only).

### Changed

- Git over SSH now prefers a hybrid post-quantum key exchange when your computer's `ssh` supports one, and falls back to its usual list otherwise.
- Vaults on the previous format update to the new format automatically after you unlock, once every device that syncs runs this version. Your password, recovery key and quick unlock keep working and no note is re-encrypted. Until then the old format stays.
- v1 vaults upgrade straight to the new format; new encrypted vaults start on it; key rotation works on it.

### Security

- After this update, updates are verified with a post-quantum signature (ML-DSA-65) as well as the existing Ed25519 one, and an update without both is refused.
- The self-test at start-up now also checks the ML-DSA verifier.

## [0.3.0] - 2026-10-28

### Added

- A lock button next to the sync status locks Slate in one click. It shows only when your notes are encrypted.
- Right-click empty canvas → **Re-arrange boxes** moves overlapping boxes apart, shifting each one down only as far as needed. One undo puts them back.
- ⌘-click (Ctrl-click on Linux) selects several boxes; drag any of them to move them together. Escape clears the selection, and Delete removes the selected boxes (undoable).
- Boxes resize from the left edge, the bottom edge and the bottom corners as well as the right edge. Dragging the bottom edge gives a box a minimum height; it still grows with its text.
- The Sections and Pages columns can each be collapsed to a slim rail: hover the line to a column's right and click the chevron, then click the rail to bring the column back at its previous width. With both collapsed, the notebook picker hides too and the page gets the room. The choice is remembered.

### Changed

- The Settings button at the bottom left is now a gear instead of an icon that looked like a sun.
- A long section or page name no longer pushes the page out of a narrow window: an auto-fitted column is capped at a fifth of the window, and the full name shows in a tooltip.
- Buttons, dialogs and the find bar look consistent across themes: no grey browser-default buttons, opaque dialogs in Glass, and readable primary buttons in Dark.

### Fixed

- A box underneath another can always be grabbed: a box's handle is never covered by another box, a handle lying over another box is always shown, and clicking a box brings it to the front (the order is saved with the page). Box backgrounds are opaque, so overlapping text no longer mixes.
- Right-click menus line up: every item starts at the same left edge, with the ✓ in its own column.
- On Linux and Windows a long page title no longer runs into the menu bar; it shortens with an ellipsis and shows in full on hover.
- Collapsing a library column gives all of its width back to the page.
- Automatic sync waits a full interval after the previous sync finishes, so a slow sync no longer leaves the status showing "Syncing…" almost all the time.
- Lock screen: "Unlock with Touch ID" is centred under Unlock and the same width.
- Settings → Security → Change password is a proper form: a label above each field, help text below, no overlapping borders or cut-off hints.
- Settings → Diagnostics: the log file, its size and the buttons each sit on their own row instead of a squeezed column; spacing and alignment are tidied in every settings section, the encrypt wizard and the update banner.
- Banners (enter your password, migration, quick unlock) sit below the title bar instead of under it, so their buttons are no longer cut off.

## [0.2.0] - 2026-10-27


### Security

- A packaged build whose FIPS provider is missing or refused now stops on the self-test error screen instead of crashing at startup (seen on Linux).
- On Linux the .deb always runs Chromium's setuid sandbox, so the lock screen's process is sandboxed and other programs cannot read its memory. When Slate runs without the sandbox (the AppImage on Ubuntu 23.10 and later), the lock screen and Settings → Security say so and recommend the .deb.


- The security log and the diagnostic log are readable by your user account only (folder 0700, files
  0600), on encrypted and plaintext installs alike. Repeated unlock attempts during a FIPS 140-3
  lockout are recorded once a minute with a count instead of one line each, and setting the computer's
  clock back no longer makes a lockout last longer than its three hours.
- Your password and recovery key go from the field you type them in to Slate's cryptographic module as
  bytes, never as text, and every copy is wiped after use; the recovery key is decoded inside the module.
  After unlocking, the lock screen's window is replaced by a new one, so the process that saw the
  password ends. Slate turns off crash dumps of itself (and, on Linux, other programs reading its memory)
  before any key exists.
- A Slate window only ever shows Slate itself: a link a note opens, or anything that tries to
  navigate the window or open a new one, goes to your browser instead (https and mailto only). The
  app asks for no camera, microphone, notification or location access and refuses it if asked.
- Remote images in notes no longer load in the built app: a note can no longer tell a third party
  who opened it and when. Images you paste or import are kept with the note and still show.
- The Microsoft (OneNote import) and GitHub sign-ins are stored only in the system keychain or
  keyring. On a computer without one (Linux's basic store) Slate keeps them until you quit and you
  sign in again next time; the import dialog says so. A plain-text Microsoft token cache an older
  version left behind on such a computer is deleted.
- Updates are signed: Slate checks an Ed25519 signature on the release's update feed and on the
  installer before it offers, downloads or installs an update, and refuses one that does not verify.
  Each release also carries a CycloneDX software bill of materials.
- The app's pages load from its own `app://slate/` address instead of `file://`, and release builds
  refuse Node's `--inspect` flags. Remembered panel widths and the last opened page are reset once.
- Encryption keys derived while unlocking, changing the password or creating a recovery key are
  wiped from memory as soon as they are used, and the vault's local files are refused when larger
  than 64 KiB instead of being read whole.
- All of the vault's cryptography now runs inside `@slate/native` (OpenSSL with the FIPS provider):
  the password derivation, the master and database keys, sync encryption and remote names. Keys live
  only in the module's locked memory and are destroyed at lock; Slate's own code never holds one.
  Unlocking no longer pauses the window while the password is checked. Existing encrypted notes,
  sync folders, recovery keys and quick unlock keep working unchanged.

### Fixed

- On Linux, the offer to set quick unlock up again names the system keyring instead of Touch ID.


- An empty new line in large text shows a caret as tall as that text, not the default size.
- The text caret is full height with every font (the macOS system font drew it short).
- A pasted image no longer leaves a blinking underline: the caret moves to a paragraph after the image, and any gap cursor is drawn as a vertical caret.
- Delete or Backspace on a selected box header deletes the box (undoable) instead of scrolling the page; Escape returns to the canvas.

### Added

- Settings → Security → *Encryption keys*: **Rotate keys** (a new master key and recovery key, your notes
  re-encrypted here and in the sync folder, the password unchanged), **Upgrade encryption format** (a
  vault made by 0.1.x moves to format 2) and **Convert to FIPS 140-3** (one way, a new 15-character
  password). Other devices stop syncing until unlocked again with the password, then follow; files
  sealed under the old keys leave the sync folder once everything was re-sent, and git users can
  replace the sync history with one commit. A FIPS 140-3 vault says when its keys are two years old.
  Every change can be interrupted and resumes. **Update every device before upgrading, converting or
  rotating**: these are offered only once every device that syncs runs a version that reads format 2.

- A FIPS 140-3 vault now limits password guessing and idle time: three wrong passwords within
  15 minutes lock password unlock for three hours (the recovery key still works and resets it),
  the idle lock is at most 15 minutes ("Never" is not offered), and locking on sleep and on screen
  lock are always on, however the vault was opened. Slate also keeps a small security log
  (unlock, failed unlock, lock, throttle, header refused) in the data folder, whether or not the
  diagnostic log is on, never with a password, key or note title.
- End-to-end encryption, opt-in from Settings → Security → *Encrypt my notes…*: notes and images
  are encrypted on this computer and in the sync folder (git or OneDrive) under your password, with a
  recovery key shown once. With sync on, the sync folder's history is replaced by one encrypted
  commit. Other devices are asked for the password and join; password changes and new recovery keys
  reach them on their next sync. Settings → Security also sets when Slate locks (idle, sleep, screen
  lock) and turns on quick unlock with Touch ID (macOS) or the system keyring (Linux). AI agents
  reach encrypted notes through the running app only while it is unlocked. Update every device
  before encrypting: older versions cannot read encrypted notes.
- Settings → Security shows Slate's cryptographic module: the OpenSSL FIPS Provider 3.1.2 (FIPS 140-3,
  CMVP certificate #4985), whether it runs in approved mode, and how long its start-up self-test took.
  Builds now bundle the new `@slate/native` module (OpenSSL 3.5 with the FIPS provider); notes move
  onto it in a later release.
- The notes database now runs on SQLCipher 4.19 built into `@slate/native`, on the same OpenSSL and
  FIPS provider: its key goes to SQLCipher only from the module, never as text. Encrypted notes from
  earlier versions open unchanged. Building from source now needs `npm run -w @slate/native build`.
- New vaults use the version 2 formats (crypto suite 0x02): SP 800-108r1 key derivation, authenticated remote names
  (an HMAC synthetic IV with AES-CTR instead of one AES-ECB block), padded and versioned sync files, and a vault
  header that names its profile and algorithms. Builds with the FIPS module offer a **FIPS 140-3** profile when you
  encrypt: PBKDF2-HMAC-SHA-512 for the password, 15-character passwords, no Touch ID or keyring unlock, and only
  approved algorithms for the life of the vault. Existing encrypted vaults are not changed. A device keeps a signed
  record of its vault's profile and refuses an older or weaker vault header. Older Slate versions cannot open or
  join a vault created by this one (they call its vault file "damaged"), and a 0.1.x device that changes its
  password can overwrite it: update every device first. This version never writes over a vault file it cannot
  read. Joining another vault now re-encrypts this device's notes under a new key.
- Slate tests its cryptography every time it starts, before it opens any note: known-answer tests of every
  algorithm and of how Slate combines them (key derivation, sync files, remote names, password KDFs). If one
  fails, Slate shows only an error screen with the failed test, **Quit** and **Copy diagnostic report**, and opens
  nothing, encrypted or not; your data folder is left as it was. Settings → Security → *Run self-tests* runs them
  again, and they also run before every vault change. A failure while Slate is open closes every window, the
  databases and the AI-access socket at once.
- After its first sync, a new device opens the notebook you last had open on another device instead of an empty one.
- Folio and Folio Dark themes: warm ivory or charcoal, a clay accent, pill-shaped controls, a fine
  paper grain, and bundled Source Serif 4 for notes and Inter for the interface (work offline).
- Themes can give the sidebar and toolbar their own texture or a gradient between palette colours;
  Paper's sidebar and toolbar now have its paper grain, and generated themes can use it too.

### Changed

- Glass is now Liquid Glass: panes get a sheen, a bright rim and a lens edge over a blurred,
  saturated backdrop, and notes sit on a feathered solid reading surface. Its settings are
  part of the theme (saturation, highlight, refraction).
- Links open in the browser only when they are `https:` or `mailto:`; an `http:` link (or any other
  scheme) in a note is no longer handed to the system.
- The installed app's window runs under a stricter content security policy: it makes no network
  connections of its own, and images from plain `http:` addresses are no longer shown (`https:`
  images still are).

## [0.1.0] - 2026-10-22

### Added

- Free-form pages: click anywhere to type, movable boxes, images, tables and code blocks.
- Find in page (Cmd/Ctrl+F) with match case, whole word and regular expressions.
- Notebooks, sections and pages in a sidebar whose columns fit their names.
- Imported text colours are drawn readable on the dark theme, without changing the notes.
- A private flag per box that hides it from AI agents.
- A sync button in the toolbar: shows when the last sync was, and syncs on click.
- Copy as plain text and as clean HTML; paste keeps structure and drops formatting noise.
- Import from OneNote (Microsoft Graph) and from OneNote backup files.
- Sync through OneDrive or a git repository, with conflict resolution.
- An MCP server (`slate-mcp`) so AI agents can read and edit notes, with an activity log.
- Release builds for macOS (Apple Silicon dmg) and Ubuntu (.deb and AppImage), and in-app update
  checks against GitHub Releases.
- Search across notes (Cmd/Ctrl+Shift+F) in all notebooks, one notebook or one section, remembered;
  the left bar's views are plugins.
- Links: Cmd/Ctrl+K adds or edits one, and pasting a URL onto selected text links it.
- `* ` and a space starts a bulleted list (on by default; Settings → Autocorrect).
- OneNote-style toolbar: colour and highlighter palettes, list styles (1. a. i. A. I.), clear
  formatting, table, and a clearer private-box padlock.
- Settings (Cmd/Ctrl+,): Autocorrect, Appearance, Sync, General, Updates and Diagnostics.
- Themes: Dark, Light, Glass, Paper (textured), Solarized Light and Nord, or one Claude designs for
  you; a note font and an app font per theme; animations can be turned off.
- A title bar drawn by Slate that follows the theme (an in-app menu bar on Linux).
- An opt-in diagnostic log that never records note content.

[Unreleased]: https://github.com/nuwanprabhath/slate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nuwanprabhath/slate/releases/tag/v0.1.0

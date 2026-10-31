# Changelog

All notable changes to Slate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

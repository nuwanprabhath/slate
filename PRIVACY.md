# Slate privacy notice

Slate is a notes app that runs on your computer. This notice says what stays on it, what Slate can send
elsewhere and only after you allow it, how long each kind of data is kept, and how to use your rights.
It describes the version of Slate you are reading it with; the text in each consent step in the app
comes from the same list as the tables below.

## Who is responsible

Slate has no server and no account. The author does not receive your notes, your settings or any
usage data, and runs no service that could. When you use Slate on your own, you decide what is stored on
your computer, and you are the controller of that data. The only parties that receive data are the ones in
the table below, and only for a feature you turned on.

## What stays on your computer

Your notes, images, search index, settings, logs and keys live in Slate's data folder on your computer
Slate sends none of it anywhere unless you turn on one of the
features below. There is no telemetry, no crash reporting and no analytics.

If you encrypt your notes with a vault (Settings → Security), the database and images are encrypted at rest.
Without a vault they are stored as ordinary files in your own user profile, protected by your operating system's
file permissions.

## Strict mode: nothing leaves without your consent

New installs start in **strict mode** (Settings → Privacy). In strict mode every feature in the next table is
off until you allow it in a consent step that names what it contacts, what it sends and who receives it. You can
withdraw each consent at any time in Settings → Privacy, and the feature stops at once. Turning strict mode off
lets features run as you configured them, without asking again.

Slate installs that existed before strict mode keep the features they already used. Slate lists them in a
"Review your privacy settings" card, where you choose Keep or Withdraw for each.

## Optional features that contact the internet

Each row is a consent identifier (`updates`, `gitSync`, `oneDriveSync`, `plaintextSync`, `microsoftSignIn`,
`githubSignIn`, `claudeTheme`) used by the app and by the guard that keeps this notice in step with the code.

| Feature (consent id) | Contacts | What is sent | Recipient and country | Turn it off |
| --- | --- | --- | --- | --- |
| Check for updates automatically (`updates`) | `github.com`, `objects.githubusercontent.com` | Your IP address, Slate's version, your operating system and its version | GitHub, Inc. (USA) | Settings → Updates, or withdraw in Settings → Privacy |
| Sync with a git repository (`gitSync`) | `github.com`, or the host of the repository you choose | The notes and images you sync, your IP address, the repository credentials | The host of the repository you choose (often GitHub, Inc., USA) | Settings → Sync → Turn off, or "Turn off and forget this connection" |
| Sync with OneDrive (`oneDriveSync`) | `graph.microsoft.com`, `login.microsoftonline.com` | The notes and images you sync, your IP address, your Microsoft account sign-in | Microsoft Corporation (USA) | Settings → Sync → Turn off |
| Sync without encryption (`plaintextSync`) | Same hosts as the sync provider you chose | Your notes and images readable by the sync provider, and the names of your notebooks, sections and pages | Your sync provider (GitHub or Microsoft, USA) | Encrypt your notes with a vault, or withdraw in Settings → Privacy |
| Sign in to Microsoft to import from OneNote (`microsoftSignIn`) | `login.microsoftonline.com`, `graph.microsoft.com` | Your Microsoft account name, your IP address, the OneNote pages and images you import | Microsoft Corporation (USA) | Sign out in the import dialog, or withdraw in Settings → Privacy |
| Sign in to GitHub for sync (`githubSignIn`) | `github.com`, `api.github.com` | Your GitHub account, your IP address, the access that the GitHub permission "repo" grants | GitHub, Inc. (USA) | Withdraw in Settings → Privacy |
| Describe a theme with Claude (`claudeTheme`) | `api.anthropic.com`, through the `claude` command already on your computer and your own sign-in | The theme description you type and your current theme colours | Anthropic PBC (USA) | Withdraw in Settings → Privacy |

Notes on these features:

- Transfers to the USA depend on the recipient's own safeguards (for example the EU-US Data Privacy Framework or
  standard contractual clauses). Read their notices: [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement),
  [Microsoft](https://privacy.microsoft.com/privacystatement) and [Anthropic](https://www.anthropic.com/legal/privacy).
- Updates only ask for the list of releases. Downloading and installing a release is always your own action.
- Sync runs on a timer once it is on, and stops when you turn it off or withdraw its consent.
  "Turn off and forget this connection" also removes the stored tokens, the local copy of the remote
  and the sync bookkeeping.
- Importing from OneNote **backup files** is local and needs no consent. Only signing in to Microsoft does.
- Links you open in a note open in your own browser, outside Slate.
- Slate's spell checker is the one built in to your operating system; Slate does not download dictionaries.
- AI agents you connect yourself (Help → Connect AI agents) read only the notebooks, sections and pages you
  shared with them. What an agent does with what it reads is decided by that agent and its provider
  (for Claude Code: Anthropic), not by Slate.

## Retention: what Slate keeps, and for how long

Slate stores these in one local database file (`slate.db`) plus a few folders. "Local" means your computer only.

| Data | Where (table or file) | Contains | Kept for | Export |
| --- | --- | --- | --- | --- |
| Notes, with their edit history | `snapshots`, `updates` | All note content, including text you later deleted (the history allows undo and sync merging) | Until you delete the note, or Erase all. For a note never synced, Settings → Privacy → Erase edit history drops deleted text | exported: the current text as Markdown, not the edit history |
| Search index | `search` | The plain text of every box, so search is fast | Rewritten as you edit; freed space is overwritten with zeros (from 0.8 on; text deleted before 0.8 in a database without a vault may remain in free space until the database is rewritten), and Purge caches rebuilds the index | not exported: rebuilt from the notes, which are |
| Edit sequence bookkeeping | `doc_heads`, `seq_counter` | Counters per note, no content | With the notes | not exported: counters with no content |
| Settings | `settings` | Your preferences, consents, the sync remote address, device id, theme prompts | Until you change them or erase all | exported |
| Images | `blob_data` (with a vault) or the `blobs` folder (without) | Images pasted into notes | Until no note uses them and you purge caches in Settings → Privacy | exported |
| AI activity | `audit` | Which tool an agent called and on which page; for searches only the length of the query | The most recent entries, up to 30 days in strict mode (90 days with strict mode off), or until you press Clear in AI Activity | exported |
| Sync bookkeeping | `sync_meta`, `sync_seen`, `blob_synced`, `transport_observations` | Cursors, item ids, host names | Until you turn sync off and forget the connection | not exported: cursors and item ids only this device's sync can use; the remote's address is in the exported settings |
| Sync conflicts | `conflicts` | Both versions of a conflicting text and the other device's name | Until you resolve each one; in strict mode, at most 90 days | exported |
| Sync and import notices | `notices` | Short status messages | The most recent 1,000 | not exported: status messages Slate wrote, none of your content |
| OneNote import | `import_items`, `import_map` | OneNote ids and import status | Until you erase all | not exported: OneNote ids that only a re-import on this device uses |
| Diagnostic log | `logs` folder | What Slate did, with notes' text, titles and search queries left out, and your home folder shown as `~`; tokens and passwords stripped | Off by default. While on, 7 days or 20 MB. In strict mode, switching it off removes the files; otherwise Purge caches and logs does | not exported: off by default and holds no note content; Settings → Diagnostics opens the file |
| Security record | `security-log` folder | Unlock and lock times and methods, no notes | Always on. 30 days in strict mode, 90 days with strict mode off or under FIPS 140-3. View and clear it in Settings → Privacy (not clearable under FIPS 140-3) | exported |
| Sign-in tokens | `msal-cache.bin`, `git-sync` folder | Microsoft and GitHub tokens, sealed by your operating system's keyring | Until you sign out or forget the connection | not exported: secrets sealed to this computer's keyring, which open nothing elsewhere |
| Temporary files | `slate-one2html-*`, `slate-theme-*` in your temporary folder | OneNote backup contents while importing | Removed when the import ends, and any left after a crash are removed at the next start | not exported: removed when the import ends |
| Update bookkeeping | `update-result.json`, `update-result.json.download` | The outcome of the last macOS install, and the path and checksum of the installer it used (a path in your Downloads folder) | Read and removed at the next start after an install; a verified installer download is deleted then too; Erase all removes both files | not exported: install bookkeeping, removed at the next start |
| Browser storage | Chromium `Local Storage` | Panel layout and custom colours | Until you erase all | not exported: panel layout and colours |

A vault encrypts `slate.db` and the images. The security record, the diagnostic log and the tokens are not
inside the vault: the logs hold no note content, and the tokens are sealed by your operating system.

## Your rights, and how to use them in the app

Open Settings → Privacy.

- **Access and portability:** "Export everything…" writes your notes as Markdown with their images, your
  settings, the AI activity, the sync conflicts and the security record to a folder you pick.
- **Erasure:** delete a note in the library, and the space it used is overwritten with zeros (from 0.8 on; text deleted before 0.8 in a database without a vault may remain in free space until the database is rewritten); "Purge caches and
  logs" removes unused images, temporary files and logs; "Erase all Slate data…" (type `ERASE`) removes every
  Slate file and sealed sign-in token on this computer and restarts Slate. The system keyring keeps one entry,
  Slate's storage key, which opens nothing once those files are gone. "Erase edit history…" replaces a note's
  history with its current state, so text you deleted no longer sits in it (zeroed from 0.8 on, as above). It works on a note that has never been
  synced, with sync off; a note already on another device could not be merged with that device's edits afterwards,
  so Slate refuses it and says why. Data you already synced stays at your sync provider until you remove it there.
- **Withdrawing consent:** each consent in the list has a Withdraw button. Withdrawing is as easy as granting.
- **Objection and restriction:** leave strict mode on and decline; nothing is sent.
- **Rectification:** edit your notes and settings directly.
- **Complaint:** you may complain to your data protection authority.

Because the author holds none of your data, there is nothing the author can look up, export or erase for you;
the controls above are how these rights are met.

## For organisations

If your organisation deploys Slate, your organisation is the controller of the notes its people store, and
the recipients above are processors or independent controllers under their own terms.

- Leave strict mode on, and approve each feature in the table before your people allow it.
- Records of processing: use the "Optional features" table for the transfers and the "What Slate keeps" table for
  retention. The local security record supports your own access and audit log needs.
- Prefer the vault: it encrypts notes at rest and lets sync send only ciphertext.
- Security reports: see [SECURITY.md](SECURITY.md).

## Changes to this notice

When a feature starts sending different data, its consent text changes version and Slate asks again before it
runs. This notice changes in the same release.

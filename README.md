# Slate

Fast, developer-friendly free-form notes. See `docs/superpowers/specs/2026-10-21-slate-design.md`.

## Install

Download the latest build from [Releases](https://github.com/nuwanprabhath/slate/releases).

### macOS (Apple Silicon)

1. Download `Slate-<version>-mac-arm64.dmg`, open it and drag Slate to Applications.
2. Slate is not signed with an Apple Developer ID, so macOS blocks the first launch
   ("Slate is damaged" or "cannot be opened"). Either clear the quarantine flag:

   ```bash
   xattr -cr /Applications/Slate.app
   ```

   or right-click Slate in Applications, choose **Open**, then **Open** again. You only do this once
   per install.

Intel Macs: build from source with `npm run dist:mac:x64`.

### Ubuntu / Debian (x64)

```bash
sudo apt install ./Slate-<version>-linux-amd64.deb
```

Use `apt` with the `./` path (not `dpkg -i`) so dependencies are installed. The `.AppImage` also
works: `chmod +x Slate-*.AppImage` and run it.

### Windows

No release builds yet. Build from source: `npm install`, `npm run build:one2html`, then `npm run dist`.

## Updates

Slate checks GitHub Releases shortly after launch and every few hours, or when you choose
**Check for Updates…** (the Slate menu on macOS, Help on Linux). When a newer version exists, a
banner across the top of the window offers it; it never interrupts with a dialog, and a failed
check stays silent.

- **AppImage**: *Download and install*, then *Restart and install*.
- **macOS**: *Download* fetches the dmg, verifies it and opens it. Drag Slate to Applications, or use
  *Copy install command*, paste it into Terminal after quitting Slate (it copies the app out of the
  dmg and clears the quarantine flag).
- **.deb**: *Download* fetches the `.deb`; *Copy install command* gives
  `sudo apt install '<path to the .deb>'` to run in a terminal.

*Skip this version* hides that version for good; the × hides the banner until the next version.

## Develop

```bash
npm install        # also rebuilds better-sqlite3 for Electron
npm run dev        # run the app with hot reload
npm test           # unit tests (core + editor)
npm run test:main  # main-process tests (SQLite, blobs) under Electron's Node
npm run e2e        # build + Playwright end-to-end tests
npm run typecheck
```

## AI access

Slate ships an MCP server so AI agents such as Claude Code can read and write your notes. Build first
(`npm run build -w @slate/desktop`), then register it:

```bash
claude mcp add slate -- $PWD/bin/slate-mcp
```

Nothing is shared until you grant access in the sidebar (right-click → AI access). Private boxes are never
sent to an agent.

# Packaging Slate

Slate is packaged with electron-builder. The configuration is `packages/desktop/electron-builder.cjs`.
Output goes to `packages/desktop/release/` (gitignored). Artifacts are named
`Slate-<version>-<os>-<arch>.<ext>`.

## Building

| Goal | Command | Needs |
| --- | --- | --- |
| Unpacked app for tests | `npm run dist:dir` | the host OS only |
| Installers for the host OS | `npm run dist` | the host OS |
| Test the unpacked build | `npm run e2e:packaged` | `dist:dir` first |

- **macOS:** `dmg` and `zip`, arm64 and x64. Build on a Mac.
- **Windows:** `nsis` installer. Build on Windows (CI does).
- **Linux:** `AppImage` and `deb`. Build on Linux (CI does).

`better-sqlite3` is rebuilt for Electron during packaging (`npmRebuild`), and its `.node` files are
unpacked from the asar (`asarUnpack`). Electron's version is pinned in `electron-builder.cjs`
(`electronVersion`) because `package.json` holds a range; change both together.

On macOS, `e2e:packaged` runs `scripts/verify-mac-app.mjs` before launching. It checks
`codesign --verify --deep --strict`, ad-hoc signs once if that fails, and skips the packaged tests
if the app still does not verify. A broken signature can crash with a dialog on your screen.

## Signing

No secrets live in the repo. electron-builder reads these environment variables; without them the
build is unsigned (macOS: ad-hoc) and still runs locally.

| Platform | Variables |
| --- | --- |
| macOS signing | `CSC_LINK` (base64 or path of the Developer ID `.p12`), `CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

Notarization needs a paid Apple Developer account and the hardened runtime (already on). In CI,
store these as repository secrets; `.github/workflows/ci.yml` passes them through when present.

## Auto-update (off by default)

Updates are enabled only when the app is packaged **and** `SLATE_UPDATE_URL` was set when it was built:

```sh
SLATE_UPDATE_URL=https://updates.example.com/slate npm run dist
```

The build then publishes a generic feed config into the app and writes `resources/update.json`
(`{"url": "…"}`) next to it. Without the variable neither exists, and "Check for Updates…" is
hidden in the Help menu.

Host the contents of `release/` at that URL: the installers plus the `latest.yml`,
`latest-mac.yml` and `latest-linux.yml` files electron-builder generates. The app checks 10 seconds
after launch and every 6 hours, and from Help → Check for Updates…. Errors go to the log only.
macOS auto-update requires a signed app.

## Microsoft sign-in (OneNote import and OneDrive sync)

Register an Azure app (public client, redirect `http://localhost`) and give Slate its client id
either as `SLATE_MS_CLIENT_ID` at runtime or in the import dialog (stored in settings).

## The MCP launcher

AI agents start Slate's MCP server through a launcher shipped inside the app. Help → Connect AI
agents… shows the exact `claude mcp add slate -- "<path>"` command for the install.

| Platform | Launcher |
| --- | --- |
| macOS | `Slate.app/Contents/Resources/bin/slate-mcp` |
| Linux | `<install dir>/resources/bin/slate-mcp` |
| Windows | `<install dir>\resources\bin\slate-mcp.cmd` |

From a source checkout the launcher is `bin/slate-mcp` (build first).

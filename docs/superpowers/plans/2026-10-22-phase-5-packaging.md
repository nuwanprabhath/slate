# Slate Phase 5 — Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build installable Slate apps for macOS (dmg + zip, arm64 + x64), Windows (NSIS) and Linux (AppImage + deb), with the Slate icon. The packaged app includes a working `slate-mcp` launcher for AI agents and an in-app "Connect AI agents…" helper. Auto-update stays switched off until a publish URL is configured. Signing is driven by environment variables, and a CI workflow builds all three platforms.

**Architecture:**
- `electron-builder` packages `packages/desktop` (config in `packages/desktop/electron-builder.yml`). Main/preload/renderer are already bundled by electron-vite (workspace packages are bundled), so the app's only runtime `node_modules` are `better-sqlite3` (native, unpacked from asar) and `loro-crdt`.
- The packaged launcher runs the app's own executable with `ELECTRON_RUN_AS_NODE=1` on `app.asar/out/main/mcp.js`. Electron's Node mode reads asar files.
- `electron-updater` is wired behind a feature check: no publish URL means no update checks.

**Tech Stack:** `electron-builder` 26.15, `electron-updater` 6.8, plus the existing stack.

## Global Constraints

- **Identity:** appId `dev.slate.notes`, productName `Slate`. Artifact name `Slate-${version}-${os}-${arch}.${ext}`.
- **Icons:** `packages/desktop/build/icon.icns`, `icon.ico` and `icons/` (Linux). They already exist and `scripts/icons.mjs` regenerates them.
- **Never launch a packaged macOS app whose signature does not verify.** Before any launch, run `codesign --verify --deep --strict <app>`. If it fails, ad-hoc sign it (`codesign --force --deep --sign - <app>`) and verify again. If it still fails, do not launch. Stray crash dialogs land on the maintainer's screen.
- **Packaged e2e** keeps the window hidden (`SLATE_E2E=1`), uses a temporary `SLATE_USER_DATA`, and launches the packaged app once per run. Kill leftover processes afterwards.
- **Signing:** only through electron-builder's standard environment variables (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`). No secrets in the repo. Without them, builds are unsigned (mac: ad-hoc) and still run locally.
- **Auto-update:** enabled only when the app is packaged **and** `SLATE_UPDATE_URL` was set at build time. The build writes it to `resources/update.json`; the app reads it at runtime.
- **Building locally on this Mac:** only the mac targets (`--mac --dir` for tests). Windows and Linux are built in CI.
- Conventional Commits, no AI attribution, never push to git.

---

### Task 1: electron-builder config and the unpacked mac build

**Files:**
- Create `packages/desktop/electron-builder.yml`, `packages/desktop/e2e-packaged/{playwright.config.ts,packaged.spec.ts}`, `scripts/verify-mac-app.mjs`.
- Modify `packages/desktop/package.json` (scripts, `electron-builder` devDependency, `"productName": "Slate"`, `"description"`, `"author"`, `"version"`) and the root `package.json` (`dist`, `dist:dir`, `e2e:packaged`).

`electron-builder.yml`:

```yaml
appId: dev.slate.notes
productName: Slate
copyright: Copyright © 2026 Nuwan Munasinghe
directories:
  output: release
  buildResources: build
files:
  - out/**
  - resources/**
  - package.json
asarUnpack:
  - "**/*.node"
extraResources:
  - from: launchers
    to: bin
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [arm64, x64]
    - target: zip
      arch: [arm64, x64]
  icon: build/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
win:
  target: nsis
  icon: build/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
linux:
  target: [AppImage, deb]
  icon: build/icons
  category: Office
  maintainer: Nuwan Munasinghe
artifactName: Slate-${version}-${os}-${arch}.${ext}
npmRebuild: true
```

Scripts in `packages/desktop/package.json`:
- `"dist": "electron-vite build && electron-builder"`
- `"dist:dir": "electron-vite build && electron-builder --dir"`
- `"e2e:packaged": "playwright test --config e2e-packaged/playwright.config.ts"`

The root `package.json` forwards `dist`, `dist:dir` and `e2e:packaged` to the workspace. `release/` goes in `.gitignore`.

`scripts/verify-mac-app.mjs <path-to-Slate.app>` runs `codesign --verify --deep --strict`. On failure it ad-hoc signs and verifies again. It exits non-zero when the app still does not verify.

`e2e-packaged/packaged.spec.ts`:
- finds `packages/desktop/release/mac*/Slate.app` (or the Linux `linux-unpacked/slate` binary when `process.platform === 'linux'`);
- on mac, runs `node scripts/verify-mac-app.mjs <app>` first and **skips the test with a clear reason** if verification fails;
- launches with Playwright `_electron.launch({ executablePath, env: { SLATE_E2E: '1', SLATE_USER_DATA: tmp } })`.

It asserts that:
1. the window title is `Slate`;
2. the notebook picker shows "My Notebook" (the database opened, so `better-sqlite3` loaded from the unpacked asar);
3. typing in a new box and relaunching keeps the text.

- [ ] **Step 1:** Add the config, scripts and spec. Run `npm install`.
- [ ] **Step 2:** `npm run dist:dir` must succeed, and `release/mac-arm64/Slate.app` (or `mac/` on x64) must exist. Inspect it:
  - `npx asar list release/mac*/Slate.app/Contents/Resources/app.asar | grep -c out/main/index.js` gives 1;
  - `ls release/mac*/Slate.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/*.node` exists.

  If electron-builder cannot find hoisted workspace dependencies, set `"electronBuilder"` options or add an `afterPack` step. Read electron-builder's monorepo docs in `node_modules/electron-builder` and record the fix.
- [ ] **Step 3:** `npm run e2e:packaged` — PASS. Afterwards, no packaged Slate process is left running (`pkill -f "release/mac.*/Slate.app"`).
- [ ] **Step 4:** Commit — `git commit -am "build: electron-builder packaging for macOS, Windows and Linux"`

---

### Task 2: The packaged MCP launcher and "Connect AI agents…"

**Files:**
- Create `packages/desktop/launchers/slate-mcp` (sh, for mac and Linux), `packages/desktop/launchers/slate-mcp.cmd` (Windows), `packages/desktop/src/main/mcpLauncher.ts` (+ `mcpLauncher.test.ts`), `packages/desktop/src/renderer/src/ConnectAgents.tsx`.
- Modify `menu.ts` (Help → "Connect AI agents…", id `connect-agents`, sends `{ cmd: 'show-connect-agents' }`), `api.ts`/`ipc.ts`/preload (`mcp.launcherInfo(): Promise<{ command: string; claudeCommand: string; packaged: boolean }>`), `App.tsx`, and the packaged spec.

Launchers. Both resolve paths relative to their own location inside the packaged app.

```sh
#!/bin/sh
# Slate's MCP server for AI agents (packaged app). Register: claude mcp add slate -- "<this file>"
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$(uname)" in
  Darwin) EXE="$HERE/../../MacOS/Slate"; ASAR="$HERE/../app.asar" ;;
  *) EXE="$HERE/../../slate"; ASAR="$HERE/../app.asar" ;;
esac
ELECTRON_RUN_AS_NODE=1 exec "$EXE" "$ASAR/out/main/mcp.js" "$@"
```

```bat
@echo off
rem Slate's MCP server for AI agents (packaged app). Register: claude mcp add slate -- "<this file>"
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Slate.exe" "%~dp0..\app.asar\out\main\mcp.js" %*
```

`mcpLauncher.ts` exports `launcherInfo(opts: { packaged: boolean; resourcesPath: string; repoRoot: string; platform: NodeJS.Platform })`:
- packaged: `command` = `<resourcesPath>/bin/slate-mcp` (`.cmd` on win32);
- dev: `<repoRoot>/bin/slate-mcp`;
- `claudeCommand` = `claude mcp add slate -- "<command>"`.

Its unit test covers all three platforms and both modes.

`ConnectAgents` is an in-app overlay (`data-testid="connect-agents"`) with:
- one short paragraph: "Slate shares nothing until you allow it: right-click a notebook, section or page → AI access";
- the `claudeCommand` in a monospace block, with a "Copy" button (copies plain text);
- a one-line note for other MCP clients: "Use this command as a stdio server".

- [ ] **Step 1:** Write the failing tests:
  - the unit test above;
  - a dev e2e (`e2e/connect-agents.spec.ts`): Help → Connect AI agents shows a command ending in `bin/slate-mcp"`;
  - the packaged spec: the launcher inside the app answers `listTools` with five tools over stdio. Reuse `connectMcp`, generalised to take a command path.
- [ ] **Step 2:** Implement. Make sure the sh launcher keeps mode 755 in the package. electron-builder preserves the modes of `extraResources`; confirm with `ls -l`.
- [ ] **Step 3:** `npm run test:main && npm run e2e -- connect-agents.spec.ts && npm run dist:dir && npm run e2e:packaged` — PASS.
- [ ] **Step 4:** Commit — `git commit -am "feat(desktop): packaged slate-mcp launchers and a Connect AI agents helper"`

---

### Task 3: Auto-update (off until configured), signing docs, CI

**Files:**
- Create `packages/desktop/src/main/updates.ts` (+ test), `docs/packaging.md`, `.github/workflows/ci.yml`.
- Modify `packages/desktop/package.json` (`electron-updater` in **dependencies**), `electron-builder.yml` (`publish: { provider: generic, url: ${env.SLATE_UPDATE_URL} }` only when set: use an `electron-builder.config.cjs` that adds `publish` conditionally and writes `resources/update.json`), `menu.ts` (app menu → "Check for Updates…", visible only when updates are enabled), and `index.ts`.

**Behaviour:**
- `updates.ts` exports `updateConfig(resourcesPath): { url: string } | null`, which reads `update.json` and returns null when it is missing or empty, and `startUpdates(config, deps)`.
- When enabled:
  - `autoUpdater.checkForUpdatesAndNotify()` runs 10 s after start and then every 6 h;
  - the menu item triggers a manual check;
  - errors go to the log only, never a dialog.
- Unit tests:
  - `updateConfig` with a missing, empty or valid file;
  - `startUpdates` with a fake updater object calls `checkForUpdatesAndNotify` once after the delay (fake timers), and never when the config is null.

`docs/packaging.md` covers:
- how to build each target;
- the signing environment variables per platform;
- notarization (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`);
- how `SLATE_UPDATE_URL` turns on updates (a generic server hosting `latest*.yml` + artifacts);
- the Azure client id for Microsoft sign-in (`SLATE_MS_CLIENT_ID` at runtime, or set in the app);
- the MCP launcher paths per platform.

`.github/workflows/ci.yml`:
- on push/PR: a matrix of `macos-latest`, `windows-latest` and `ubuntu-latest`;
- each runs `npm ci`, `npm run typecheck`, `npm test` and `npm run test:main`;
- e2e on ubuntu under `xvfb-run`, and on macOS;
- `npm run dist -- --publish never` on each, uploading `packages/desktop/release/*.{dmg,zip,exe,AppImage,deb}` as artifacts;
- the signing variables come from repository secrets when present.

The workflow is not run locally: it needs a GitHub remote, which the maintainer has not set up. YAML is validated with `npx yaml-lint` or by `node -e` parsing with the `yaml` package if present; otherwise it is carefully reviewed.

- [ ] **Step 1:** Write the failing unit tests for `updates.ts`, then implement them and the conditional config.
- [ ] **Step 2:** Write `docs/packaging.md` and the CI workflow.
- [ ] **Step 3:** `npm run test:main && npm run typecheck && npm run dist:dir && npm run e2e:packaged` — PASS. With no `SLATE_UPDATE_URL`, the packaged `update.json` is absent or empty, and "Check for Updates…" is not in the menu.
- [ ] **Step 4:** Commit — `git commit -am "build: opt-in auto-update, signing docs and a three-platform CI workflow"`

---

## Done criteria for Phase 5

- `npm run dist` on this Mac produces signed-if-configured dmg and zip files that open, show the Slate icon, keep data, and include a working `slate-mcp` launcher.
- Help → Connect AI agents shows the exact `claude mcp add` command for this install.
- CI is ready to build Windows and Linux installers once the repo has a GitHub remote.
- Updates stay off until a URL is configured.

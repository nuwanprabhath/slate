# Working on Slate

Slate is a fast, developer-friendly free-form notes app (Electron + React + strict TypeScript) for
people leaving OneNote. Design: `docs/superpowers/specs/2026-10-21-slate-design.md`. Current
build plan: `docs/superpowers/plans/2026-10-21-phase-1-local-editor.md`.

## Map

- `packages/core` — pure TypeScript, no DOM, no Electron: Loro CRDT documents (`PageDoc`,
  `NotebookDoc`), auto-push maths (`computePush`), the plain-text clipboard serializer.
- `packages/editor` — React + TipTap: canvas, boxes, Loro↔ProseMirror binding, clipboard cleaning,
  `PageSession` (one open page: persistence, undo, auto-push).
- `packages/desktop` — Electron. `src/main` owns SQLite (`DocStore`) and image files (`BlobStore`);
  `src/preload` exposes `window.slate` (`src/shared/api.ts`); `src/renderer` is the app UI.

## Commands

| Task | Command |
| --- | --- |
| Install (rebuilds better-sqlite3 for Electron) | `npm install` |
| Run with hot reload | `npm run dev` |
| Typecheck everything | `npm run typecheck` |
| Unit tests (core + editor) | `npm test` (one file: `npx vitest run packages/core/test/x.test.ts`) |
| Main-process tests (Electron's Node ABI) | `npm run test:main` |
| E2E (builds first; window stays hidden) | `npm run e2e` (one spec: `npm run e2e -- canvas.spec.ts`) |
| MCP server for agents | `bin/slate-mcp` (build first); register with `claude mcp add slate -- $PWD/bin/slate-mcp` |

## Never

- Push, tag or release without asking the maintainer.
- Add AI attribution to a commit (`Co-Authored-By: Claude…`, "Generated with Claude Code");
  `.githooks/commit-msg` rejects it.
- Commit with `--no-verify`, or on a detached HEAD (`.githooks/pre-commit` refuses).
- Delete or weaken a test to get green, or leave `.only` in a test.
- Let the renderer touch the disk or network directly: everything goes through `window.slate`.

## Releasing

1. Bump `version` in the root and `packages/desktop` `package.json` (they must match), and move
   `CHANGELOG.md`'s Unreleased entries under the new version. Commit as `chore(release): vX.Y.Z`.
2. The maintainer tags `vX.Y.Z` and pushes the tag. `.github/workflows/release.yml` checks the tag
   against both versions, runs the tests, builds macOS arm64 and Linux x64 and publishes the
   GitHub release with `latest-mac.yml` and `latest-linux.yml`, which the in-app updater reads
   (`packages/desktop/src/main/update/`). Never tag or push yourself.

## Definition of done

Checked by `.claude/hooks/definition-of-done.mjs` (Stop hook) on the whole branch since
`SLATE_BASE_REF` (default `main`):

- `npm run typecheck` passes; `npm test` passes; `npm run test:main` passes if `src/main` changed.
- A behaviour change has a test in the cheapest layer, written first and seen failing. The hook
  runs changed unit tests against the base's source and requires at least one to fail there.
  Pure refactors say why in a `No-Red-Test-Reason:` commit trailer; a change needing no test says
  why in `No-Test-Reason:`.
- No test file loses cases (`Removed-Tests-Reason:` if on purpose).
- Everything committed, as a Conventional Commit (`feat(editor): …`).
- E2E specs the change touches pass (`npm run e2e -- <spec>`); the hook does not run e2e.

## Product rules (from the spec)

- **No auto-formatting by default**: lists, headings and code blocks only from an explicit
  command. TipTap input/paste rules are off unless the "Markdown Shortcuts" setting is on. No
  smart quotes, autocorrect, autocapitalise or spellcheck replacement.
- **Copy as plain text**: real list numbers, 2-space nesting, `- ` bullets, code verbatim, tabs
  between table cells, LF only, NBSP → space, no zero-width characters, trailing newlines trimmed.
  Lives in `toPlainText` (`packages/core/src/plaintext.ts`); extend it there, never a second copy.
- **Copy as HTML**: semantic tags, no inline style except colour. **Default paste**: keep
  structure and bold/italic, drop fonts, sizes, colours, classes. `Mod+Shift+V` pastes plain text.
- **Performance budget**: under 16 ms per keystroke, under 100 ms to open a page
  (`packages/desktop/e2e/perf.spec.ts`).
- E2E launches set `SLATE_E2E=1`, which keeps the window hidden: tests never pop windows onto
  the user's screen. After an e2e run, no Electron process from this checkout is left running.
- Comments say why, not what, and carry facts that still hold, not history.

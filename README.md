# Slate

Fast, developer-friendly free-form notes. See `docs/superpowers/specs/2026-10-21-slate-design.md`.

```bash
npm install        # also rebuilds better-sqlite3 for Electron
npm run dev        # run the app with hot reload
npm test           # unit tests (core + editor)
npm run test:main  # main-process tests (SQLite, blobs) under Electron's Node
npm run e2e        # build + Playwright end-to-end tests
npm run typecheck
```

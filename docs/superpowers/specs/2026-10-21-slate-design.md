# Slate — Design

Date: 2026-10-21
Status: Approved (architecture); Phase 1 to be planned next

## 1. Purpose

Slate is a fast, developer-friendly, free-form notes app for people annoyed with OneNote. It keeps what OneNote does well and fixes what it does badly.

**Keep from OneNote**
- Cloud sync to the user's own OneDrive, across devices.
- Free-floating text boxes on a page.
- Mac, Windows and Linux (Ubuntu) support.
- Copy/paste images in and out.
- Notebook → section → page organisation.
- Normal text formatting (fonts, colours, bold, italic, …).

**Fix**
- Slow on Linux → must be snappy everywhere.
- Copying to a terminal adds stray characters → clean plain-text clipboard.
- Pasting from websites drags in source formatting → structure-only paste by default.
- Auto-formatting/auto-numbering that breaks when copied to plain-text editors → no auto-formatting unless asked for; lists copy with real numbers.
- No AI access → MCP server with explicit, granular permissions.
- Growing text boxes overlap boxes below → boxes below are pushed down automatically.

**New**
- Per-box `private` flag: content never reaches AI agents, even on an allowed page.
- Selective import of existing OneNote notebooks/sections via Microsoft account.
- Offline-first, with sync and conflict handling.

**Audience:** the author first; designed so it can be released publicly later (own Azure app registration, signed builds, auto-update).

**Platforms:** desktop (macOS, Windows, Linux) now; mobile later, reusing the TypeScript core.

## 2. Tech stack

- **Shell:** Electron (Chromium on every OS, so performance and clipboard behaviour are the same everywhere — especially Linux).
- **UI:** React + TypeScript.
- **Editor:** one TipTap/ProseMirror editor per box, on a custom absolutely-positioned canvas.
- **Data:** Loro CRDT documents, persisted in SQLite (better-sqlite3, WAL mode).
- **Auth:** MSAL (auth code + PKCE); tokens in the OS keychain.
- **Cloud:** Microsoft Graph — OneDrive app folder for sync, OneNote API for import.
- **AI:** MCP server (`@modelcontextprotocol/sdk`), stdio via a `slate-mcp` CLI.
- **Repo:** npm-workspaces monorepo at `pet-projects/slate`.
- **Testing:** Vitest (unit/simulation), Playwright for Electron (e2e).

Rejected alternatives: Tauri 2 (WebKitGTK on Linux has known rendering, scrolling and clipboard problems — the exact platform this app exists to fix); fully native Flutter/Rust UI (no mature rich-text editor; months of editor work before the app is usable).

## 3. Architecture

### Processes
- **Main process (Node):** SQLite store, sync engine, Microsoft auth, MCP server, OneNote importer.
- **Renderer (React):** sidebar, canvas, box editors. Talks to main only through a typed IPC API exposed by the preload script; it never touches the disk or network.

### Packages
| Package | Responsibility | Depends on |
|---|---|---|
| `core` | Data model, CRDT operations, private-box filter, Markdown/plain-text/HTML serializers. Pure TS, no Electron. | loro-crdt |
| `editor` | Canvas, box component, TipTap schema/extensions, clipboard handlers, auto-push layout. | core |
| `sync` | OneDrive transport, per-device logs, snapshot compaction, delta polling. | core |
| `importer` | Graph OneNote HTML → Slate model. | core |
| `mcp` | MCP server and permission enforcement. | core |
| `desktop` | Electron main/preload/renderer wiring, SQLite store, settings. | all of the above |

### Data model
- Hierarchy: `Notebook → SectionGroup (optional, nested) → Section → Page → Box`. Sections and pages have an order and a colour; pages have a subpage level (0–2), as in OneNote.
- **Notebook tree document** (one Loro doc per notebook): names, colours, order, nesting, and AI permissions (`{nodeId: "read" | "readwrite"}`; anything not listed is denied).
- **Page document** (one Loro doc per page): `boxes: Map<boxId, {x, y, width, private, content}>`. Height is computed from content, never stored. The page title lives on the page's node in the notebook tree document, so the sidebar can list pages without loading every page document.
- **Box content:** a ProseMirror-compatible rich-text tree.
  - Nodes: paragraph, heading (1–3), bulletList, orderedList (with `start`), listItem, codeBlock (with `language`), table/row/cell, image (blob hash), hardBreak.
  - Marks: bold, italic, underline, strike, code, link, textColor, highlight, fontFamily, fontSize.
- **Blobs:** images stored content-addressed by `sha256`, outside the CRDT.

### Auto-push layout
When a box's rendered height changes by Δ, every box whose top is at or below the old bottom edge of the growing box and whose horizontal span overlaps it moves down by Δ. This cascades: a pushed box pushes the boxes below it. Shrinking does not pull boxes up. The moves are written to the page doc as one undo step together with the edit that caused them.

## 4. Editor and clipboard

### Canvas
- Click empty space to create a box at that point. Drag a box by its top handle; resize width from its right edge.
- The page grows to fit its content.
- Off-screen boxes render as lightweight static HTML until they are scrolled into view or focused.
- Performance budget: under 16 ms per keystroke, under 100 ms to open a page (local read only).

### No auto-formatting by default
- Lists, headings and code blocks are created only by an explicit command: shortcut, toolbar or `/` menu.
- Typing `1.` or `-` at the start of a line stays plain text by default. Markdown input rules can be enabled in settings.
- Off by default: auto-capitalisation, smart quotes, dash replacement, link auto-formatting, spell-check auto-replace.

### Copy
Slate writes these clipboard formats itself:
- **`text/plain`:**
  - Ordered lists use their real numbers (`start` + index).
  - Nested lists are indented 2 spaces per level; bullets are `- `.
  - Code blocks are copied verbatim.
  - Tables are tab-separated.
  - LF line endings; NBSP → space; no zero-width characters; no trailing control characters.
- **`text/html`:** clean semantic HTML (`ol`, `ul`, `pre`, `table`, `strong`, …) with no inline styles except colour.
- **Images:** a single selected image is written as PNG image data.

### Paste
- **Default:** keep structure (lists, headings, tables, code, bold, italic, links); drop font family, size, colour, background and all other inline styles.
- Pasting inside a code block inserts plain text verbatim.
- **Cmd/Ctrl+Shift+V:** paste as plain text.
- **Images** (clipboard data or files): stored as blobs and inserted into the current box, or a new box if none is focused.

### Private boxes
Each box has a lock toggle. A private box shows a hatched border and a lock icon.

## 5. Sync (OneDrive) and offline

Offline is the default state. Every edit is committed to SQLite immediately as a CRDT update. Sync runs in the background whenever the user is online and signed in.

### OneDrive layout
In the app folder, `/Apps/Slate/`:
```
notebooks/<notebookId>/tree/<deviceId>.log
notebooks/<notebookId>/pages/<pageId>/<deviceId>.log
notebooks/<notebookId>/pages/<pageId>/snapshot.bin
blobs/<sha256>.<ext>
devices/<deviceId>.json
```
- **Single writer per file:** a device only ever writes its own `.log` files, so OneDrive never creates conflicted copies.
- **Push:** local updates are batched (about a 2-second debounce) and appended to that device's log.
- **Pull:** the Graph delta API lists changed files. Slate downloads only the new bytes and imports them into the Loro doc.
- **Compaction:** when a page's logs exceed a size threshold, a device writes `snapshot.bin` and truncates log entries the snapshot covers. Concurrent compaction is safe because CRDT import is idempotent.

### Conflicts
- **Automatic merge:** concurrent edits in different boxes, moves, reorders and property changes.
- **Overlapping text edits made while offline:** the CRDT merges them, and the box is marked "merged edits". The user can open a side-by-side of each device's version and keep one or keep the merge.
- **Delete vs edit:** the edit wins and the item is restored; the user is notified.

### Status
The title bar shows a sync indicator: synced / syncing / offline / error (with retry).

## 6. OneNote import

- **Sign-in:** Microsoft account with the `Notes.Read` permission.
- **Picker:** a tree with checkboxes. Users can tick whole notebooks, section groups, or individual sections. Importing more sections later merges them into the same Slate notebook in OneNote order.
- **Walk:** notebooks → section groups → sections → pages. For each page, fetch the HTML (`/pages/{id}/content?includeIDs=true`) and its resources.
- **Mapping:**
  - Each absolutely positioned top-level `div` (`data-absolute-enabled`, `left`/`top`/`width`) becomes a Slate box.
  - Lists, tables, headings, fonts, colours, images and links are converted to Slate nodes and marks.
  - Section and page order, section colours and page levels are kept.
- **Lossy items:** ink, embedded files and printouts are imported as images or placeholders and listed in an import report.
- **Throttling:** client-side rate limiting plus retry with backoff on 429/5xx.
- **Resumable:** progress is checkpointed per page, so an interrupted import continues where it stopped. Re-running offers to update pages changed in OneNote since the last import (by `lastModifiedDateTime`).

## 7. AI access (MCP)

- **Transport:** stdio via the `slate-mcp` CLI (`claude mcp add slate -- slate-mcp`). The CLI connects to the running app over a local socket; if the app isn't running, it opens the SQLite store read-only. Local machine only.
- **Read tools:** `list_tree`, `read_page` (Markdown), `search`.
- **Write tools** (only where the user has granted `readwrite`): `append_to_page`, `create_page`.
- **Permissions:**
  - Deny-by-default. Granted per notebook, section or page from the context menu; a grant on a container applies to everything inside it.
  - Allowed nodes show an AI badge in the sidebar.
- **Private filter:** applied in `core` before any serialization. A private box is replaced with `[private box omitted]`; neither its content nor its search matches leak. This filter is treated as a security boundary and has dedicated tests.
- **Audit log:** every agent read and write is recorded and can be viewed in Settings.
- **Agent edits:** made under a distinct CRDT peer ("agent"), so they are attributable and can be undone.

## 8. Error handling

- **Local writes:** SQLite transactions in WAL mode; no acknowledged edit is lost on a crash.
- **Sync errors:** network failures, 429, 5xx and expired tokens retry with backoff. They never block editing and are shown in the sync indicator.
- **Corrupt remote logs:** quarantined and reported; never deleted silently.
- **Import errors:** tracked per page, shown in the import report, with "Retry failed".
- **MCP:** a request for something not permitted returns an explicit "not permitted" error and is recorded in the audit log.

## 9. Testing

- **`core`:** unit tests for the model operations and the private filter. Golden-file tests for the plain-text and HTML serializers — e.g. the exact plain text of nested numbered lists, code blocks and tables.
- **`sync`:** deterministic simulation of 2–3 devices against a fake OneDrive, with random offline windows and edits. The test asserts that all devices converge.
- **`importer`:** fixture tests using saved Graph HTML.
- **e2e (Playwright + Electron):** box create/move/resize, auto-push, copy to plain text, paste from HTML, private toggle.
- **Performance:** a 200-box benchmark page. CI fails if a keystroke takes over 16 ms or opening the page takes over 100 ms.

## 10. Build order

Each phase is usable on its own and gets its own implementation plan.

1. **Local editor:** canvas, boxes, auto-push, rich text including code blocks and tables, clipboard, notebook/section/page sidebar, SQLite persistence, private flag.
2. **MCP server and permissions.**
3. **OneNote import:** Microsoft sign-in plus the selective section picker.
4. **OneDrive sync:** devices, conflict marker, compaction.
5. **Packaging:** macOS/Windows/Linux installers, auto-update, code signing.

## 11. Out of scope (for now)

Mobile apps, a web version, checklists/to-do tags, file attachments as first-class items, ink/handwriting, real-time collaboration with other users, two-way sync back to OneNote.

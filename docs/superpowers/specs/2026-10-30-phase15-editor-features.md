# Phase 15: editor features for OneNote parity (target 0.5.0)

The maintainer chose these from a gap list on 2026-10-30. Print layout: "as on screen". Every package
follows CLAUDE.md: TDD, the product rules (no auto-formatting, copy as plain text in `toPlainText`), the
UI review skill for anything drawn, guarded specs only grow, no new dependency unless approved with a
reason in `tools/guards/allowlists/dependencies.json` (a guard file: lead-only, ask in the report).

## Global rules for every package

- Shortcuts below use Mod = Cmd on macOS, Ctrl elsewhere. Do not reuse a shortcut the app menu
  (`packages/desktop/src/main/menu.ts`) or `lock/relay.ts` already takes; Lock stays Mod+Shift+L.
- **Older versions.** Content this phase adds to a page (task lists, alignment, sub/superscript marks,
  image width) syncs to devices that may still run 0.4.3. The package that adds it finds out, with a
  test that loads such a page through the 0.4.3 schema (`git show v0.4.3:packages/editor/src/extensions.ts`
  is the reference), whether 0.4.3 crashes, drops the content, or deletes it when the user edits
  elsewhere in the box. Prefer representations an older schema keeps (an attribute on an existing node
  over a new node type) where the feature allows. Report what 0.4.3 does for each addition under
  "Older versions" in the report; the lead decides before release.
- Copy as plain text (`packages/core/src/plaintext.ts`) and copy as HTML (`clipboard.ts`) must cover
  anything new in the document.
- New UI is drawn with the existing pieces (`.btn`, toolbar button styles, `ColorPalette` popover
  pattern, `.context-menu`, tokens in `app.css`) and has a UI scenario (`e2e/ui/*.ui.spec.ts`,
  `reviewUi`) per state listed below.
- Lead-only files: `CHANGELOG.md`, the version fields, `CLAUDE.md`, guard files. Shared files that
  several packages touch (`Toolbar.tsx`, `toolbarIcons.tsx`, `extensions.ts`, `keymap.ts`,
  `main/menu.ts`, `shared/ipc.ts`, `ipcGuard.ts`, `api.ts`, `preload/index.ts`, settings schema): keep
  each change small and self-contained (new entries appended, no reformatting) so merges stay clean.

## WP-A Box cut, copy, paste, duplicate (item 1)

Owner of: `packages/editor/src/{Canvas,Box,StaticBox}.tsx`, `PageSession.ts`, `canvas.css`, a new
`packages/editor/src/boxClipboard.ts`, core page-doc helpers for copying a box's content.

- Box selection already exists (click a title bar; Mod+click adds). With boxes selected and focus on
  the canvas (not inside a box's text):
  - Mod+X marks them **cut**: drawn at 50% opacity with a 2px dashed `--accent` outline. Nothing is
    removed yet. Esc, a new cut or copy, or editing the box cancels the mark.
  - Mod+C copies them. Mod+D duplicates them in place, offset 24px right and down, and selects the
    copies.
  - Mod+V pastes at the canvas caret (the last click on empty canvas), else at the top-left of the
    visible area. Several boxes keep their relative layout, anchored at their top-left corner.
    Pasting a cut moves the boxes (removed from the source page, on this page or another page in any
    notebook) and clears the mark. Pasting a copy makes copies with fresh ids and may be repeated.
  - Undo: paste and duplicate are one undo step on the target page; a moving paste across pages also
    restores the source page's boxes when undone, or the package reports why it cannot and makes the
    move recoverable another way.
- The box clipboard is in memory, in the renderer. The system clipboard also gets the boxes' plain
  text and HTML, so other apps paste their text. When the system clipboard no longer holds that text
  (the user copied something else), Mod+V pastes the system clipboard as today.
- Images inside copied boxes keep their `slate-blob:` addresses (same vault).
- UI scenarios: "box marked for cut", "pasted boxes" (Dark/Light at 800 and 1280).
- e2e: cut and paste on the same page, cut on page 1 and paste on page 2, copy twice, duplicate, Esc
  cancels, undo of a paste.

## WP-B Find and replace (item 2)

Owner of: `packages/desktop/src/renderer/src/find/*`, `packages/editor/src/find.ts`,
`packages/desktop/src/renderer/src/plugins/search/*`, any main-side code for replacing in closed pages.

```text
Find bar (page)                                        Find in Notes (side pane)
[▸] [find______________] Aa ab .*  2 of 9  ↑ ↓ ×        [▸] [find__________] Aa ab .*
    [replace___________] AB  [Replace] [Replace All]         [replace_______] AB  [Replace All…]
                         ^ Preserve Case                    Page A (3)  ☑ line … match …
```

- A ▸ toggle reveals the replace row; Mod+Alt+F (macOS) / Ctrl+H (others) opens the bar with it shown
  and focuses the replace field. Enter in the replace field = Replace (current match, then next);
  Mod+Enter = Replace All. Preserve Case (AB) keeps the match's case pattern (all caps, Capitalised,
  lower). Regex replace supports `$1`…`$9` and `$&`.
- Replace All in the page is one undo step. Replacing never crosses formatting it cannot keep: the
  replacement takes the marks of the first character of the match.
- Find in Notes: Replace All… shows the matches grouped by page with a tick box per match and per
  page (all ticked); "Replace N in M pages" confirms. Each changed page is one undo step on that page
  when opened. Pages in notebooks with AI access off are still the user's own: no special case.
  Encrypted vaults: replacing happens on unlocked data only (the channel is locked-gated).
- UI scenarios: "find bar with replace", "find in notes replace preview", in every theme at 800 and
  1280.
- Tests: preserve case, regex groups, undo of Replace All, replacing across 3 pages (one closed).

## WP-C1 Checkboxes, alignment, subscript and superscript (items 3, 4, 7)

Owner of: `extensions.ts` (new extensions), `Toolbar.tsx`, `toolbarIcons.tsx`, `keymap.ts`,
`packages/core/src/plaintext.ts`, `staticRender.ts`, `clipboard.ts` (HTML for the new nodes).

- To-do list: toolbar button (after numbered list) and Mod+Shift+9. Clicking a checkbox ticks it; a
  ticked item's text is drawn muted with a line through it. Tab/Shift+Tab nest. Never from typing
  `[ ]` (no input rule). Plain text: `- [ ] item`, `- [x] item`, nested with 2 spaces. HTML: `<ul
  data-type="taskList"><li><input type="checkbox" checked disabled> …`.
- Alignment: a toolbar dropdown (left, centre, right) and Mod+Alt+Shift+L, Mod+Shift+E, Mod+Shift+R,
  for paragraphs and headings. Copied HTML keeps it as `style="text-align:…"` (the one inline style
  besides colour; update the copy-as-HTML rule in the report so the lead edits CLAUDE.md).
- Subscript and superscript: two toolbar buttons and Mod+Shift+, / Mod+Shift+. (exclusive of each
  other). HTML `<sub>`/`<sup>`; plain text keeps the characters.
- Toolbar at 800 px: the toolbar already wraps/overflows; the new buttons must pass the UI audit there.
- UI scenarios: "to-do list" (ticked and unticked, nested), "alignment menu open", "sub and
  superscript", toolbar at 800 and 1280 in every theme.
- The "Older versions" check above is mandatory here.

## WP-C2 Indent and move lines, format painter, fold headings (items 5, 10, 11)

Starts after WP-C1 merges (same toolbar, keymap and extensions files).

- Tab / Shift+Tab on a paragraph or heading (not in a list or table) indents/outdents it in 24px
  steps, up to 8 (an `indent` attribute on paragraph and heading, rendered as margin-left). In lists
  they keep nesting as today; in tables and code blocks they keep their current meaning.
- Alt+Shift+Up/Down moves the current block (or the selected blocks; a list item with its children)
  up or down one place, within the box. One undo step each.
- Format painter: a brush toolbar button. Click: copies the marks (bold, italic, underline, strike,
  code, colour, highlight, font, size, sub/sup) and block type at the selection; the next text
  selection gets them, then it turns off. Double-click: stays on until Esc or a click on the button.
  The cursor shows a brush while on. Clears marks the target has that the source lacks.
- Fold headings: hovering a heading shows a ▸/▾ in the box's left margin; clicking folds everything
  until the next heading of the same or higher level. Folded state is per device and not synced
  (stored in the renderer, keyed by box id and the heading's position and text; a heading that no
  longer matches unfolds). A folded heading shows "…" after its text. Find (WP-B) opens folds that hide a
  match: expose a small `unfoldAt(pos)` for it.
- UI scenarios: "indented paragraphs", "format painter on", "folded heading".

## WP-D Image resize, spell-check underline (items 8, 12)

Owner of: `images.ts` (and an image node view), the image extension's attributes, `canvas.css` image
rules, settings schema/section for the new setting, `BoxEditor.tsx`'s `spellcheck` attribute.

- A clicked (node-selected) image shows four corner handles (8px squares, `--accent`). Dragging one
  resizes it keeping the aspect ratio, between 32px and the box's content width; the width is a
  `width` attribute on the image node (one undo step per drag). Double-clicking a handle resets to
  natural size. Copied HTML carries `width`. The "Older versions" check applies.
- Spell check: Settings → Autocorrect → "Underline misspelled words" (`spellcheckUnderline`, default
  false). On: the box editors get `spellcheck="true"`; the context menu (WP-F) must not offer
  replacement suggestions, since Slate never changes text on its own. The guarded spec
  `settingsDefaults.test.ts` gets an expectation that it starts off (guard patch).
- UI scenarios: "image with resize handles", "Autocorrect settings" (already walked by the settings
  scenario: confirm it passes).

## WP-E Print and export page as PDF (item 19)

Owner of: a new `packages/desktop/src/main/print.ts`, a print stylesheet in the renderer, menu items.

- File → Print… (Mod+P) and File → Export Page as PDF… (Mod+Shift+P is free? check; else no
  shortcut). They print the current page **as on screen**: the title, then the canvas with each box at
  its position, scaled down to the paper's printable width when wider, split across sheets as needed,
  without app chrome (sidebar, toolbar, title bar, find bar, selection rings, carets). Light colours on
  white paper regardless of the theme. Images print.
- Print uses the system dialog (`webContents.print`); export asks where to save with the save dialog
  (default name: page title + `.pdf`) and writes `printToPDF` output. Encrypted vaults: the PDF is the
  user's explicit export; write it only where they chose; nothing goes to a temp file.
- Main-process code: security review tier. Windows only through `createWindow` if a separate window is
  needed; prefer printing the existing window with print CSS.
- Tests: the generated PDF for a two-box page has the boxes' text (pdf text extraction not available?
  then check the PDF size/page count and the print CSS state in the renderer); e2e uses printToPDF
  only, never the system dialog.

## WP-F Text context menu and Copy as Markdown (item 27)

Owner of: a new `packages/core/src/markdown.ts` (`toMarkdown`, the one Markdown serializer), a new
`packages/editor/src/TextMenu.tsx`, the box editor's `contextmenu` handling, the Edit menu item.

- Right-click inside a box: Cut, Copy, Paste, Paste as Plain Text, Copy as Markdown, Select All (Cut,
  Copy, Copy as Markdown disabled with no selection). Uses the `.context-menu` look of the canvas menu.
  Paste works without a keyboard: main calls `webContents.paste()` for the sender (a new channel), so
  the normal paste path (and image storing) runs.
- Copy as Markdown: also Edit → Copy as Markdown (Mod+Alt+Shift+C). `toMarkdown` in core, like
  `toPlainText`: headings `#`, bold `**`, italic `_`, strike `~~`, inline code, code blocks with the
  language, bullet/numbered/to-do lists (`- [ ]`), nested 2 spaces, links, tables as GFM pipe tables,
  blockquotes, horizontal rules, images as `![](slate-blob:…)`. Plain text goes on the clipboard as
  text/plain.
- The spell-check underline (WP-D) must not add suggestions to this menu.
- UI scenarios: "text context menu" (with and without a selection), every theme at 800 and 1280.
- Tests: `toMarkdown` unit tests for every node and mark; e2e right-click → Copy as Markdown.

## Waves

1. A, B, C1, D, E, F (six at once). 2. C2 when C1 merges. Each branch is reviewed (security review for
main-process changes) and merged into `release/0.5.0`; the maintainer merges that into main with
merge-wp after a full e2e run.

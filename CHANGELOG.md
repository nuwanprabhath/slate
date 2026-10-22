# Changelog

All notable changes to Slate are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

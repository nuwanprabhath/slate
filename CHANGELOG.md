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

[Unreleased]: https://github.com/nuwanprabhath/slate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nuwanprabhath/slate/releases/tag/v0.1.0

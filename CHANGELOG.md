# Changelog

All notable changes to this project will be documented in this file.

## [1.2.1] - 2026-10-25

### Changed
- **Cross-Platform Session Cache**: Switched session persistence from legacy `~/.pi/agent/typst-mcp-session.json` to industry-standard XDG / OS cache directories (`~/.cache/typst-mcp/session.json` on Linux, `~/Library/Caches/typst-mcp/session.json` on macOS, `%LOCALAPPDATA%\typst-mcp\session.json` on Windows) with `TYPST_SESSION_FILE` environment override and legacy fallback migration.
- **Documentation**: Restructured README installation into MCP client configuration with normal and `@latest` options, moving source development to the development section.

## [1.2.0] - 2026-10-25

### Added
- **Typst Web Cloud Diagnostics Fallback**: Zero-binary diagnostics fallback using live Typst Web compiler when local `typst` CLI binary is not present on `PATH`.

## [1.1.0] - 2026-10-25

### Added
- **Global Find & Replace Tool (`typst_find_and_replace`)**: Support replacing text or regular expressions across a single file or project-wide with regex capture groups (`$1`), dry-run preview diffs, and serialized per-file mutation queue safety.
- **Project Search Tool (`typst_grep_project`)**: Fast search across all text files in a project with file paths, line numbers, surrounding context lines, and glob filtering.
- **Read Tool Pagination & Line Numbers (`typst_read_file`)**: Added `offset` (1-indexed start line) and `limit` pagination with actionable continuation notices (`[Showing lines 1-200 of 600. Use offset=201 to continue.]`), and optional `lineNumbers` formatting.
- **Multimodal Image Reading (`typst_read_file`)**: Automatically detect image assets (PNG, JPEG, SVG, WebP, GIF, BMP) and return native MCP `ImageContent` blocks for multimodal LLMs.
- **Resilient Surgical Editing (`typst_edit_file`)**: Added fuzzy matching for smart quotes, Unicode dashes/hyphens, non-breaking spaces, and trailing whitespace per line; CRLF/LF line-ending resilience; and UTF-8 BOM preservation.
- **Unified Diff & Visual Patch Feedback (`typst_edit_file`)**: Edit operations now return display line diffs (`diff`), standard unified patches (`patch`), and `firstChangedLine` for immediate model verification.
- **Per-File Mutation Queue (`withFileMutationQueue`)**: In-memory serialized Promise mutex queue for file operations (`write`, `edit`, `replace`) preventing concurrent write collisions.

## [1.0.0] - 2026-10-17

### Added
- Initial release of Model Context Protocol (MCP) server for https://typst.app/.
- Yjs CRDT real-time document synchronization over WebSocket `/editing/v3` and REST.
- Project and file management (create, list, read, write, edit, upload binary assets, delete, rename).
- Typst compiler diagnostics, high-DPI preview screenshots, and PDF export.

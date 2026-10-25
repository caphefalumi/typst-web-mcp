<div align="center">

# Typst Web MCP

**Model Context Protocol (MCP) server for [`https://typst.app`](https://typst.app) — cloud projects, Yjs CRDT editing, and Typst compiler diagnostics**

[![npm version](https://img.shields.io/npm/v/typst-mcp.svg?style=flat-square)](https://www.npmjs.com/package/typst-mcp)
[![Downloads](https://img.shields.io/npm/dt/typst-mcp.svg?style=flat-square)](https://www.npmjs.com/package/typst-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![Node.js Package](https://github.com/caphefalumi/typst-web-mcp/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/caphefalumi/typst-web-mcp/actions/workflows/npm-publish.yml)

</div>

---

## Installation

Add `typst-mcp` to your MCP client configuration (`.pi/agent/mcp-adapter.json`, `claude_desktop_config.json`, or `.cursor/mcp.json`).

### Prerequisites

- [**Node.js**](https://nodejs.org/) `>= 18`
- [**Typst CLI**](https://github.com/typst/typst) (optional: `typst` on `PATH` for local CLI compilation speed; if not installed, `typst_get_diagnostics` automatically uses Typst Web cloud compiler diagnostics)

### Option 1: Normal (Standard)

Runs the published [`typst-mcp`](https://www.npmjs.com/package/typst-mcp) package (`npx -y typst-mcp`):

```json
{
  "mcpServers": {
    "typst-mcp": {
      "command": "npx",
      "args": ["-y", "typst-mcp"],
      "env": {
        "TYPST_EMAIL": "your-email@example.com",
        "TYPST_PASSWORD": "your-password"
      }
    }
  }
}
```

### Option 2: Always Latest

Bypasses local `npx` cache to automatically pull and run the newest release on launch (`npx -y typst-mcp@latest`):

```json
{
  "mcpServers": {
    "typst-mcp": {
      "command": "npx",
      "args": ["-y", "typst-mcp@latest"],
      "env": {
        "TYPST_EMAIL": "your-email@example.com",
        "TYPST_PASSWORD": "your-password"
      }
    }
  }
}
```

---

## Overview

`typst-web-mcp` connects AI coding and writing agents directly to collaborative [**typst.app**](https://typst.app) cloud projects. Instead of relying on brittle browser DOM scraping, it implements the native `typst.app` client protocol:

- **Native Yjs CRDT Text Sync:** Decodes and mutates multiplayer `Y.Doc` (`doc.getText("text")`) state vectors so surgical edits preserve collaborator cursors and version history.
- **Binary `/editing/v3` WebSocket Wire Protocol:** Encodes and decodes `lib0` variable-length binary frames (`Subscribe`, `TextUpdate`, `Pong`, `Refresh`, `Presence`, `Cursor`, `Leave`) with REST `/v1/files/:projectId/:fileId/yjs` persistence.
- **GraphQL & REST Project Management:** Full project CRUD, file tree inspection, rename/move, delete, and binary figure/asset uploads (`PNG`, `JPG`, `SVG`, `PDF`, fonts).
- **Direct Authentication + Fallback:** Authenticates via `GET /v1/to-signin` + `POST /v1/auth/signin` (`__Http-typst-session`), with persistent session caching and automatic cookie/Playwright fallback on challenge.
- **Compiler Diagnostics, Preview Screenshots & PDF Export:** Synchronizes cloud Yjs text and binary assets into an isolated workspace and runs the Typst compiler to return structured line/column diagnostics, high-DPI PNG preview screenshots (`typst_capture_screenshot`), and compiled PDFs (`typst_export_pdf`).

---

## MCP Tools (18 Tools)

| Category | Tool Name | Description |
|:---|:---|:---|
| **Auth** | `typst_auth_login` | Authenticate with `https://typst.app` via email/password (`POST /v1/auth/signin`) or `__Http-typst-session` cookie, with browser fallback. |
| **Auth** | `typst_auth_status` | Check active authentication state, login method, and stored session cookies. |
| **Projects** | `typst_list_projects` | List all owned and shared/external projects in the user's `typst.app` dashboard (`DashboardContent`). |
| **Projects** | `typst_get_project` | Retrieve full project metadata, access permissions, pinned compiler version, and file tree (`ProjectFiles`). |
| **Projects** | `typst_create_project` | Create a new `typst.app` cloud project with initial `.typ`/`.bib` files and pinned compiler version. |
| **Projects** | `typst_delete_project` | Permanently delete a `typst.app` project by ID (`DeleteProjectMutation`). |
| **Files & CRDT** | `typst_list_files` | List all multiplayer Yjs text files and binary asset blobs in a project. |
| **Files & CRDT** | `typst_read_file` | Read bounded source pages (200 lines/16 KiB by default), with compact metadata, whole-file content hashes, separate continuation fields, and native image blocks. |
| **Files & CRDT** | `typst_write_file` | Create or overwrite a `.typ`/`.bib`/`.toml` file, protected by per-file mutation queue serialization, syncing Yjs state diffs over `/editing/v3` WebSocket and REST. |
| **Files & CRDT** | `typst_edit_file` | Apply validated, unique edits to one snapshot with optional stale-content protection, exact matching by default, compact receipts, opt-in fuzzy fallback, and bounded diff previews. |
| **Search & Replace** | `typst_grep_project` | Search for text or regular expressions across project files, returning file paths, line numbers, and optional surrounding context lines. |
| **Search & Replace** | `typst_find_and_replace` | Replace text or regex in one file or project-wide. Batch ordered replacement rules in one call with one save per changed file, compact summaries, optional diffs, and dry-run previews. |
| **Assets & Tree** | `typst_upload_asset` | Upload or replace binary assets (`PNG`, `JPG`, `SVG`, `PDF`, fonts) from a local path or base64 payload. |
| **Assets & Tree** | `typst_rename_file` | Rename or move a file inside a `typst.app` project (`UpdatesFileMutation`). |
| **Assets & Tree** | `typst_delete_file` | Delete a file or binary asset from a project (`DeleteFilesMutation`). |
| **Compiler** | `typst_get_diagnostics` | Retrieve compiler diagnostics (errors, warnings, line/column numbers, and hints). Supports both local Typst CLI (`mode="cli"`) and Typst Web cloud compiler (`mode="web"`), with automatic fallback (`mode="auto"`). |
| **Compiler** | `typst_export_pdf` | Sync all cloud text & binary assets, compile the project to PDF, and save to `outputPath`. |
| **Preview** | `typst_capture_screenshot` | Capture high-DPI PNG preview screenshots (`mode="pages"` renders compiled PNG pages; `mode="browser"` screenshots the live `typst.app` web UI). |

---

## Read and edit efficiently

1. Use `typst_grep_project` to locate relevant text, then read just that range with `typst_read_file` (`offset` is 1-based, `limit` defaults to 200 lines, `maxBytes` defaults to 16 KiB and can be raised to 1 MiB).
2. Keep the returned `contentHash`. It is SHA-256 of the **entire raw text file**, including BOM and line endings, even when reading a range or displaying line numbers.
3. Send all disjoint edits in one `typst_edit_file` call, with `expectedHash` set to that hash. Prefer a short unique `oldText` anchor over repeating a whole file.

```json
{
  "projectId": "your-project-id",
  "filePath": "main.typ",
  "expectedHash": "<contentHash from the read response>",
  "edits": [
    { "oldText": "September 2025", "newText": "September 2026" }
  ]
}
```

Text read responses include source only in `content`, with `totalLines`, `startLine`, `endLine`, `truncated`, and `nextOffset` when more source remains. They never repeat source in truncation metadata or append instructions to it. Complete lines and original line endings are retained, so unnumbered pages can be concatenated without losing bytes. A trailing newline does not create a phantom extra line. An empty file has `totalLines: 0`, `startLine: 1`, `endLine: 0`.

Read metadata defaults to `{id, name}`. Use `output: "full"` for full file metadata; this does not increase the source range. `lineNumbers: true` adds display prefixes: remove those prefixes when constructing `oldText`. Byte budgets include those prefixes. If one line cannot fit, the tool returns an actionable error rather than an empty page that cannot advance.

Edits match against the same original snapshot, not the result of previous edits. All entries must be valid, and each anchor must be unique, including overlapping occurrences. Invalid batches, overlapping ranges, and stale hashes fail before saving. `matchMode: "exact"` is the default and accepts LF/CRLF differences. Use `matchMode: "fuzzy"` to opt into Unicode quote/dash/space and NFKC fallback when no exact match exists. Fallback matching preserves characters outside the matched span. Edits retain the BOM and untouched line endings, including mixed LF/CRLF files.

Successful edits return a compact receipt with file ID/name, `appliedCount`, the resulting `contentHash`, and `firstChangedLine`. This avoids returning the same changes as both a diff and a patch. Optional controls:

- `output: "diff"` adds a display diff; `output: "full"` also adds a patch and full metadata.
- Each diff/patch field is limited to 100 lines and `maxDiffBytes` bytes (default 8192, maximum 1 MiB). `diffTruncated` / `patchTruncated` explicitly flag omissions; read the affected range for complete source.
- `dryRun: true` validates and previews without saving and defaults to diff output. Its `appliedCount` describes proposed edits; its `contentHash` still identifies the unchanged cloud text.

`expectedHash` is checked on fresh text inside the shared file mutation queue, which serializes local edits, replacements, and whole-file writes to existing files. It detects changes made since the read; it is not a cloud compare-and-swap transaction and cannot prevent a collaborator from editing during the subsequent save. Yjs still merges concurrent cloud updates.

**Changed defaults:** reads previously allowed 2,000 lines/50 KiB and embedded continuation hints in `content`. Read callers should follow `nextOffset` now. MCP edits previously returned full diffs/patches and used fuzzy fallback automatically; request `output: "full"` or `matchMode: "fuzzy"` explicitly when needed. The low-level `editYjsText` helper retains its legacy fuzzy default; the client/MCP edit path defaults to exact matching.

## Batch replacements for agents

Use one `typst_find_and_replace` call for related replacements. For example, expand abbreviated month names throughout all `.typ` files:

```json
{
  "projectId": "your-project-id",
  "glob": "*.typ",
  "replacements": [
    { "pattern": "\\bSep\\b", "replacement": "September", "regex": true },
    { "pattern": "\\bOct\\b", "replacement": "October", "regex": true }
  ]
}
```

Each file is downloaded once, all rules run in order on the previous rule's result, and the file is saved once if its final text changed. All rules are validated before any files are written. File mutations remain serialized with other edits; a project-wide operation is **not atomic across files** if a network or save error occurs.

Batch calls default to `output: "summary"`:

```json
{
  "filesModified": [
    {
      "file": "main.typ",
      "replacementsCount": 3,
      "replacementCounts": [2, 1],
      "firstChangedLine": 4
    }
  ],
  "totalReplacements": 3,
  "dryRun": false
}
```

`replacementCounts` follows the input rule order and counts matches applied by each rule in that changed file. Unchanged files, including batches whose rules cancel each other out, are omitted and do not contribute to totals.

- Set `dryRun: true` to preview without saving. Add `output: "diff"` to include a single combined display diff per file.
- Set `output: "full"` to include both the display diff and unified patch.
- Set `regex`, `ignoreCase`, and `limit` on each batch rule. `limit` is a non-negative integer per rule per file; `0` disables that rule.
- Use either `replacements` or the existing `pattern`/`replacement` fields. Existing single-replacement calls still default to `output: "full"`; they can request `"summary"` too.
- Use `filePath` to target one file by path or ID. A missing explicit file returns an error.

## Development & Verification

### From Source (Development)

Requires [**Bun**](https://bun.sh) `>= 1.2`:

```bash
git clone https://github.com/caphefalumi/typst-web-mcp.git
cd typst-web-mcp
bun install
bun run dev
```

### Build & Test

```bash
# Compile publishable output to dist/
bun run build

# Typecheck with strict TypeScript
bun run typecheck

# Full suite (includes test/smoke.test.ts: dist bin + npx -y typst-mcp)
bun test

# Smoke only (same as pi npx MCP config)
bun run test:smoke
```

Push/PR to `main` runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) (`bun ci`, build, typecheck, `bun test`).

### Publishing to npm

Same flow as [Canvas-CLI](https://github.com/caphefalumi/Canvas-CLI):

1. Bump `version` in `package.json` (must not match a version already on npm).
2. Commit, push, and create a GitHub **Release** for that tag — or run **Actions → Publish → Run workflow** (`workflow_dispatch`).

[`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml) runs the same checks as CI (`bun test`, including smoke) in a `test` job; the `publish` job runs only if that passes, on the `npm-publish` environment: `bun ci`, `bun run build`, then `npm publish --access public` via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). The publish step clears `NODE_AUTH_TOKEN` so the CLI uses GitHub OIDC instead of a stale token from `setup-node`.

**Trusted publisher (maintainers):** package [`typst-mcp`](https://www.npmjs.com/package/typst-mcp) → Settings → Trusted publishing → GitHub Actions — user/org `caphefalumi`, repo `typst-web-mcp`, workflow file `npm-publish.yml`, environment `npm-publish`, allow **npm publish**.

---

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026 Dang Duy Toan (`caphefalumi`).

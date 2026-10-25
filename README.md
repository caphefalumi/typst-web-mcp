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
| **Files & CRDT** | `typst_read_file` | Read any project file with offset/limit pagination, optional line numbering, truncation limits (2,000 lines/50KB), and multimodal MCP image content blocks (`PNG`, `JPG`, `SVG`, `WebP`). |
| **Files & CRDT** | `typst_write_file` | Create or overwrite a `.typ`/`.bib`/`.toml` file, protected by per-file mutation queue serialization, syncing Yjs state diffs over `/editing/v3` WebSocket and REST. |
| **Files & CRDT** | `typst_edit_file` | Apply surgical `oldText -> newText` replacements directly to the `Y.Text("text")` CRDT with CRLF/BOM resilience, fuzzy quote/dash matching, unified diff & patch output, and per-file mutation serialization. |
| **Search & Replace** | `typst_grep_project` | Search for text or regular expressions across project files, returning file paths, line numbers, and optional surrounding context lines. |
| **Search & Replace** | `typst_find_and_replace` | Find and replace text or regex across a single file or project-wide with regex capture groups (`$1`), dry-run preview diffs, and per-file mutation serialization. |
| **Assets & Tree** | `typst_upload_asset` | Upload or replace binary assets (`PNG`, `JPG`, `SVG`, `PDF`, fonts) from a local path or base64 payload. |
| **Assets & Tree** | `typst_rename_file` | Rename or move a file inside a `typst.app` project (`UpdatesFileMutation`). |
| **Assets & Tree** | `typst_delete_file` | Delete a file or binary asset from a project (`DeleteFilesMutation`). |
| **Compiler** | `typst_get_diagnostics` | Retrieve compiler diagnostics (errors, warnings, line/column numbers, and hints). Supports both local Typst CLI (`mode="cli"`) and Typst Web cloud compiler (`mode="web"`), with automatic fallback (`mode="auto"`). |
| **Compiler** | `typst_export_pdf` | Sync all cloud text & binary assets, compile the project to PDF, and save to `outputPath`. |
| **Preview** | `typst_capture_screenshot` | Capture high-DPI PNG preview screenshots (`mode="pages"` renders compiled PNG pages; `mode="browser"` screenshots the live `typst.app` web UI). |

---

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

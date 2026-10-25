import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const TYPST_MCP_TOOLS: Tool[] = [
  {
    name: "typst_auth_login",
    description:
      "Authenticate with https://typst.app using direct email/password API login (POST /v1/auth/signin) or a session cookie (__Http-typst-session), with automatic cookie/browser fallback on challenge.",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Typst account email (falls back to TYPST_EMAIL env var)",
        },
        password: {
          type: "string",
          description:
            "Typst account password (falls back to TYPST_PASSWORD env var)",
        },
        sessionCookie: {
          type: "string",
          description:
            "Optional __Http-typst-session cookie value or full Cookie header string (falls back to TYPST_SESSION_COOKIE)",
        },
        useBrowserFallback: {
          type: "boolean",
          description:
            "Enable automatic fallback if Turnstile/CAPTCHA challenge blocks direct HTTP login (default: true)",
        },
      },
    },
  },
  {
    name: "typst_auth_status",
    description:
      "Check current https://typst.app authentication status, active session cookies, and login method.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "typst_list_projects",
    description:
      "List all owned and shared/external projects in the authenticated user's https://typst.app dashboard.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "typst_get_project",
    description:
      "Get detailed metadata, access permissions, pinned compiler version, and full file tree for a https://typst.app project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_create_project",
    description:
      "Create a new project on https://typst.app with optional initial .typ/.bib files and pinned Typst compiler version.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Project title",
        },
        files: {
          type: "array",
          description: "Optional initial text files (defaults to main.typ)",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
        },
        owner: {
          type: "string",
          description: "Optional owner user/team ID",
        },
        folder: {
          type: "string",
          description: "Optional folder ID",
        },
        pinnedVersion: {
          type: "string",
          description: "Typst compiler version (default: 0.15.1)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "typst_delete_project",
    description: "Permanently delete a project on https://typst.app by ID.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID to delete",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_list_files",
    description:
      "List all files (multiplayer Yjs text files and binary asset blobs) inside a https://typst.app project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_read_file",
    description:
      "Read a file from a https://typst.app project. Supports text files (.typ, .bib, .toml, etc.) with offset/limit pagination, optional line numbering, and automatic truncation safeguards (2,000 lines or 50KB). Binary image assets (PNG, JPEG, SVG, WebP, GIF, BMP) are returned with native multimodal MCP image content blocks.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        filePath: {
          type: "string",
          description: "File path/name (e.g. 'main.typ') or file ID",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
        lineNumbers: {
          type: "boolean",
          description:
            "Whether to prefix each line with its 1-indexed line number (e.g. '1 | ')",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "typst_write_file",
    description:
      "Create or overwrite a text file (.typ, .bib, .toml, etc.) in a https://typst.app project, synchronizing the Yjs CRDT update via WebSocket (/editing/v3) and REST (/v1/files/:projectId/:fileId/yjs).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        filePath: {
          type: "string",
          description: "File path/name (e.g. 'main.typ') or file ID",
        },
        content: {
          type: "string",
          description: "Full UTF-8 text content to write",
        },
        preferWebSocket: {
          type: "boolean",
          description:
            "Also push real-time TextUpdate over /editing/v3 WebSocket before REST persistence (default: true)",
        },
      },
      required: ["projectId", "filePath", "content"],
    },
  },
  {
    name: "typst_edit_file",
    description:
      "Apply one or more surgical text replacements (oldText -> newText) directly to a multiplayer file's Yjs CRDT document in a https://typst.app project. Supports CRLF/LF resilience, UTF-8 BOM preservation, fuzzy matching for Unicode quotes/dashes/whitespace, and returns a unified diff and patch of the changes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        filePath: {
          type: "string",
          description: "File path/name (e.g. 'main.typ') or file ID",
        },
        edits: {
          type: "array",
          description:
            "One or more targeted non-overlapping replacements. Each oldText must be unique in the original file.",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Unique substring to replace (matches exact or normalized quotes/dashes)",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
            },
            required: ["oldText", "newText"],
          },
        },
        oldText: {
          type: "string",
          description:
            "Optional shorthand for a single replacement (used if edits is omitted)",
        },
        newText: {
          type: "string",
          description:
            "Optional replacement text for single replacement shorthand",
        },
        preferWebSocket: {
          type: "boolean",
          description:
            "Push real-time TextUpdate over /editing/v3 WebSocket in addition to REST persistence (default: true)",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "typst_upload_asset",
    description:
      "Upload or replace a binary asset (PNG, JPG, SVG, PDF, font, etc.) in a https://typst.app project from a local file path or base64 data.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        fileName: {
          type: "string",
          description:
            "Destination path inside the Typst project (e.g. 'figures/plot.png')",
        },
        localFilePath: {
          type: "string",
          description: "Local filesystem path to read binary asset bytes from",
        },
        base64Data: {
          type: "string",
          description:
            "Base64-encoded binary payload (used if localFilePath is not provided)",
        },
        convert: {
          type: "boolean",
          description: "Whether typst.app should convert the uploaded file",
        },
      },
      required: ["projectId", "fileName"],
    },
  },
  {
    name: "typst_delete_file",
    description:
      "Delete a file or asset from a https://typst.app project via DeleteFilesMutation.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        filePath: {
          type: "string",
          description: "File path/name or file ID to delete",
        },
      },
      required: ["projectId", "filePath"],
    },
  },
  {
    name: "typst_rename_file",
    description:
      "Rename or move a file inside a https://typst.app project via UpdatesFileMutation.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        filePath: {
          type: "string",
          description: "Existing file path/name or file ID",
        },
        newName: {
          type: "string",
          description: "New destination path/name inside the project",
        },
      },
      required: ["projectId", "filePath", "newName"],
    },
  },
  {
    name: "typst_get_diagnostics",
    description:
      "Retrieve compiler diagnostics (errors, warnings, line/column numbers, and hints) for a https://typst.app project. Supports both local Typst CLI compilation (fastest) and Typst Web cloud diagnostics (zero-binary fallback using typst.app cloud compiler).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        mainFile: {
          type: "string",
          description:
            "Optional main .typ entry file override (defaults to project previewed file or main.typ)",
        },
        mode: {
          type: "string",
          enum: ["auto", "cli", "web"],
          description:
            "Diagnostics mode: 'auto' (prefers local Typst CLI if installed, falls back to Typst Web cloud compiler), 'cli' (requires local typst binary), or 'web' (uses Typst Web cloud compiler). Defaults to 'auto'.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_export_pdf",
    description:
      "Synchronize all text and binary files from a https://typst.app project, compile the document to PDF, and save it to outputPath.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        mainFile: {
          type: "string",
          description: "Optional main .typ entry file override",
        },
        outputPath: {
          type: "string",
          description: "Optional local filesystem path to save the compiled PDF",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_capture_screenshot",
    description:
      "Capture high-resolution PNG preview screenshots to verify the visual status of a https://typst.app project (mode='pages' renders compiled PNG pages via Typst; mode='browser' captures the live typst.app web editor & preview pane via Playwright).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        mainFile: {
          type: "string",
          description: "Optional main .typ entry file override",
        },
        outputDir: {
          type: "string",
          description:
            "Optional directory path to save the rendered PNG screenshot files",
        },
        pages: {
          type: "string",
          description:
            "Page range to capture, e.g. '1', '1-3', '1,4', or 'all' (default: 'all')",
        },
        ppi: {
          type: "number",
          description: "Pixels per inch resolution for rendered PNGs (default: 144)",
        },
        mode: {
          type: "string",
          enum: ["pages", "browser"],
          description:
            "'pages' (default) compiles high-DPI PNG pages from synced project files; 'browser' captures the live https://typst.app/project/:id UI",
        },
        includeBase64: {
          type: "boolean",
          description:
            "Include base64-encoded PNG data in response for direct vision inspection (default: false)",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "typst_grep_project",
    description:
      "Search for text or regular expressions across files in a https://typst.app project. Returns matching lines with file paths, line numbers, and optional surrounding context lines.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        pattern: {
          type: "string",
          description: "Search pattern (regular expression or literal string)",
        },
        path: {
          type: "string",
          description:
            "Optional directory or file path to restrict search (e.g. 'chapters/' or 'main.typ')",
        },
        glob: {
          type: "string",
          description:
            "Optional glob pattern to filter files (e.g. '*.typ' or '*.bib')",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default: false)",
        },
        literal: {
          type: "boolean",
          description:
            "Treat pattern as literal string instead of regex (default: false)",
        },
        context: {
          type: "number",
          description:
            "Number of lines to show before and after each match (default: 0)",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return (default: 100)",
        },
      },
      required: ["projectId", "pattern"],
    },
  },
  {
    name: "typst_find_and_replace",
    description:
      "Find and replace text or regular expressions across a single file or all files in a https://typst.app project. Supports dry-run preview diffs, regex capture groups, and per-file mutation queue serialization.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        pattern: {
          type: "string",
          description: "Search pattern to replace (literal substring or regex)",
        },
        replacement: {
          type: "string",
          description:
            "Replacement text (supports $1, $2 capture groups if regex is true)",
        },
        filePath: {
          type: "string",
          description:
            "Optional file path/name (e.g. 'main.typ'). If omitted, searches and replaces across all text files in the project.",
        },
        glob: {
          type: "string",
          description:
            "Optional glob pattern to filter target files when searching project-wide (e.g. '*.typ')",
        },
        regex: {
          type: "boolean",
          description:
            "Whether pattern is a regular expression (default: false)",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default: false)",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of replacements per file (default: replace all occurrences)",
        },
        dryRun: {
          type: "boolean",
          description:
            "If true, returns unified diffs and match counts without saving changes (default: false)",
        },
        preferWebSocket: {
          type: "boolean",
          description:
            "Push real-time TextUpdate over /editing/v3 WebSocket before REST persistence (default: true)",
        },
      },
      required: ["projectId", "pattern", "replacement"],
    },
  },
];

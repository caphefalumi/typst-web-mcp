#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TypstCloudClient,
  type TypstClientOptions,
} from "./client/typst-client.ts";

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
      "Read a file from a https://typst.app project. Decodes Yjs CRDT state (doc.getText('text')) into UTF-8 text for multiplayer files (.typ, .bib, .toml, etc.) or returns base64 for binary assets.",
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
      "Apply one or more exact surgical text replacements (oldText -> newText) directly to a multiplayer file's Yjs CRDT document in a https://typst.app project.",
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
            "Non-overlapping exact text replacements to apply to the Yjs document",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Exact unique substring to replace",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
            },
            required: ["oldText", "newText"],
          },
        },
        preferWebSocket: {
          type: "boolean",
          description:
            "Push real-time TextUpdate over /editing/v3 WebSocket in addition to REST persistence (default: true)",
        },
      },
      required: ["projectId", "filePath", "edits"],
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
      "Synchronize all files from a https://typst.app project and run the Typst compiler to retrieve structured errors, warnings, line/column numbers, and hints.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The Typst project ID",
        },
        mainFile: {
          type: "string",
          description: "Optional main .typ entry file override (defaults to project previewed file or main.typ)",
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
];

export async function dispatchTypstTool(
  client: TypstCloudClient,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  switch (name) {
    case "typst_auth_login":
      return await client.auth.login({
        email: args.email as string | undefined,
        password: args.password as string | undefined,
        sessionCookie: args.sessionCookie as string | undefined,
        useBrowserFallback: args.useBrowserFallback as boolean | undefined,
      });

    case "typst_auth_status":
      return client.auth.getStatus();

    case "typst_list_projects":
      return await client.listProjects();

    case "typst_get_project":
      return await client.getProject(String(args.projectId));

    case "typst_create_project":
      return await client.createProject({
        name: String(args.name),
        files: args.files as { name: string; content: string }[] | undefined,
        owner: args.owner as string | undefined,
        folder: args.folder as string | undefined,
        pinnedVersion: args.pinnedVersion as string | undefined,
      });

    case "typst_delete_project": {
      const deleted = await client.deleteProject(String(args.projectId));
      return { projectId: String(args.projectId), deleted };
    }

    case "typst_list_files":
      return await client.listFiles(String(args.projectId));

    case "typst_read_file":
      return await client.readFile(
        String(args.projectId),
        String(args.filePath)
      );

    case "typst_write_file":
      return await client.writeFile(
        String(args.projectId),
        String(args.filePath),
        String(args.content),
        {
          preferWebSocket:
            typeof args.preferWebSocket === "boolean"
              ? args.preferWebSocket
              : true,
        }
      );

    case "typst_edit_file":
      return await client.editFile(
        String(args.projectId),
        String(args.filePath),
        (args.edits as { oldText: string; newText: string }[]) ?? [],
        {
          preferWebSocket:
            typeof args.preferWebSocket === "boolean"
              ? args.preferWebSocket
              : true,
        }
      );

    case "typst_upload_asset": {
      let bytes: Uint8Array;
      if (typeof args.localFilePath === "string" && args.localFilePath) {
        bytes = new Uint8Array(readFileSync(resolve(args.localFilePath)));
      } else if (typeof args.base64Data === "string" && args.base64Data) {
        bytes = new Uint8Array(Buffer.from(args.base64Data, "base64"));
      } else {
        throw new Error(
          "typst_upload_asset requires either localFilePath or base64Data"
        );
      }
      return await client.uploadAsset(
        String(args.projectId),
        String(args.fileName),
        bytes,
        { convert: Boolean(args.convert) }
      );
    }

    case "typst_delete_file":
      return await client.deleteFile(
        String(args.projectId),
        String(args.filePath)
      );

    case "typst_rename_file":
      return await client.renameFile(
        String(args.projectId),
        String(args.filePath),
        String(args.newName)
      );

    case "typst_get_diagnostics":
      return await client.getDiagnostics(
        String(args.projectId),
        args.mainFile as string | undefined
      );

    case "typst_export_pdf":
      return await client.exportPdf(String(args.projectId), {
        mainFile: args.mainFile as string | undefined,
        outputPath: args.outputPath as string | undefined,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createTypstMcpServer(options: TypstClientOptions = {}): {
  server: Server;
  client: TypstCloudClient;
} {
  const client = new TypstCloudClient(options);
  const server = new Server(
    {
      name: "typst-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TYPST_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatchTypstTool(
        client,
        name,
        (args as Record<string, unknown>) ?? {}
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: errorMessage }, null, 2),
          },
        ],
      };
    }
  });

  return { server, client };
}

if (import.meta.main) {
  const { server } = createTypstMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

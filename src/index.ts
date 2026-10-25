#!/usr/bin/env node
import "./node-shim.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TypstCloudClient,
  type TypstClientOptions,
} from "./client/typst-client.js";
import { formatUnknownError } from "./client/errors.js";
import { TYPST_MCP_TOOLS } from "./tools/definitions.js";

export { TYPST_MCP_TOOLS };

function resolvePreferWebSocket(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return true;
}

function resolveOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

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
        String(args.filePath),
        {
          offset: resolveOptionalNumber(args.offset),
          limit: resolveOptionalNumber(args.limit),
          lineNumbers:
            typeof args.lineNumbers === "boolean"
              ? args.lineNumbers
              : undefined,
        }
      );

    case "typst_write_file":
      return await client.writeFile(
        String(args.projectId),
        String(args.filePath),
        String(args.content),
        {
          preferWebSocket: resolvePreferWebSocket(args.preferWebSocket),
        }
      );

    case "typst_edit_file":
      return await client.editFile(
        String(args.projectId),
        String(args.filePath),
        (args.edits as { oldText: string; newText: string }[]) ?? [],
        {
          preferWebSocket: resolvePreferWebSocket(args.preferWebSocket),
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

    case "typst_capture_screenshot":
      return await client.capturePreviewScreenshot(String(args.projectId), {
        mainFile: args.mainFile as string | undefined,
        outputDir: args.outputDir as string | undefined,
        pages: args.pages as string | undefined,
        ppi: resolveOptionalNumber(args.ppi),
        mode: (args.mode as "pages" | "browser" | undefined) ?? "pages",
        includeBase64: Boolean(args.includeBase64),
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
      if (
        name === "typst_read_file" &&
        typeof result === "object" &&
        result !== null &&
        Boolean((result as Record<string, unknown>).isImage) &&
        typeof (result as Record<string, unknown>).mimeType === "string" &&
        typeof (result as Record<string, unknown>).content === "string"
      ) {
        const img = result as {
          file?: unknown;
          encoding?: string;
          mimeType: string;
          content: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  file: img.file,
                  encoding: img.encoding,
                  mimeType: img.mimeType,
                  isImage: true,
                },
                null,
                2
              ),
            },
            {
              type: "image" as const,
              data: img.content,
              mimeType: img.mimeType,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = formatUnknownError(err);
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

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
import type { ReplaceContentOptions, ReplacementOutput } from "./protocol/search-replace.js";
import { validateEdits } from "./protocol/edit-diff.js";
import { truncateHead } from "./utils/truncate.js";

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

export function prepareEditArguments(
  input: unknown
): Array<{ oldText: string; newText: string }> {
  if (input === undefined) return [];
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("edits must be an array of {oldText, newText}; invalid JSON.");
    }
  }
  const edits = (Array.isArray(input) ? input : [input]) as Array<{ oldText: string; newText: string }>;
  validateEdits(edits);
  return edits.map(({ oldText, newText }) => ({ oldText, newText }));
}

function requiredText(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key].length) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return args[key];
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

    case "typst_read_file": {
      if (args.output !== undefined && args.output !== "compact" && args.output !== "full") {
        throw new Error("output must be compact or full.");
      }
      const result = await client.readFile(
        requiredText(args, "projectId"),
        requiredText(args, "filePath"),
        {
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
          maxBytes: args.maxBytes as number | undefined,
          lineNumbers: args.lineNumbers as boolean | undefined,
        }
      );
      return args.output === "full" ? result : {
        ...result, file: { id: result.file.id, name: result.file.name },
      };
    }

    case "typst_write_file":
      return await client.writeFile(
        String(args.projectId),
        String(args.filePath),
        String(args.content),
        {
          preferWebSocket: resolvePreferWebSocket(args.preferWebSocket),
        }
      );

    case "typst_edit_file": {
      const hasShorthand = args.oldText !== undefined || args.newText !== undefined;
      if (args.edits !== undefined && hasShorthand) {
        throw new Error("Use either edits or oldText/newText, not both.");
      }
      const edits = prepareEditArguments(args.edits !== undefined ? args.edits :
        hasShorthand ? { oldText: args.oldText, newText: args.newText } : undefined);
      const output = args.output ?? (args.dryRun === true ? "diff" : "summary");
      if (!["summary", "diff", "full"].includes(output as string)) {
        throw new Error("output must be summary, diff, or full.");
      }
      const maxDiffBytes = args.maxDiffBytes ?? 8192;
      if (typeof maxDiffBytes !== "number" || !Number.isSafeInteger(maxDiffBytes) ||
          maxDiffBytes < 1 || maxDiffBytes > 1048576) {
        throw new Error("maxDiffBytes must be an integer between 1 and 1048576.");
      }
      if (args.preferWebSocket !== undefined && typeof args.preferWebSocket !== "boolean") {
        throw new Error("preferWebSocket must be a boolean.");
      }
      const result = await client.editFile(
        requiredText(args, "projectId"),
        requiredText(args, "filePath"),
        edits,
        {
          preferWebSocket: resolvePreferWebSocket(args.preferWebSocket),
          expectedHash: args.expectedHash as string | undefined,
          matchMode: args.matchMode as "exact" | "fuzzy" | undefined,
          dryRun: args.dryRun as boolean | undefined,
        }
      );
      const compact = {
        file: { id: result.file.id, name: result.file.name },
        appliedCount: result.appliedCount,
        contentHash: result.contentHash,
        firstChangedLine: result.firstChangedLine,
        ...(result.dryRun ? { dryRun: true } : {}),
        ...(result.usedFuzzyMatch ? { usedFuzzyMatch: true } : {}),
      };
      if (output === "summary") return compact;
      const diff = truncateHead(result.diff, { maxLines: 100, maxBytes: maxDiffBytes });
      const diffFields = {
        diff: diff.content,
        ...(diff.truncated ? { diffTruncated: true, hint: "Read the affected range to inspect all changes, or increase maxDiffBytes (100 diff lines maximum)." } : {}),
      };
      if (output === "diff") return { ...compact, ...diffFields };
      const patch = truncateHead(result.patch, { maxLines: 100, maxBytes: maxDiffBytes });
      return {
        ...result, ...diffFields, patch: patch.content,
        ...(patch.truncated ? { patchTruncated: true } : {}),
      };
    }

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
      return await client.getDiagnostics(String(args.projectId), {
        mainFile: args.mainFile as string | undefined,
        mode: args.mode as "auto" | "cli" | "web" | undefined,
      });

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

    case "typst_grep_project":
      return await client.grepProject(String(args.projectId), {
        pattern: String(args.pattern),
        path: args.path as string | undefined,
        glob: args.glob as string | undefined,
        literal: Boolean(args.literal),
        ignoreCase: Boolean(args.ignoreCase),
        context: resolveOptionalNumber(args.context),
        limit: resolveOptionalNumber(args.limit),
      });

    case "typst_find_and_replace":
      return await client.findAndReplace(String(args.projectId), {
        pattern: args.pattern as string | undefined,
        replacement: args.replacement as string | undefined,
        replacements: args.replacements as ReplaceContentOptions[] | undefined,
        output: args.output as ReplacementOutput | undefined,
        filePath: args.filePath as string | undefined,
        glob: args.glob as string | undefined,
        regex: args.regex as boolean | undefined,
        ignoreCase: args.ignoreCase as boolean | undefined,
        limit: args.limit as number | undefined,
        dryRun: Boolean(args.dryRun),
        preferWebSocket: resolvePreferWebSocket(args.preferWebSocket),
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
      version: "1.3.0",
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
            text: JSON.stringify(result, null, name === "typst_read_file" || name === "typst_edit_file" ? undefined : 2),
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

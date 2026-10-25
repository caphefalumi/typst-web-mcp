import { describe, expect, it } from "bun:test";
import { TypstCloudClient } from "../src/client/typst-client.js";
import { createInitialYjsUpdate } from "../src/protocol/yjs-doc.js";
import { createTypstMcpServer, dispatchTypstTool } from "../src/index.js";
import { hashText, readTextContent } from "../src/protocol/read-content.js";
import { detectSupportedImageMimeType } from "../src/utils/mime.js";

function createMockClientWithFiles(
  files: Array<{
    id: string;
    name: string;
    isMultiplayable: boolean;
    content: Uint8Array | string;
  }>
) {
  const fileMap = new Map(files.map((f) => [f.name, f]));
  const idMap = new Map(files.map((f) => [f.id, f]));

  return new TypstCloudClient({
    apiUrl: "https://mock.typst.test",
    fetchImpl: (async (url: any, init: any) => {
      const urlStr = url.toString();

      // GraphQL project files
      if (urlStr.includes("/v1/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.query?.includes("query ProjectFiles")) {
          return Response.json({
            data: {
              project: {
                id: "proj-1",
                name: "Test Project",
                previewed: "main.typ",
                pinnedVersion: "0.15.1",
                files: files.map((f) => ({
                  id: f.id,
                  name: f.name,
                  isMultiplayable: f.isMultiplayable,
                  lastChange: { date: Date.now() },
                  size: 100,
                  version: 1,
                  etag: `"v1"`,
                })),
              },
            },
          });
        }
      }

      // Download Yjs text
      if (urlStr.includes("/yjs")) {
        const match = urlStr.match(/\/files\/proj-1\/([^/]+)\/yjs/);
        const f = idMap.get(match?.[1] ?? "");
        if (f) {
          const bytes =
            typeof f.content === "string"
              ? createInitialYjsUpdate(f.content)
              : f.content;
          return new Response(bytes as unknown as BodyInit, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
      }

      // Download binary blob
      const matchBlob = urlStr.match(/\/files\/proj-1\/([^/]+)$/);
      if (matchBlob) {
        const f = idMap.get(matchBlob[1] ?? "");
        if (f) {
          const bytes =
            typeof f.content === "string"
              ? new TextEncoder().encode(f.content)
              : f.content;
          return new Response(bytes as unknown as BodyInit, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch,
  });
}

describe("Phase 2 Read Tool: Pagination, Line Numbers & Images", () => {
  it("paginates with no phantom lines or missing source bytes", () => {
    for (const text of ["", "\n", "a\n", "a\r\nb\n\nlast", "日本語\n🙂\nlast\n"]) {
      let offset = 1;
      let restored = "";
      do {
        const result = readTextContent(text, { offset, limit: 1 });
        restored += result.content;
        expect(result.contentHash).toBe(hashText(text));
        if (!result.nextOffset) break;
        expect(result.nextOffset).toBeGreaterThan(offset);
        offset = result.nextOffset;
      } while (true);
      expect(restored).toBe(text);
    }
    expect(readTextContent("a\n").totalLines).toBe(1);
    expect(readTextContent("").endLine).toBe(0);
  });

  it("bounds reads by default and counts rendered UTF-8 bytes", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line${i}\n`).join("");
    const result = readTextContent(text);
    expect(result.endLine).toBe(200);
    expect(result.nextOffset).toBe(201);
    const bytes = readTextContent("日本語\n🙂\nlast", { maxBytes: 14 });
    expect(bytes.content).toBe("日本語\n");
    expect(bytes.nextOffset).toBe(2);
    expect(bytes.truncatedBy).toBe("bytes");
    const numbered = readTextContent("a\nb\n", { maxBytes: 6, lineNumbers: true });
    expect(Buffer.byteLength(numbered.content)).toBeLessThanOrEqual(6);
    expect(numbered.nextOffset).toBe(2);
    expect(() => readTextContent("long line", { maxBytes: 3 })).toThrow("Increase maxBytes");
  });

  it("rejects invalid pagination and budgets instead of silently coercing them", async () => {
    const client = createMockClientWithFiles([
      { id: "file-1", name: "main.typ", isMultiplayable: true, content: "a" },
    ]);
    for (const options of [
      { offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: -1 }, { limit: "2" },
      { maxBytes: 0 }, { maxBytes: 1048577 }, { lineNumbers: "false" },
    ]) await expect(dispatchTypstTool(client, "typst_read_file", { projectId: "proj-1", filePath: "main.typ", ...options })).rejects.toThrow();
  });

  it("uses compact metadata by default and retains a full metadata option", async () => {
    const client = createMockClientWithFiles([
      { id: "file-1", name: "main.typ", isMultiplayable: true, content: "Hello\n" },
    ]);
    const args = { projectId: "proj-1", filePath: "main.typ" };
    const compact = await dispatchTypstTool(client, "typst_read_file", args) as any;
    const full = await dispatchTypstTool(client, "typst_read_file", { ...args, output: "full" }) as any;
    expect(compact.file).toEqual({ id: "file-1", name: "main.typ" });
    expect(full.file.version).toBe(1);
    expect(compact.content).toBe(full.content);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("detects supported image MIME types correctly", () => {
    expect(detectSupportedImageMimeType("diagram.png")).toBe("image/png");
    expect(detectSupportedImageMimeType("photo.JPG")).toBe("image/jpeg");
    expect(detectSupportedImageMimeType("vector.svg")).toBe("image/svg+xml");
    expect(detectSupportedImageMimeType("banner.webp")).toBe("image/webp");
    expect(detectSupportedImageMimeType("main.typ")).toBeUndefined();
  });

  it("reads with offset and limit and keeps continuation metadata out of source", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const fullText = lines.join("\n");
    const client = createMockClientWithFiles([
      { id: "file-1", name: "large.typ", isMultiplayable: true, content: fullText },
    ]);

    const res = await client.readFile("proj-1", "large.typ", {
      offset: 11,
      limit: 10,
    });

    expect(res.encoding).toBe("utf-8");
    expect(res.startLine).toBe(11);
    expect(res.endLine).toBe(20);
    expect(res.totalLines).toBe(50);
    expect(res.content).toContain("Line 11");
    expect(res.content).toContain("Line 20");
    expect(res.content).not.toContain("Line 21");
    expect(res.nextOffset).toBe(21);
    expect(res.truncated).toBe(true);
    expect(res.contentHash).toBe(hashText(fullText));
    expect(res.content).toBe(lines.slice(10, 20).join("\n") + "\n");
    expect(res).not.toHaveProperty("truncation");
  });

  it("supports line numbers formatting", async () => {
    const text = "= Title\n#let x = 1\n#x + 2\n";
    const client = createMockClientWithFiles([
      { id: "file-1", name: "main.typ", isMultiplayable: true, content: text },
    ]);

    const res = await client.readFile("proj-1", "main.typ", {
      lineNumbers: true,
    });

    expect(res.content).toContain("1 | = Title");
    expect(res.content).toContain("2 | #let x = 1");
    expect(res.content).toContain("3 | #x + 2");
  });

  it("throws clear error when offset is beyond end of file", async () => {
    const text = "Single line";
    const client = createMockClientWithFiles([
      { id: "file-1", name: "main.typ", isMultiplayable: true, content: text },
    ]);

    expect(
      client.readFile("proj-1", "main.typ", { offset: 100 })
    ).rejects.toThrow("Offset 100 is beyond end of file (1 lines total)");
  });

  it("returns MCP ImageContent block when reading image assets", async () => {
    const rawPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const mockClient = createMockClientWithFiles([
      { id: "img-1", name: "figure.png", isMultiplayable: false, content: rawPngBytes },
    ]);

    const response = await dispatchTypstTool(mockClient, "typst_read_file", {
      projectId: "proj-1", filePath: "figure.png",
    }) as any;
    expect(response.isImage).toBe(true);
    expect(response.mimeType).toBe("image/png");
    expect(response.content).toBe(Buffer.from(rawPngBytes).toString("base64"));
  });

  it("formats image MCP response properly in server handler", async () => {
    const rawPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const { server } = createTypstMcpServer({
      apiUrl: "https://mock.typst.test",
      fetchImpl: (async (url: any, init: any) => {
        const urlStr = url.toString();
        if (urlStr.includes("/v1/graphql")) {
          return Response.json({
            data: {
              project: {
                id: "proj-1",
                name: "Test Project",
                previewed: "main.typ",
                pinnedVersion: "0.15.1",
                files: [
                  {
                    id: "img-1",
                    name: "figure.png",
                    isMultiplayable: false,
                    lastChange: { date: Date.now() },
                    size: 6,
                    version: 1,
                    etag: `"v1"`,
                  },
                ],
              },
            },
          });
        }
        if (urlStr.includes("/files/proj-1/img-1")) {
          return new Response(rawPngBytes as unknown as BodyInit, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch,
    });

    const handler = (server as any)._requestHandlers.get("tools/call");
    const response = await handler({
      method: "tools/call",
      params: {
        name: "typst_read_file",
        arguments: { projectId: "proj-1", filePath: "figure.png" },
      },
    });

    expect(response.content.length).toBe(2);
    expect(response.content[0].type).toBe("text");
    expect(response.content[1].type).toBe("image");
    expect(response.content[1].mimeType).toBe("image/png");
    expect(response.content[1].data).toBe(
      Buffer.from(rawPngBytes).toString("base64")
    );
  });
});

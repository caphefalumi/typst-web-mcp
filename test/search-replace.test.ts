import { describe, expect, it } from "bun:test";
import { TypstCloudClient } from "../src/client/typst-client.js";
import {
  createInitialYjsUpdate,
  decodeYjsText,
} from "../src/protocol/yjs-doc.js";
import {
  matchGlob,
  searchInContent,
  replaceInContent,
} from "../src/protocol/search-replace.js";
import { dispatchTypstTool } from "../src/index.js";

import * as Y from "yjs";

function createMockProjectClient(
  files: Array<{
    id: string;
    name: string;
    isMultiplayable: boolean;
    content: string;
  }>
) {
  const fileYjsMap = new Map(
    files.map((f) => [f.id, createInitialYjsUpdate(f.content)])
  );
  const idMap = new Map(files.map((f) => [f.id, f]));
  const nameMap = new Map(files.map((f) => [f.name, f]));

  return new TypstCloudClient({
    apiUrl: "https://mock.typst.test",
    fetchImpl: (async (url: any, init: any) => {
      const urlStr = url.toString();

      if (urlStr.includes("/v1/graphql")) {
        return Response.json({
          data: {
            project: {
              id: "proj-search",
              name: "Search Test Project",
              previewed: "main.typ",
              pinnedVersion: "0.15.1",
              files: files.map((f) => ({
                id: f.id,
                name: f.name,
                isMultiplayable: f.isMultiplayable,
                lastChange: { date: Date.now() },
                size: (fileYjsMap.get(f.id) ?? new Uint8Array()).byteLength,
                version: 1,
                etag: `"v1"`,
              })),
            },
          },
        });
      }

      // Download Yjs text
      if (urlStr.includes("/yjs") && (!init?.method || init.method === "GET")) {
        const match = urlStr.match(/\/files\/proj-search\/([^/]+)\/yjs/);
        const fileId = match?.[1] ?? "";
        const yjsBytes = fileYjsMap.get(fileId) ?? new Uint8Array();
        return new Response(yjsBytes as unknown as BodyInit, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      // Save Yjs text (PUT)
      if (urlStr.includes("/yjs") && init?.method === "PUT") {
        const match = urlStr.match(/\/files\/proj-search\/([^/]+)\/yjs/);
        const fileId = match?.[1] ?? "";
        const incoming =
          init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(init.body);
        const currentYjs = fileYjsMap.get(fileId);
        const doc = new Y.Doc();
        if (currentYjs && currentYjs.byteLength > 0) {
          Y.applyUpdate(doc, currentYjs);
        }
        Y.applyUpdate(doc, incoming);
        fileYjsMap.set(fileId, Y.encodeStateAsUpdate(doc));
        doc.destroy();
        return Response.json({ success: true });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch,
  });
}

describe("Search & Global Replace Utilities (search-replace.ts)", () => {
  it("matches glob patterns correctly", () => {
    expect(matchGlob("main.typ", "*.typ")).toBe(true);
    expect(matchGlob("chapters/intro.typ", "*.typ")).toBe(true);
    expect(matchGlob("chapters/intro.typ", "chapters/*.typ")).toBe(true);
    expect(matchGlob("refs.bib", "*.typ")).toBe(false);
    expect(matchGlob("refs.bib", "*.bib")).toBe(true);
  });

  it("searches content with line numbers and context lines", () => {
    const content = [
      "= Header",
      "Line 1",
      "#let target_var = 10",
      "Line 3",
      "#let other_var = 20",
      "#let target_var = 30",
      "Line 6",
    ].join("\n");

    const result = searchInContent("main.typ", content, {
      pattern: "target_var",
      context: 1,
    });

    expect(result.totalMatches).toBe(2);
    expect(result.matches.length).toBe(2);

    expect(result.matches[0]!.line).toBe(3);
    expect(result.matches[0]!.text).toBe("#let target_var = 10");
    expect(result.matches[0]!.contextBefore).toEqual(["Line 1"]);
    expect(result.matches[0]!.contextAfter).toEqual(["Line 3"]);

    expect(result.matches[1]!.line).toBe(6);
    expect(result.matches[1]!.text).toBe("#let target_var = 30");
  });

  it("replaces all occurrences and generates diff and patch", () => {
    const content = "foo and foo and foo";
    const result = replaceInContent("test.typ", content, {
      pattern: "foo",
      replacement: "bar",
    });

    expect(result.replacementCount).toBe(3);
    expect(result.updatedText).toBe("bar and bar and bar");
    expect(result.diff).toContain("foo and foo and foo");
    expect(result.diff).toContain("bar and bar and bar");
    expect(result.patch).toContain("--- test.typ");
  });

  it("supports regex replacement with capture groups", () => {
    const content = "#cite(\"ref1\") and #cite(\"ref2\")";
    const result = replaceInContent("main.typ", content, {
      pattern: '#cite\\("([^"]+)"\\)',
      replacement: "@$1",
      regex: true,
    });

    expect(result.replacementCount).toBe(2);
    expect(result.updatedText).toBe("@ref1 and @ref2");
  });
});

describe("typst_grep_project Tool", () => {
  it("searches across all project files", async () => {
    const client = createMockProjectClient([
      {
        id: "f-1",
        name: "main.typ",
        isMultiplayable: true,
        content: "= Title\n#import \"utils.typ\"\nTarget keyword in main\n",
      },
      {
        id: "f-2",
        name: "utils.typ",
        isMultiplayable: true,
        content: "#let util = true\nTarget keyword in utils\n",
      },
      {
        id: "f-3",
        name: "refs.bib",
        isMultiplayable: true,
        content: "@article{key,\n  title={No match}\n}\n",
      },
    ]);

    const res = (await dispatchTypstTool(client, "typst_grep_project", {
      projectId: "proj-search",
      pattern: "Target keyword",
    })) as any;

    expect(res.totalMatches).toBe(2);
    expect(res.filesSearched).toBe(3);
    expect(res.matches.length).toBe(2);
    expect(res.matches[0].file).toBe("main.typ");
    expect(res.matches[0].line).toBe(3);
    expect(res.matches[1].file).toBe("utils.typ");
    expect(res.matches[1].line).toBe(2);
  });

  it("filters search by glob", async () => {
    const client = createMockProjectClient([
      {
        id: "f-1",
        name: "main.typ",
        isMultiplayable: true,
        content: "keyword in typ\n",
      },
      {
        id: "f-2",
        name: "refs.bib",
        isMultiplayable: true,
        content: "keyword in bib\n",
      },
    ]);

    const res = (await dispatchTypstTool(client, "typst_grep_project", {
      projectId: "proj-search",
      pattern: "keyword",
      glob: "*.bib",
    })) as any;

    expect(res.totalMatches).toBe(1);
    expect(res.matches.length).toBe(1);
    expect(res.matches[0].file).toBe("refs.bib");
  });
});

describe("typst_find_and_replace Tool", () => {
  it("performs dryRun find and replace returning diff without persisting", async () => {
    const client = createMockProjectClient([
      {
        id: "f-1",
        name: "main.typ",
        isMultiplayable: true,
        content: "#let old_author = \"Alice\"\n",
      },
    ]);

    const res = (await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search",
      filePath: "main.typ",
      pattern: "old_author",
      replacement: "new_author",
      dryRun: true,
    })) as any;

    expect(res.dryRun).toBe(true);
    expect(res.totalReplacements).toBe(1);
    expect(res.filesModified.length).toBe(1);
    expect(res.filesModified[0].file).toBe("main.typ");
    expect(res.filesModified[0].diff).toContain("+");
    expect(res.filesModified[0].diff).toContain("new_author");

    // Reading the file must still show original text because dryRun = true
    const read = await client.readFile("proj-search", "main.typ");
    expect(read.content).toContain("old_author");
  });

  it("persists global replacement across multiple files", async () => {
    const client = createMockProjectClient([
      {
        id: "f-1",
        name: "chapter1.typ",
        isMultiplayable: true,
        content: "Draft Version 1.0\nText in chap1\n",
      },
      {
        id: "f-2",
        name: "chapter2.typ",
        isMultiplayable: true,
        content: "Draft Version 1.0\nText in chap2\n",
      },
    ]);

    const res = (await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search",
      pattern: "Draft Version 1.0",
      replacement: "Release Version 2.0",
      dryRun: false,
    })) as any;

    expect(res.dryRun).toBe(false);
    expect(res.totalReplacements).toBe(2);
    expect(res.filesModified.length).toBe(2);

    const read1 = await client.readFile("proj-search", "chapter1.typ");
    expect(read1.content).toContain("Release Version 2.0");

    const read2 = await client.readFile("proj-search", "chapter2.typ");
    expect(read2.content).toContain("Release Version 2.0");
  });
});

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
  }>,
  requests = { downloads: 0, saves: 0 }
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
        requests.downloads++;
        const match = urlStr.match(/\/files\/proj-search\/([^/]+)\/yjs/);
        const fileId = match?.[1] ?? "";
        const yjsBytes = fileYjsMap.get(fileId) ?? new Uint8Array();
        return new Response(yjsBytes as unknown as BodyInit, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      // Save Yjs text (PUT)
      if (urlStr.includes("/yjs") && init?.method === "PUT") {
        requests.saves++;
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

  it("matches native replacement semantics without confusing metadata with captures", () => {
    for (const [content, pattern, replacement] of [
      ["abc", "b", "$1 $2 $0 $99"],
      ["abc", "(b)", "$1 $2 $10 $01 $00"],
      ["abc", "(b)(z)?", "$1-$2-$3-$20"],
      ["abc", "(?<letter>b)", "$<letter>-$<missing>-$1-$2"],
      ["abc", "b", "$<letter> $$ $& $` $'"],
      ["b b", "(b)", "$`-$&-$'"],
    ]) {
      expect(replaceInContent("main.typ", content!, { pattern: pattern!, replacement: replacement!, regex: true }).updatedText)
        .toBe(content!.replace(new RegExp(pattern!, "g"), replacement!));
    }
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
  it("expands multiple months with one download/save per changed text file and compact output", async () => {
    const requests = { downloads: 0, saves: 0 };
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "Sep 2025 — Oct 2025\nSep 2026" },
      { id: "f-2", name: "chapter.typ", isMultiplayable: true, content: "Oct 2026" },
      { id: "f-3", name: "figure.png", isMultiplayable: false, content: "Sep" },
    ], requests);
    const res = await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search",
      replacements: [
        { pattern: "\\bSep\\b", replacement: "September", regex: true },
        { pattern: "\\bOct\\b", replacement: "October", regex: true },
      ],
      preferWebSocket: false,
    }) as any;
    expect(requests).toEqual({ downloads: 2, saves: 2 });
    expect(res.totalReplacements).toBe(4);
    expect(res.filesModified[0]).toEqual({ file: "main.typ", replacementsCount: 3, replacementCounts: [2, 1], firstChangedLine: 1 });
    expect(res.filesModified[1].replacementCounts).toEqual([0, 1]);
    expect((await client.readFile("proj-search", "main.typ")).content)
      .toBe("September 2025 — October 2025\nSeptember 2026");
  });

  it("previews sequential rules with per-rule options without saving", async () => {
    const requests = { downloads: 0, saves: 0 };
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "sep SEP Sep\r\n" },
    ], requests);
    const res = await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search", filePath: "main.typ", dryRun: true, output: "diff",
      replacements: [
        { pattern: "sep", replacement: "September", ignoreCase: true, limit: 2 },
        { pattern: "(September)", replacement: "$1!", regex: true },
      ],
    }) as any;
    expect(requests).toEqual({ downloads: 1, saves: 0 });
    expect(res.filesModified[0].replacementCounts).toEqual([2, 2]);
    expect(res.filesModified[0].diff).toContain("September! September! Sep");
    expect(res.filesModified[0]).not.toHaveProperty("patch");
    expect((await client.readFile("proj-search", "main.typ")).content).toBe("sep SEP Sep\r\n");
  });

  it("rejects invalid requests before downloading or saving any files", async () => {
    const requests = { downloads: 0, saves: 0 };
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "Sep" },
    ], requests);
    for (const args of [
      {}, { replacements: [] },
      { pattern: "Sep", replacement: "September", replacements: [{ pattern: "Sep", replacement: "September" }] },
      { replacements: [{ pattern: "Sep", replacement: "September" }, { pattern: "[", replacement: "", regex: true }] },
      { pattern: "", replacement: "" },
      { pattern: "Sep", replacement: "September", limit: -1 },
      { pattern: "Sep", replacement: "September", output: "unknown" },
      { replacements: [{ pattern: "Sep", replacement: "September" }], ignoreCase: true },
      { replacements: [{ pattern: "Sep", replacement: "September", regex: "false" }] },
    ]) {
      await expect(dispatchTypstTool(client, "typst_find_and_replace", { projectId: "proj-search", ...args })).rejects.toThrow();
    }
    expect(requests).toEqual({ downloads: 0, saves: 0 });
  });

  it("skips no-op writes and reports a missing explicit file", async () => {
    const requests = { downloads: 0, saves: 0 };
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "Sep" },
    ], requests);
    for (const replacements of [
      [{ pattern: "Sep", replacement: "Sep" }],
      [{ pattern: "Sep", replacement: "September" }, { pattern: "September", replacement: "Sep" }],
      [{ pattern: "Oct", replacement: "October" }],
    ]) {
      const res = await dispatchTypstTool(client, "typst_find_and_replace", { projectId: "proj-search", replacements }) as any;
      expect(res.filesModified).toEqual([]);
      expect(res.totalReplacements).toBe(0);
    }
    expect(requests.saves).toBe(0);
    await expect(dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search", filePath: "missing.typ", pattern: "Sep", replacement: "September",
    })).rejects.toThrow("Text file not found");
  });

  it("allows concurrent batches without losing earlier changes", async () => {
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "Sep Oct" },
    ]);
    await Promise.all([ ["Sep", "September"], ["Oct", "October"] ].map(([pattern, replacement]) =>
      dispatchTypstTool(client, "typst_find_and_replace", {
        projectId: "proj-search", replacements: [{ pattern, replacement }], preferWebSocket: false,
      })
    ));
    expect((await client.readFile("proj-search", "main.typ")).content).toBe("September October");
  });

  it("supports full batch output, file IDs, literal dollar text, and zero limits", async () => {
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "\uFEFFSep Oct\r\n" },
      { id: "f-2", name: "refs.bib", isMultiplayable: true, content: "Sep Oct" },
    ]);
    const res = await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search", filePath: "f-1", output: "full", preferWebSocket: false,
      replacements: [
        { pattern: "Sep", replacement: "$1 September" },
        { pattern: "Oct", replacement: "October", limit: 0 },
      ],
    }) as any;
    expect(res.filesModified[0].diff).toContain("$1 September Oct");
    expect(res.filesModified[0].patch).toContain("--- main.typ");
    expect(res.filesModified[0].replacementCounts).toEqual([1, 0]);
    expect((await client.readFile("proj-search", "main.typ")).content).toBe("\uFEFF$1 September Oct\r\n");
    expect((await client.readFile("proj-search", "refs.bib")).content).toBe("Sep Oct");
  });

  it("supports summary output on single replacements and glob filtering for batches", async () => {
    const client = createMockProjectClient([
      { id: "f-1", name: "main.typ", isMultiplayable: true, content: "Sep" },
      { id: "f-2", name: "refs.bib", isMultiplayable: true, content: "Sep" },
    ]);
    const single = await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search", filePath: "main.typ", output: "summary", dryRun: true,
      pattern: "Sep", replacement: "September",
    }) as any;
    expect(single.filesModified[0]).not.toHaveProperty("diff");
    expect(single.filesModified[0]).not.toHaveProperty("patch");
    const batch = await dispatchTypstTool(client, "typst_find_and_replace", {
      projectId: "proj-search", glob: "*.typ", preferWebSocket: false,
      replacements: [{ pattern: "Sep", replacement: "September" }],
    }) as any;
    expect(batch.filesModified.length).toBe(1);
    expect((await client.readFile("proj-search", "refs.bib")).content).toBe("Sep");
  });

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

import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { TypstCloudClient } from "../src/client/typst-client.js";
import { dispatchTypstTool } from "../src/index.js";
import { createInitialYjsUpdate, decodeYjsText } from "../src/protocol/yjs-doc.js";
import { hashText } from "../src/protocol/read-content.js";

function editableClient(text: string) {
  const client = new TypstCloudClient({ apiUrl: "https://mock.typst.test" });
  let state = createInitialYjsUpdate(text);
  let saves = 0;
  let downloads = 0;
  client.listFiles = async () => [{
    id: "file-core", name: "main.typ", isMultiplayable: true,
    lastChange: { date: 1 }, size: state.length, version: 1,
  }];
  client.downloadFileYjs = async () => { downloads++; return state; };
  client.saveYjsUpdate = async (_projectId, _fileId, update) => {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      Y.applyUpdate(doc, update);
      state = Y.encodeStateAsUpdate(doc);
      saves++;
    } finally { doc.destroy(); }
    return { syncChannel: "rest" };
  };
  return { client, text: () => decodeYjsText(state), saves: () => saves, downloads: () => downloads };
}

const target = { projectId: "project-core", filePath: "main.typ" };

describe("Agent read/edit workflow", () => {
  it("reads a range then edits with its whole-file hash and a compact receipt", async () => {
    const mock = editableClient("a\nSep 2025\nlast\n");
    const read = await dispatchTypstTool(mock.client, "typst_read_file", { ...target, offset: 2, limit: 1 }) as any;
    expect(read.content).toBe("Sep 2025\n");
    const result = await dispatchTypstTool(mock.client, "typst_edit_file", {
      ...target, oldText: "Sep", newText: "September", expectedHash: read.contentHash,
    }) as any;
    expect(result.appliedCount).toBe(1);
    expect(result.contentHash).toBe(hashText(mock.text()));
    expect(result.firstChangedLine).toBe(2);
    expect(result.file).toEqual({ id: "file-core", name: "main.typ" });
    expect(result).not.toHaveProperty("diff");
    expect(result).not.toHaveProperty("patch");
    expect(mock.text()).toBe("a\nSeptember 2025\nlast\n");
    expect(mock.saves()).toBe(1);
  });

  it("checks stale hashes inside the queue, allowing only one concurrent guarded edit", async () => {
    const mock = editableClient("Sep Oct");
    const expectedHash = hashText(mock.text());
    const results = await Promise.allSettled([
      dispatchTypstTool(mock.client, "typst_edit_file", { ...target, expectedHash, oldText: "Sep", newText: "September" }),
      dispatchTypstTool(mock.client, "typst_edit_file", { ...target, expectedHash, oldText: "Oct", newText: "October" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("File changed since read");
    expect(mock.saves()).toBe(1);
    expect(mock.text()).toBe("September Oct");
  });

  it("does not save previews and returns the hash of actual cloud text", async () => {
    const mock = editableClient("Sep\n");
    const result = await dispatchTypstTool(mock.client, "typst_edit_file", {
      ...target, oldText: "Sep", newText: "September", dryRun: true,
    }) as any;
    expect(result.diff).toContain("September");
    expect(result.contentHash).toBe(hashText("Sep\n"));
    expect(result.dryRun).toBe(true);
    expect(mock.saves()).toBe(0);
    expect(mock.text()).toBe("Sep\n");
  });

  it("rejects malformed edits and options before any download or save", async () => {
    const mock = editableClient("Sep Oct");
    for (const args of [
      { edits: [{ oldText: "Sep", newText: "September" }, { oldText: "Oct" }] },
      { edits: [], oldText: "Sep", newText: "September" },
      { oldText: "Sep" }, { oldText: "", newText: "x" },
      { oldText: "Sep", newText: "September", expectedHash: "v1" },
      { oldText: "Sep", newText: "September", dryRun: "false" },
      { oldText: "Sep", newText: "September", matchMode: "unknown" },
      { oldText: "Sep", newText: "September", maxDiffBytes: -1 },
      { oldText: "Sep", newText: "September", output: "unknown" },
    ]) await expect(dispatchTypstTool(mock.client, "typst_edit_file", { ...target, ...args })).rejects.toThrow();
    expect(mock.downloads()).toBe(0);
    expect(mock.saves()).toBe(0);
  });

  it("requires opt-in for fuzzy edits and preserves exact source around them", async () => {
    const mock = editableClient('“Sep” — keep  \r\nlast\n');
    const args = { ...target, oldText: '"Sep"', newText: '"September"' };
    await expect(dispatchTypstTool(mock.client, "typst_edit_file", args)).rejects.toThrow("Could not find");
    expect(mock.saves()).toBe(0);
    const result = await dispatchTypstTool(mock.client, "typst_edit_file", { ...args, matchMode: "fuzzy" }) as any;
    expect(result.usedFuzzyMatch).toBe(true);
    expect(mock.text()).toBe('"September" — keep  \r\nlast\n');
  });

  it("bounds verbose responses and reduces receipt size compared with full output", async () => {
    const original = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const mock = editableClient(original);
    const args = { ...target, oldText: original, newText: original.toUpperCase(), dryRun: true };
    const summary = await dispatchTypstTool(mock.client, "typst_edit_file", { ...args, output: "summary" }) as any;
    const full = await dispatchTypstTool(mock.client, "typst_edit_file", { ...args, output: "full", maxDiffBytes: 200 }) as any;
    expect(Buffer.byteLength(full.diff)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(full.patch)).toBeLessThanOrEqual(200);
    expect(full.diffTruncated).toBe(true);
    expect(full.patchTruncated).toBe(true);
    expect(full.syncChannel).toBe("none");
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(mock.saves()).toBe(0);
  });

  it("shares the ID lock with path-based whole-file writes", async () => {
    const mock = editableClient("Sep Oct");
    let inFlight = 0;
    let maxInFlight = 0;
    const save = mock.client.saveYjsUpdate.bind(mock.client);
    mock.client.saveYjsUpdate = async (...args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      try { return await save(...args); } finally { inFlight--; }
    };
    await Promise.all([
      mock.client.writeFile(target.projectId, "main.typ", "September Oct"),
      mock.client.editFile(target.projectId, "file-core", [{ oldText: "Oct", newText: "October" }]),
    ]);
    expect(maxInFlight).toBe(1);
  });
});

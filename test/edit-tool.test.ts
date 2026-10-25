import { describe, expect, it } from "bun:test";
import {
  createInitialYjsUpdate,
  decodeYjsText,
  editYjsText,
} from "../src/protocol/yjs-doc.js";
import { prepareEditArguments } from "../src/index.js";

describe("Phase 3 Edit Tool: Resilient Surgical Editing & Diff Generation", () => {
  it("applies exact replacement and computes line diff and patch", () => {
    const original = "= My Document\n\n#let author = \"Alice\"\n\nHello world!\n";
    const update = createInitialYjsUpdate(original);

    const result = editYjsText(
      update,
      [{ oldText: "Hello world!", newText: "Hello universe!" }],
      "main.typ"
    );

    expect(result.appliedCount).toBe(1);
    expect(result.updatedText).toContain("Hello universe!");
    expect(result.diff).toContain("-");
    expect(result.diff).toContain("Hello world!");
    expect(result.diff).toContain("+");
    expect(result.diff).toContain("Hello universe!");
    expect(result.patch).toContain("--- main.typ");
    expect(result.patch).toContain("+++ main.typ");

    // Decoded Yjs text must match
    const decoded = decodeYjsText(result.mergedState);
    expect(decoded).toBe("= My Document\n\n#let author = \"Alice\"\n\nHello universe!\n");
  });

  it("applies multiple disjoint edits in one call", () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const update = createInitialYjsUpdate(original);

    const result = editYjsText(
      update,
      [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "delta\n", newText: "DELTA\n" },
      ],
      "main.typ"
    );

    expect(result.appliedCount).toBe(2);
    expect(result.updatedText).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
    expect(decodeYjsText(result.mergedState)).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
  });

  it("handles fuzzy matching with smart quotes and Unicode dashes", () => {
    // Original contains Unicode smart quotes and em-dash
    const original = "He said \u201CHello\u201D \u2014 and left.\n";
    const update = createInitialYjsUpdate(original);

    // LLM sends ASCII quotes and regular hyphen
    const result = editYjsText(
      update,
      [{ oldText: 'He said "Hello" - and left.', newText: "He departed quietly." }],
      "main.typ"
    );

    expect(result.appliedCount).toBe(1);
    expect(result.updatedText).toBe("He departed quietly.\n");
    expect(decodeYjsText(result.mergedState)).toBe("He departed quietly.\n");
  });

  it("preserves CRLF line endings after edit", () => {
    const original = "line1\r\nline2\r\nline3\r\n";
    const update = createInitialYjsUpdate(original);

    // LLM sends LF
    const result = editYjsText(
      update,
      [{ oldText: "line2\n", newText: "REPLACED\n" }],
      "main.typ"
    );

    expect(result.updatedText).toBe("line1\r\nREPLACED\r\nline3\r\n");
    expect(decodeYjsText(result.mergedState)).toBe("line1\r\nREPLACED\r\nline3\r\n");
  });

  it("preserves UTF-8 BOM after edit", () => {
    const original = "\uFEFFline1\nline2\nline3\n";
    const update = createInitialYjsUpdate(original);

    const result = editYjsText(
      update,
      [{ oldText: "line2\n", newText: "REPLACED\n" }],
      "main.typ"
    );

    expect(result.updatedText.startsWith("\uFEFF")).toBe(true);
    expect(result.updatedText).toBe("\uFEFFline1\nREPLACED\nline3\n");
  });

  it("rejects non-unique oldText matches with clear error", () => {
    const original = "duplicate line\nmiddle\nduplicate line\n";
    const update = createInitialYjsUpdate(original);

    expect(() =>
      editYjsText(
        update,
        [{ oldText: "duplicate line\n", newText: "unique\n" }],
        "main.typ"
      )
    ).toThrow("Found 2 occurrences of oldText in main.typ (must be unique)");
  });

  it("rejects overlapping edits with clear error", () => {
    const original = "1234567890\n";
    const update = createInitialYjsUpdate(original);

    expect(() =>
      editYjsText(
        update,
        [
          { oldText: "12345", newText: "A" },
          { oldText: "45678", newText: "B" },
        ],
        "main.typ"
      )
    ).toThrow("Edits overlap in main.typ");
  });

  it("normalizes diverse LLM argument shapes via prepareEditArguments", () => {
    // Array format
    expect(
      prepareEditArguments([{ oldText: "a", newText: "b" }])
    ).toEqual([{ oldText: "a", newText: "b" }]);

    // Stringified JSON array
    expect(
      prepareEditArguments('[{"oldText":"a","newText":"b"}]')
    ).toEqual([{ oldText: "a", newText: "b" }]);

    // Stringified JSON single object
    expect(
      prepareEditArguments('{"oldText":"a","newText":"b"}')
    ).toEqual([{ oldText: "a", newText: "b" }]);

    // Single object format
    expect(
      prepareEditArguments({ oldText: "a", newText: "b" })
    ).toEqual([{ oldText: "a", newText: "b" }]);

    // Null/undefined/invalid
    expect(prepareEditArguments(null)).toEqual([]);
    expect(prepareEditArguments(undefined)).toEqual([]);
  });
});

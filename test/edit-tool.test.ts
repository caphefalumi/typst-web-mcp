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

    // Absent edits are distinct from malformed supplied edits.
    expect(() => prepareEditArguments(null)).toThrow();
    expect(prepareEditArguments(undefined)).toEqual([]);
  });

  it("rejects the entire edit list if any entry is malformed", () => {
    for (const edits of [
      [{ oldText: "a", newText: "b" }, { oldText: "c" }],
      "not json", [], [{ oldText: "", newText: "x" }],
      [{ oldText: 1, newText: "x" }],
    ]) expect(() => prepareEditArguments(edits)).toThrow();
  });

  it("rejects overlapping occurrences of the same anchor", () => {
    expect(() => editYjsText(createInitialYjsUpdate("aaaa"), [
      { oldText: "aaa", newText: "x" },
    ])).toThrow("Found 2 occurrences");
  });

  it("uses exact anchors independently when another edit needs fuzzy matching", () => {
    const original = '“one” and "one"; “two” — keep — ﬃ  \n';
    const result = editYjsText(createInitialYjsUpdate(original), [
      { oldText: '"one"', newText: '"ONE"' },
      { oldText: '"two"', newText: '"TWO"' },
    ]);
    expect(result.updatedText).toBe('“one” and "ONE"; "TWO" — keep — ﬃ  \n');
    expect(result.usedFuzzyMatch).toBe(true);
  });

  it("preserves fuzzy-adjacent characters even when NFKC changes lengths", () => {
    const original = 'ﬃ — “Café” — untouched  \n';
    const result = editYjsText(createInitialYjsUpdate(original), [
      { oldText: 'ffi - "Café"', newText: 'Updated' },
    ]);
    expect(result.updatedText).toBe('Updated — untouched  \n');
    const combining = editYjsText(createInitialYjsUpdate('“Cafe\u0301” — keep'), [
      { oldText: '"Café"', newText: 'Done' },
    ]);
    expect(combining.updatedText).toBe('Done — keep');
  });

  it("rejects partial grapheme fallback and ambiguous fuzzy matches", () => {
    expect(() => editYjsText(createInitialYjsUpdate("ﬃ"), [{ oldText: "f", newText: "x" }])).toThrow("Could not find");
    expect(() => editYjsText(createInitialYjsUpdate('“a” ‘a’ “a”'), [{ oldText: '"a"', newText: "x" }])).toThrow("Found 2 occurrences");
  });

  it("supports exact-only mode and preserves mixed line endings outside edits", () => {
    expect(() => editYjsText(createInitialYjsUpdate('“a”'), [{ oldText: '"a"', newText: "x" }], "main.typ", "exact"))
      .toThrow("Could not find");
    const result = editYjsText(createInitialYjsUpdate("a\r\nb\nc\r\nd\r"), [{ oldText: "b", newText: "B" }]);
    expect(result.updatedText).toBe("a\r\nB\nc\r\nd\r");
  });

  it("reports the first changed line for deletion-only edits", () => {
    const result = editYjsText(createInitialYjsUpdate("a\nb\nc\n"), [{ oldText: "b\n", newText: "" }]);
    expect(result.firstChangedLine).toBe(2);
  });

  it("keeps emoji and supplementary Unicode intact when trimming edit boundaries", () => {
    for (const [oldText, newText] of [
      ["prefix 😀 suffix", "prefix 😁 suffix"],
      ["prefix " + String.fromCodePoint(0x10000), "prefix " + String.fromCodePoint(0x10400)],
      ["🙂abc", "🙂"], ["🙂", "🙂abc"],
    ]) {
      const result = editYjsText(createInitialYjsUpdate("before\n" + oldText + "\nafter"), [{ oldText: oldText!, newText: newText! }]);
      expect(result.updatedText).toBe("before\n" + newText + "\nafter");
      expect(decodeYjsText(result.mergedState)).toBe(result.updatedText);
    }
  });
});

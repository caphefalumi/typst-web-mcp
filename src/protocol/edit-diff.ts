/**
 * Surgical text editing and diff utilities, adapted from Pi (earendil-works/pi).
 */
import * as Diff from "diff";

export interface Edit {
  oldText: string;
  newText: string;
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export type TextReplacement = Pick<
  MatchedEdit,
  "matchIndex" | "matchLength" | "newText"
>;

export interface LineSpan {
  start: number;
  end: number;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n"
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function splitBom(text: string): { bom: string; text: string } {
  if (text.charCodeAt(0) === 0xfeff) {
    return { bom: "\uFEFF", text: text.slice(1) };
  }
  return { bom: "", text };
}

/**
 * Normalize text for fuzzy matching:
 * - NFKC unicode normalization
 * - Strip trailing whitespace per line
 * - Smart quotes -> ' and "
 * - Unicode dashes/hyphens -> -
 * - Special spaces -> standard space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside base content");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside base content");
  }

  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(
  content: string,
  replacements: TextReplacement[],
  offset = 0
): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[]
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines: base content has different line count"
    );
  }

  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: TextReplacement[];
  }> = [];
  const sortedReplacements = [...replacements].sort(
    (a, b) => a.matchIndex - b.matchIndex
  );

  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");

    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");

  return result;
}

export function fuzzyFindText(
  content: string,
  oldText: string
): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const { normalized: fuzzyContent, starts, ends } = fuzzyTextWithOffsets(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyOldText.length ? fuzzyContent.indexOf(fuzzyOldText) : -1;

  // Do not replace part of an expanded Unicode grapheme (e.g. one f in ﬃ).
  const last = fuzzyIndex + fuzzyOldText.length - 1;
  if (fuzzyIndex === -1 || starts[fuzzyIndex] === starts[fuzzyIndex - 1] ||
      ends[last] === ends[last + 1]) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    index: starts[fuzzyIndex]!,
    matchLength: ends[last]! - starts[fuzzyIndex]!,
    usedFuzzyMatch: true,
    contentForReplacement: content,
  };
}

/** Keep original offsets so fallback matching cannot normalize unrelated text. */
function fuzzyTextWithOffsets(content: string) {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment, index } of segmenter.segment(content)) {
    // Append a sentinel so trailing spaces are retained until the line-level trim.
    const value = normalizeForFuzzyMatch(segment + "\u0000").slice(0, -1);
    normalized += value;
    for (let i = 0; i < value.length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  let offset = 0;
  const keptStarts: number[] = [];
  const keptEnds: number[] = [];
  const trimmedLines = normalized.split("\n").map(line => {
    const trimmed = line.trimEnd();
    for (let i = 0; i < trimmed.length; i++) {
      keptStarts.push(starts[offset + i]!);
      keptEnds.push(ends[offset + i]!);
    }
    offset += line.length;
    if (offset < normalized.length) {
      keptStarts.push(starts[offset]!);
      keptEnds.push(ends[offset]!);
      offset++;
    }
    return trimmed;
  });
  return { normalized: trimmedLines.join("\n"), starts: keptStarts, ends: keptEnds };
}

export function countOccurrences(content: string, oldText: string): number {
  if (!oldText.length) return 0;
  let count = 0;
  let offset = content.indexOf(oldText);
  while (offset !== -1) {
    count++;
    offset = content.indexOf(oldText, offset + 1);
  }
  return count;
}

export function validateEdits(edits: Edit[]): void {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("At least one edit operation is required");
  }
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText.length) {
      throw new Error(`Edit ${index + 1} requires a non-empty oldText and a string newText.`);
    }
  }
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
  matchMode: "exact" | "fuzzy" = "fuzzy"
): { baseContent: string; newContent: string; matchedEdits: MatchedEdit[]; usedFuzzyMatch: boolean } {
  validateEdits(edits);
  const normalizedEdits = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      throw new Error(`oldText cannot be empty for edit in ${path}`);
    }
  }

  let usedFuzzyMatch = false;
  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const exactIndex = normalizedContent.indexOf(edit.oldText);
    const matchResult = exactIndex !== -1 ? {
      found: true, index: exactIndex, matchLength: edit.oldText.length, usedFuzzyMatch: false,
    } : matchMode === "fuzzy" ? fuzzyFindText(normalizedContent, edit.oldText) : { found: false };
    if (!matchResult.found) {
      throw new Error(
        `Could not find match for oldText in ${path}: ${JSON.stringify(
          edit.oldText.slice(0, 80)
        )}`
      );
    }

    const fuzzy = Boolean(matchResult.usedFuzzyMatch);
    usedFuzzyMatch ||= fuzzy;
    const occurrences = countOccurrences(
      fuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent,
      fuzzy ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText
    );
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of oldText in ${path} (must be unique): ${JSON.stringify(
          edit.oldText.slice(0, 80)
        )}`
      );
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index!,
      matchLength: matchResult.matchLength!,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const prev = matchedEdits[i - 1]!;
    const curr = matchedEdits[i]!;
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(
        `Edits overlap in ${path}. Merge overlapping changes into a single edit.`
      );
    }
  }

  const baseContent = normalizedContent;
  const newContent = applyReplacements(normalizedContent, matchedEdits);

  if (baseContent === newContent) {
    throw new Error(`No changes made to ${path}: newText equals oldText.`);
  }

  return { baseContent, newContent, matchedEdits, usedFuzzyMatch };
}

/**
 * Generate a standard unified patch.
 */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4
): string {
  return Diff.createTwoFilesPatch(
    path,
    path,
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: contextLines,
    }
  );
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines =
            raw.length - leadingLines.length - trailingLines.length;

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }

          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;

          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;

        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }

        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }

        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

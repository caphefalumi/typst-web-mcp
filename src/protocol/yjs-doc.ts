import * as Y from "yjs";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
  validateEdits,
  type Edit,
} from "./edit-diff.js";

export interface TextEditOperation {
  oldText: string;
  newText: string;
}

export interface EditYjsTextResult {
  encodedUpdate: Uint8Array;
  mergedState: Uint8Array;
  previousText: string;
  updatedText: string;
  appliedCount: number;
  diff: string;
  patch: string;
  firstChangedLine?: number;
  usedFuzzyMatch: boolean;
}

function computeUpdateDiff(
  doc: Y.Doc,
  remoteUpdate: Uint8Array
): { encodedUpdate: Uint8Array; mergedState: Uint8Array } {
  let stateVector: Uint8Array | undefined;
  if (remoteUpdate.byteLength > 0) {
    stateVector = Y.encodeStateVectorFromUpdate(remoteUpdate);
  }
  const encodedUpdate = Y.encodeStateAsUpdate(doc, stateVector);
  const mergedState = Y.encodeStateAsUpdate(doc);
  return { encodedUpdate, mergedState };
}

/**
 * Decodes a binary Yjs state update from GET /v1/files/:projectId/:fileId/yjs
 * into its UTF-8 text string (`doc.getText("text")`).
 */
export function decodeYjsText(remoteUpdate: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    if (remoteUpdate.byteLength > 0) {
      Y.applyUpdate(doc, remoteUpdate);
    }
    return doc.getText("text").toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Encodes an initial UTF-8 text string into a full Yjs state update (`Uint8Array`).
 */
export function createInitialYjsUpdate(initialText: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    const ytext = doc.getText("text");
    if (initialText.length > 0) {
      ytext.insert(0, initialText);
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Replaces the entire text content of a Yjs document given its remote baseline state,
 * returning both the incremental diff update (`encodedUpdate`) and the merged full state (`mergedState`).
 */
export function replaceYjsText(
  remoteUpdate: Uint8Array,
  newContent: string
): {
  encodedUpdate: Uint8Array;
  mergedState: Uint8Array;
  previousText: string;
  updatedText: string;
} {
  const doc = new Y.Doc();
  try {
    if (remoteUpdate.byteLength > 0) {
      Y.applyUpdate(doc, remoteUpdate);
    }
    const ytext = doc.getText("text");
    const previousText = ytext.toString();

    doc.transact(() => {
      if (ytext.length > 0) {
        ytext.delete(0, ytext.length);
      }
      if (newContent.length > 0) {
        ytext.insert(0, newContent);
      }
    });

    const { encodedUpdate, mergedState } = computeUpdateDiff(doc, remoteUpdate);

    return {
      encodedUpdate,
      mergedState,
      previousText,
      updatedText: ytext.toString(),
    };
  } finally {
    doc.destroy();
  }
}

/**
 * Applies one or more surgical text replacements (`oldText` -> `newText`)
 * directly on the `Y.Text("text")` CRDT, with CRLF/BOM resilience, fuzzy matching,
 * and unified diff generation.
 */
export function editYjsText(
  remoteUpdate: Uint8Array,
  edits: TextEditOperation[],
  filePath = "file",
  matchMode: "exact" | "fuzzy" = "fuzzy"
): EditYjsTextResult {
  validateEdits(edits);

  const doc = new Y.Doc();
  try {
    if (remoteUpdate.byteLength > 0) {
      Y.applyUpdate(doc, remoteUpdate);
    }
    const ytext = doc.getText("text");
    const previousText = ytext.toString();

    const { bom, text: contentWithoutBom } = splitBom(previousText);
    const originalEnding = detectLineEnding(contentWithoutBom);
    const normalizedContent = normalizeToLF(contentWithoutBom);

    const { baseContent, newContent, matchedEdits, usedFuzzyMatch } = applyEditsToNormalizedContent(
      normalizedContent,
      edits,
      filePath,
      matchMode
    );

    // Map LF-normalized match boundaries back to original UTF-16 offsets.
    // Preserve all untouched characters, including mixed CRLF/LF line endings.
    const offsets = [0];
    for (let i = 0; i < contentWithoutBom.length; i++) {
      if (contentWithoutBom[i] === "\r" && contentWithoutBom[i + 1] === "\n") i++;
      offsets.push(i + 1);
    }
    const rawEdits = [...matchedEdits].reverse().map(edit => {
      const start = offsets[edit.matchIndex]!;
      const end = offsets[edit.matchIndex + edit.matchLength]!;
      return { start, end, newText: restoreLineEndings(edit.newText, originalEnding) };
    });
    let updatedContent = contentWithoutBom;
    for (const edit of rawEdits) {
      updatedContent = updatedContent.slice(0, edit.start) + edit.newText + updatedContent.slice(edit.end);
    }
    const finalContent = bom + updatedContent;

    // Use known edit ranges instead of diffing the entire document character by
    // character. Retain each anchor's unchanged prefix/suffix and their CRDT IDs.
    doc.transact(() => {
      for (const edit of rawEdits) {
        const old = contentWithoutBom.slice(edit.start, edit.end);
        let prefix = 0;
        while (prefix < old.length && prefix < edit.newText.length && old[prefix] === edit.newText[prefix]) prefix++;
        // Never split surrogate pairs when trimming a common prefix/suffix.
        if (prefix > 0 && /[\uD800-\uDBFF]/.test(old[prefix - 1]!) && /[\uDC00-\uDFFF]/.test(old[prefix] ?? "")) prefix--;
        let suffix = 0;
        while (suffix < old.length - prefix && suffix < edit.newText.length - prefix &&
               old[old.length - 1 - suffix] === edit.newText[edit.newText.length - 1 - suffix]) suffix++;
        if (suffix > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - suffix]!) &&
            /[\uD800-\uDBFF]/.test(old[old.length - suffix - 1] ?? "")) suffix--;
        const index = bom.length + edit.start + prefix;
        const removed = old.length - prefix - suffix;
        const inserted = edit.newText.slice(prefix, edit.newText.length - suffix);
        if (removed) ytext.delete(index, removed);
        if (inserted) ytext.insert(index, inserted);
      }
    });

    const { encodedUpdate, mergedState } = computeUpdateDiff(doc, remoteUpdate);
    const diffResult = generateDiffString(baseContent, newContent);
    const patch = generateUnifiedPatch(filePath, baseContent, newContent);

    return {
      encodedUpdate,
      mergedState,
      previousText,
      updatedText: finalContent,
      appliedCount: edits.length,
      diff: diffResult.diff,
      patch,
      firstChangedLine: diffResult.firstChangedLine,
      usedFuzzyMatch,
    };
  } finally {
    doc.destroy();
  }
}

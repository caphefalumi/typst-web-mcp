import * as Y from "yjs";
import * as Diff from "diff";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
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
  filePath = "file"
): EditYjsTextResult {
  if (edits.length === 0) {
    throw new Error("At least one edit operation is required");
  }

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

    const { baseContent, newContent } = applyEditsToNormalizedContent(
      normalizedContent,
      edits,
      filePath
    );

    const finalContent = bom + restoreLineEndings(newContent, originalEnding);

    // Apply minimal surgical character changes to Y.Text
    const diffs = Diff.diffChars(previousText, finalContent);
    doc.transact(() => {
      let offset = 0;
      for (const part of diffs) {
        if (part.added) {
          ytext.insert(offset, part.value);
          offset += part.value.length;
        } else if (part.removed) {
          ytext.delete(offset, part.value.length);
        } else {
          offset += part.value.length;
        }
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
    };
  } finally {
    doc.destroy();
  }
}

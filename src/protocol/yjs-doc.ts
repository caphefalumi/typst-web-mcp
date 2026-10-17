import * as Y from "yjs";

export interface TextEditOperation {
  oldText: string;
  newText: string;
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

    const stateVector =
      remoteUpdate.byteLength > 0
        ? Y.encodeStateVectorFromUpdate(remoteUpdate)
        : undefined;
    const encodedUpdate = Y.encodeStateAsUpdate(doc, stateVector);
    const mergedState = Y.encodeStateAsUpdate(doc);

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
 * Applies one or more exact surgical text replacements (`oldText` -> `newText`)
 * directly on the `Y.Text("text")` CRDT so concurrent collaborator cursors and
 * history are preserved.
 */
export function editYjsText(
  remoteUpdate: Uint8Array,
  edits: TextEditOperation[]
): {
  encodedUpdate: Uint8Array;
  mergedState: Uint8Array;
  previousText: string;
  updatedText: string;
  appliedCount: number;
} {
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

    // Locate and validate all non-overlapping matches against the original text first
    const matchedRegions: {
      start: number;
      end: number;
      oldText: string;
      newText: string;
    }[] = [];

    for (const edit of edits) {
      if (!edit.oldText) {
        throw new Error("oldText cannot be empty in surgical edit");
      }
      const firstIdx = previousText.indexOf(edit.oldText);
      if (firstIdx === -1) {
        throw new Error(
          `Could not find exact oldText match: ${JSON.stringify(
            edit.oldText.slice(0, 80)
          )}`
        );
      }
      const secondIdx = previousText.indexOf(edit.oldText, firstIdx + 1);
      if (secondIdx !== -1) {
        throw new Error(
          `oldText is not unique in file (found at offset ${firstIdx} and ${secondIdx}): ${JSON.stringify(
            edit.oldText.slice(0, 80)
          )}`
        );
      }
      matchedRegions.push({
        start: firstIdx,
        end: firstIdx + edit.oldText.length,
        oldText: edit.oldText,
        newText: edit.newText,
      });
    }

    // Sort descending by start offset so earlier offsets remain valid during in-place Y.Text mutation
    matchedRegions.sort((a, b) => b.start - a.start);
    for (let i = 0; i < matchedRegions.length - 1; i++) {
      const upper = matchedRegions[i]!;
      const lower = matchedRegions[i + 1]!;
      if (lower.end > upper.start) {
        throw new Error(
          `Overlapping edit regions detected between [${lower.start}, ${lower.end}) and [${upper.start}, ${upper.end})`
        );
      }
    }

    doc.transact(() => {
      for (const region of matchedRegions) {
        ytext.delete(region.start, region.oldText.length);
        if (region.newText.length > 0) {
          ytext.insert(region.start, region.newText);
        }
      }
    });

    const stateVector =
      remoteUpdate.byteLength > 0
        ? Y.encodeStateVectorFromUpdate(remoteUpdate)
        : undefined;
    const encodedUpdate = Y.encodeStateAsUpdate(doc, stateVector);
    const mergedState = Y.encodeStateAsUpdate(doc);

    return {
      encodedUpdate,
      mergedState,
      previousText,
      updatedText: ytext.toString(),
      appliedCount: matchedRegions.length,
    };
  } finally {
    doc.destroy();
  }
}

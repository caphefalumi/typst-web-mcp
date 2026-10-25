import { createHash } from "node:crypto";

export interface ReadTextOptions {
  offset?: number;
  limit?: number;
  lineNumbers?: boolean;
  maxLines?: number;
  maxBytes?: number;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function validateReadOptions(options: ReadTextOptions): void {
  for (const key of ["offset", "limit", "maxLines", "maxBytes"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${key} must be a positive integer.`);
    }
  }
  if (options.maxBytes !== undefined && options.maxBytes > 1024 * 1024) {
    throw new Error("maxBytes must not exceed 1048576 (1 MiB). Read smaller ranges.");
  }
  if (options.lineNumbers !== undefined && typeof options.lineNumbers !== "boolean") {
    throw new Error("lineNumbers must be a boolean.");
  }
}

/** Return only complete source lines. Continuation metadata never enters source text. */
export function readTextContent(text: string, options: ReadTextOptions = {}) {
  validateReadOptions(options);
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const totalLines = lines.length;
  const offset = options.offset ?? 1;
  if (offset > Math.max(1, totalLines)) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
  }
  const maxLines = Math.min(options.limit ?? 200, options.maxLines ?? Infinity);
  const maxBytes = options.maxBytes ?? 16 * 1024;
  const selected: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  const stop = Math.min(totalLines, offset - 1 + maxLines);
  const width = String(stop).length;
  for (let index = offset - 1; index < stop; index++) {
    const line = lines[index]!;
    const rendered = options.lineNumbers
      ? `${String(index + 1).padStart(width, " ")} | ${line}` : line;
    const lineBytes = Buffer.byteLength(rendered, "utf8");
    if (bytes + lineBytes > maxBytes) {
      if (selected.length === 0) {
        throw new Error(`Line ${offset} needs ${lineBytes} bytes. Increase maxBytes (up to 1048576) or read another line.`);
      }
      truncatedBy = "bytes";
      break;
    }
    selected.push(rendered);
    bytes += lineBytes;
  }
  const endLine = offset - 1 + selected.length;
  const truncated = endLine < totalLines;
  return {
    content: selected.join(""),
    contentHash: hashText(text),
    totalLines,
    startLine: offset,
    endLine,
    truncated,
    ...(truncated ? { nextOffset: endLine + 1, truncatedBy } : {}),
  };
}

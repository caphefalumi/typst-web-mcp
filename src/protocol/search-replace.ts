/**
 * Search and global replace utilities for Typst projects.
 */
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.js";

export function matchGlob(path: string, pattern: string): boolean {
  if (!pattern || pattern === "*" || pattern === "**" || pattern === "**/*") {
    return true;
  }
  const normalizedPath = path.replace(/^\/+/, "");
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${escaped}$`, "i");
  return re.test(normalizedPath) || re.test(fileName);
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface SearchContentOptions {
  pattern: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}

export function searchInContent(
  filePath: string,
  content: string,
  options: SearchContentOptions
): { matches: GrepMatch[]; totalMatches: number } {
  const lines = content.split("\n");
  const matches: GrepMatch[] = [];
  const limit = options.limit ?? 100;
  const context = Math.max(0, options.context ?? 0);

  let regex: RegExp;
  if (options.literal) {
    const escaped = options.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, options.ignoreCase ? "i" : "");
  } else {
    try {
      regex = new RegExp(options.pattern, options.ignoreCase ? "i" : "");
    } catch {
      const escaped = options.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, options.ignoreCase ? "i" : "");
    }
  }

  let totalMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (regex.test(line)) {
      totalMatches++;
      if (matches.length < limit) {
        const contextBefore =
          context > 0 ? lines.slice(Math.max(0, i - context), i) : undefined;
        const contextAfter =
          context > 0
            ? lines.slice(i + 1, Math.min(lines.length, i + 1 + context))
            : undefined;

        matches.push({
          file: filePath,
          line: i + 1,
          text: line,
          contextBefore,
          contextAfter,
        });
      }
    }
  }

  return { matches, totalMatches };
}

export interface ReplaceContentOptions {
  pattern: string;
  replacement: string;
  regex?: boolean;
  ignoreCase?: boolean;
  limit?: number;
}

export interface ReplaceResult {
  updatedText: string;
  replacementCount: number;
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export function replaceInContent(
  filePath: string,
  content: string,
  options: ReplaceContentOptions
): ReplaceResult {
  let flags = "g";
  if (options.ignoreCase) flags += "i";

  let searchRegex: RegExp;
  if (options.regex) {
    searchRegex = new RegExp(options.pattern, flags);
  } else {
    const escaped = options.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    searchRegex = new RegExp(escaped, flags);
  }

  let count = 0;
  const limit = options.limit;

  const updatedText = content.replace(searchRegex, (match, ...args) => {
    if (limit !== undefined && count >= limit) {
      return match;
    }
    count++;
    if (!options.regex) {
      return options.replacement;
    }
    // For regex, support standard replacement with capture groups ($1, $2)
    return options.replacement.replace(/\$(\d+)/g, (_, groupIdx) => {
      const idx = parseInt(groupIdx, 10);
      return args[idx - 1] ?? "";
    });
  });

  const diffResult = generateDiffString(content, updatedText);
  const patch = generateUnifiedPatch(filePath, content, updatedText);

  return {
    updatedText,
    replacementCount: count,
    diff: diffResult.diff,
    patch,
    firstChangedLine: diffResult.firstChangedLine,
  };
}

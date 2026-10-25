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

export type ReplacementOutput = "summary" | "diff" | "full";

export interface ReplacementRequest {
  pattern?: string;
  replacement?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  limit?: number;
  replacements?: ReplaceContentOptions[];
  output?: ReplacementOutput;
}

/** Validate the entire request before any project files can be mutated. */
export function resolveReplacementRules(options: ReplacementRequest): ReplaceContentOptions[] {
  const hasSingle = options.pattern !== undefined || options.replacement !== undefined;
  if (options.replacements !== undefined && hasSingle) {
    throw new Error("Use either replacements or pattern/replacement, not both.");
  }
  if (options.output !== undefined && !["summary", "diff", "full"].includes(options.output)) {
    throw new Error("output must be summary, diff, or full.");
  }
  if (options.replacements !== undefined &&
      (options.regex !== undefined || options.ignoreCase !== undefined || options.limit !== undefined)) {
    throw new Error("For batch replacements, set regex, ignoreCase, and limit on each rule.");
  }
  const rules = options.replacements ?? [{
    pattern: options.pattern!, replacement: options.replacement!,
    regex: options.regex, ignoreCase: options.ignoreCase, limit: options.limit,
  }];
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("replacements must be a non-empty array.");
  }
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule.pattern !== "string" || !rule.pattern.length ||
        typeof rule.replacement !== "string") {
      throw new Error(`Replacement ${index + 1} requires a non-empty pattern and a string replacement.`);
    }
    for (const key of ["regex", "ignoreCase"] as const) {
      if (rule[key] !== undefined && typeof rule[key] !== "boolean") {
        throw new Error(`Replacement ${index + 1}: ${key} must be a boolean.`);
      }
    }
    if (rule.limit !== undefined && (!Number.isInteger(rule.limit) || rule.limit < 0)) {
      throw new Error(`Replacement ${index + 1}: limit must be a non-negative integer.`);
    }
    if (rule.regex) {
      try { new RegExp(rule.pattern, rule.ignoreCase ? "gi" : "g"); }
      catch { throw new Error(`Replacement ${index + 1} has an invalid regular expression.`); }
    }
  }
  return rules;
}

export function replaceInContent(
  filePath: string,
  content: string,
  options: ReplaceContentOptions
): ReplaceResult {
  const result = replaceBatchInContent(filePath, content, [options]);
  return { ...result, diff: result.diff!, patch: result.patch! };
}

/** Rules run in order on the result of the previous rule. Diff covers the whole batch. */
export function replaceBatchInContent(
  filePath: string,
  content: string,
  rules: ReplaceContentOptions[],
  output: ReplacementOutput = "full"
): Omit<ReplaceResult, "diff" | "patch"> & {
  diff?: string; patch?: string; replacementCounts: number[];
} {
  resolveReplacementRules({ replacements: rules, output });
  let updatedText = content;
  const replacementCounts: number[] = [];
  for (const options of rules) {
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

    updatedText = updatedText.replace(searchRegex, (match, ...args) => {
      if (limit !== undefined && count >= limit) {
        return match;
      }
      count++;
      if (!options.regex) {
        return options.replacement;
      }
      // The final callback arguments are offset/input and optional named groups,
      // not captures. Implement JS replacement tokens without exposing metadata.
      const hasNamedGroups = typeof args[args.length - 1] === "object";
      const groups = hasNamedGroups ? args[args.length - 1] : undefined;
      const input = args[args.length - (hasNamedGroups ? 2 : 1)] as string;
      const offset = args[args.length - (hasNamedGroups ? 3 : 2)] as number;
      const captures = args.slice(0, hasNamedGroups ? -3 : -2);
      return options.replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (token, key: string) => {
        if (key === "$") return "$";
        if (key === "&") return match;
        if (key === "`") return input.slice(0, offset);
        if (key === "'") return input.slice(offset + match.length);
        if (key.startsWith("<")) return groups ? groups[key.slice(1, -1)] ?? "" : token;
        const index = Number(key);
        if (index > 0 && index <= captures.length) return captures[index - 1] ?? "";
        const first = Number(key[0]);
        if (key.length === 2 && first > 0 && first <= captures.length) {
          return (captures[first - 1] ?? "") + key[1];
        }
        return token;
      });
    });
    replacementCounts.push(count);
  }

  const diffResult = generateDiffString(content, updatedText);

  return {
    updatedText,
    replacementCount: replacementCounts.reduce((sum, count) => sum + count, 0),
    replacementCounts,
    ...(output !== "summary" ? { diff: diffResult.diff } : {}),
    ...(output === "full" ? { patch: generateUnifiedPatch(filePath, content, updatedText) } : {}),
    firstChangedLine: diffResult.firstChangedLine,
  };
}

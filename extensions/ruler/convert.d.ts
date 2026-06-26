/**
 * ruler — Remote + local rules extension for skillshare.
 *
 * Type declarations for convert.js.
 * This file is a standalone script (not an importable module); the
 * declarations below document the top-level types and functions for
 * maintenance and IDE support.
 *
 * @remarks All functions are in the script's module scope and are not
 *          exported. The type definitions mirror the JSDoc annotations in
 *          convert.js — they are the authoritative source.
 */

// ═══════════════════════════════════════════════════════════════
// Data types
// ═══════════════════════════════════════════════════════════════

/** One entry in the frontmatter `urls` array. */
interface RuleUrl {
  /** Rule identifier (used as `<rule name="...">` attribute). */
  name?: string;
  /** Remote Markdown source URL. */
  url?: string;
}

/** Parsed frontmatter block (loose YAML-subset object). */
interface ParsedFrontmatter {
  name?: string;
  description?: string;
  urls?: RuleUrl[];
  outputs?: string[];
  [key: string]: unknown;
}

/** A built rule ready to be merged into output files. */
interface RuleEntry {
  /** Value for the `<rule name="...">` attribute. */
  name: string;
  /** Raw Markdown body inside the `<rule>` block. */
  content: string;
}

/** Internal tracker for a remote download task. */
interface RemoteTask {
  idx: number;
  name: string;
  url: string;
}

/** Result wrapper for a single async task in `runLimited`. */
interface TaskResult<T> {
  /** Successful return value. */
  value?: T;
  /** Error message if the task rejected. */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Maximum concurrent HTTP requests. */
declare const FETCH_CONCURRENCY: 4;

// ═══════════════════════════════════════════════════════════════
// YAML 子集解析器
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a YAML-subset frontmatter string into a plain object.
 *
 * Handles:
 * - `key: value` → string property
 * - `key:` → array (each indented `- ` item)
 * - `- key: value` with nested keys → object in array
 */
declare function parseYamlSubset(text: string): ParsedFrontmatter;

/**
 * Parse an indented YAML array block starting at `lines[start]`.
 * @param lines  All source lines.
 * @param start  Index of the first indented line after the array key.
 */
declare function parseYamlArray(lines: string[], start: number): any[];

// ═══════════════════════════════════════════════════════════════
// HTTP 下载
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch a URL and return its body as a string.
 * Follows HTTP 3xx redirects automatically (up to 5 hops).
 * @throws {Error} on non-200 status, network error, or redirect loop.
 */
declare function fetchUrl(url: string): Promise<string>;

// ═══════════════════════════════════════════════════════════════
// Concurrent pool
// ═══════════════════════════════════════════════════════════════

/**
 * Run async tasks with a concurrency cap.
 *
 * Preserves result order. A rejected task produces `{ error }` at its
 * index; the returned Promise NEVER rejects.
 *
 * @param tasks        Factory functions (invoked lazily as slots open).
 * @param concurrency  Maximum tasks in-flight at once.
 */
declare function runLimited<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<Array<TaskResult<T>>>;

// ═══════════════════════════════════════════════════════════════
// XML Rule Block 管理
// ═══════════════════════════════════════════════════════════════

/**
 * Escape `&`, `"`, `<`, `>` in an XML attribute value.
 */
declare function escapeXmlAttr(s: string): string;

/**
 * Build a `<rule name="…">…</rule>` XML block.
 *
 * If `content` contains the literal string `</rule>`, a warning is
 * emitted to stderr but the block is still returned as-is.
 */
declare function makeRuleBlock(name: string, content: string): string;

/**
 * Escape regex special characters in a string.
 */
declare function escapeRegex(s: string): string;

/**
 * Upsert a `<rule name="X">` block into existing file content.
 *
 * - If a matching block exists → the entire block is replaced.
 * - Otherwise → the block is appended at the end.
 *
 * Non-rule content is preserved.
 *
 * @param existing   Current file content (may be empty).
 * @param ruleName   Value of the `name` attribute to match.
 * @param newBlock   Full `<rule>…</rule>` string to insert.
 * @returns The updated file content.
 */
declare function upsertRule(existing: string, ruleName: string, newBlock: string): string;

// ═══════════════════════════════════════════════════════════════
// 项目根目录推算
// ═══════════════════════════════════════════════════════════════

/**
 * Infer the project root directory from `SS_TARGET_DIR`.
 *
 * Strategy:
 * - **Project mode** — `SS_TARGET_DIR` contains `/.skillshare/` →
 *   returns the path segment before that marker.
 * - **Global mode** — no `.skillshare/` → falls back to `$HOME`.
 *
 * @param targetDir  Value of `SS_TARGET_DIR` env var (already tilde-expanded).
 */
declare function findProjectRoot(targetDir: string): string;

/**
 * Resolve a list of output file paths to absolute paths.
 *
 * - `~` prefix → expanded to `$HOME`.
 * - Absolute path → returned as-is.
 * - Relative path → joined against `projectRoot`.
 *
 * @param outputs     Raw output path list from frontmatter.
 * @param projectRoot  Fallback base for relative paths.
 */
declare function resolveOutputs(outputs: string[], projectRoot: string): string[];

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════

/**
 * Entry point.
 *
 * 1. Reads stdin.
 * 2. Parses frontmatter.
 * 3. Downloads remote `urls` (concurrently), collects local body.
 * 4. Resolves output paths and upserts `<rule>` blocks.
 * 5. Writes no meaningful stdout (skillshare writes empty placeholders).
 */
declare function main(): Promise<void>;

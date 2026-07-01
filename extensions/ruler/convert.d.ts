/**
 * ruler — Remote + local rules extension for skillshare.
 *
 * Type declarations for convert.js.
 *
 * convert.js guards its entry point behind `require.main === module` and
 * exports the pure helpers below, so test-ruler.js exercises the real
 * implementation. These declarations document those exports for IDE support;
 * they mirror the JSDoc annotations in convert.js (the authoritative source).
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
  /** Per-url `enable` override (parsed string; "false" disables). */
  enable?: string;
}

/** Parsed frontmatter block (loose YAML-subset object). */
interface ParsedFrontmatter {
  name?: string;
  description?: string;
  urls?: RuleUrl[];
  outputs?: string[];
  /** Top-level `enable` toggle (parsed string; "false" disables all rules). */
  enable?: string;
  [key: string]: unknown;
}

/** A built rule ready to be merged into output files. */
interface RuleEntry {
  /** Value for the `<rule name="...">` attribute. */
  name: string;
  /** Raw Markdown body inside the `<rule>` block. */
  content: string;
}

/** A remote rule to download. */
interface RemoteRule {
  name: string;
  url: string;
}

/** Result of splitting a stub's rules by `enable` state. */
interface ClassifiedRules {
  /** Enabled remote rules to download and upsert. */
  remoteEnabled: RemoteRule[];
  /** Whether the local body is enabled (upsert). */
  localEnabled: boolean;
  /** Names of disabled rules to delete from output files. */
  disabledNames: string[];
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

/** Manifest filename, written in the extension dir. */
declare const MANIFEST_FILE: string;

// ═══════════════════════════════════════════════════════════════
// YAML subset parser
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
// HTTP download
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
// XML Rule Block management
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

/** Escape regex special characters in a string. */
declare function escapeRegex(s: string): string;

/**
 * Upsert a `<rule name="X">` block into existing file content.
 *
 * - If a matching block exists → the entire block is replaced.
 * - Otherwise → the block is appended at the end (exactly one blank line
 *   of separation; a fresh empty file gets no leading blank line).
 *
 * Non-rule content is preserved.
 */
declare function upsertRule(existing: string, ruleName: string, newBlock: string): string;

/**
 * Remove a `<rule name="X">…</rule>` block by name and normalize blank
 * lines so exactly one blank line stays between remaining blocks, the
 * first block has no leading blank line, and the file ends with a single
 * newline. Returns `""` when nothing remains.
 */
declare function deleteRule(existing: string, ruleName: string): string;

// ═══════════════════════════════════════════════════════════════
// Enable classification
// ═══════════════════════════════════════════════════════════════

/**
 * Decide whether a rule is enabled given the top-level and per-entry
 * `enable` values. A per-entry value overrides the top-level; only the
 * string `"false"` disables.
 */
declare function isEnabled(topEnable: string | undefined, entryEnable: string | undefined): boolean;

/**
 * Derive the `<rule name>` for the stub's local body: frontmatter `name`
 * → filename stem of `SS_REL_PATH` → `"local-rule"`.
 */
declare function deriveLocalName(fm: ParsedFrontmatter, relPath: string): string;

/**
 * Split a stub's rules into enabled (download/upsert) and disabled (delete)
 * based on the `enable` cascade. Disabled remote rules are NOT downloaded
 * (zero network); their names are returned for deletion. The local body
 * follows the top-level `enable` only.
 */
declare function classifyRules(
  topEnable: string | undefined,
  urls: RuleUrl[] | undefined,
  localName: string,
  body: string,
): ClassifiedRules;

// ═══════════════════════════════════════════════════════════════
// Sync manifest
// ═══════════════════════════════════════════════════════════════

/** Per-stub manifest entry: what was injected on the last sync. */
interface ManifestEntry {
  /** Absolute output file paths the rules were injected into. */
  outputs: string[];
  /** Rule names that were injected. */
  rules: string[];
}

/**
 * Manifest shape: `{ [targetDir]: { [stubRelPath]: ManifestEntry } }`.
 * Keys use normalized forward slashes.
 */
type RulerManifest = Record<string, Record<string, ManifestEntry>> & {
  _updated_at?: string;
};

/**
 * Read the sync manifest from a directory.
 * Returns {} on missing file or corrupt JSON.
 * @param extDir  Extension directory (usually process.cwd()).
 */
declare function readManifest(extDir: string): RulerManifest;

/**
 * Write the sync manifest to a directory with a `_updated_at` timestamp.
 */
declare function writeManifest(extDir: string, manifest: RulerManifest): void;

/**
 * Derive the source root from SS_SRC_PATH and SS_REL_PATH.
 * Strips relPath from the end of srcPath; falls back to dirname.
 */
declare function findSourceRoot(srcPath: string, relPath: string): string;

/**
 * Recursively list .md files under sourceRoot as normalized relative
 * paths. Returns null if sourceRoot is empty or unreadable.
 */
declare function listStubs(sourceRoot: string): Set<string> | null;

/**
 * Return rule names in oldNames but NOT in enabledNames (stale rules
 * to delete).
 */
declare function diffRuleNames(oldNames: string[], enabledNames: string[]): string[];

// ═══════════════════════════════════════════════════════════════
// Project root detection
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve the user's home directory cross-platform
 * (HOME → USERPROFILE → HOMEDRIVE+HOMEPATH).
 */
declare function homeDir(): string;

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
 */
declare function resolveOutputs(outputs: string[], projectRoot: string): string[];

// ═══════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Entry point.
 *
 * 1. Reads stdin.
 * 2. Parses frontmatter.
 * 3. Classifies rules by `enable` (disabled rules are not downloaded).
 * 3b. Reads manifest; GC stubs whose source files are gone; diffs current
 *     stub's old vs enabled rule names to find stale rules to delete.
 * 4. Downloads enabled remote `urls` (concurrently), collects local body.
 * 5. Resolves output paths.
 * 6. Per output file: deletes stale + disabled `<rule>` blocks, then
 *    upserts enabled `<rule>` blocks.
 * 7. Updates manifest with current stub state; writes no meaningful stdout.
 */
declare function main(): Promise<void>;

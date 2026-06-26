#!/usr/bin/env node
/**
 * ruler — Remote + local rules extension for skillshare.
 *
 * Reads stub .md files and injects rules into AGENTS.md / CLAUDE.md (or
 * custom outputs) via <rule name="..."> XML blocks.
 *
 * Two sources of rules, both optional and composable:
 *
 *   1. Remote URLs  — frontmatter `urls` array: each URL is downloaded
 *                     and wrapped in a <rule> block using the entry's `name`.
 *   2. Local body   — the stub's own Markdown body (after frontmatter) is
 *                     wrapped in a <rule> block named after the filename stem
 *                     (or frontmatter `name` if present).
 *
 * Frontmatter format (YAML subset):
 *   urls:
 *     - name: my-rule
 *       url: https://raw.githubusercontent.com/.../rules.md
 *   outputs:
 *     - AGENTS.md
 *     - CLAUDE.md
 *
 * If outputs is omitted it defaults to ["AGENTS.md", "CLAUDE.md"].
 * Paths can be relative (resolved against the project root), absolute, or
 * start with ~ (expanded to $HOME).
 *
 * The extension writes nothing meaningful to stdout — skillshare creates
 * empty placeholder files under the dummy output directory, which a
 * companion .gitignore suppresses.
 */

"use strict";

// Type declarations for IDE support: convert.d.ts

// ═══════════════════════════════════════════════════════════════════════════
// YAML subset parser (zero dependencies)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a YAML-subset frontmatter string into a plain object.
 *
 * Handles:
 *   key: value               → string property
 *   key:                     → array (each indented "- " item)
 *   - key: value             → object in array
 *     nested: value
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseYamlSubset(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i++];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const m = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    const val = m[2].trim();

    if (val) {
      result[key] = val.replace(/^["']|["']$/g, "").trim();
    } else {
      result[key] = parseYamlArray(lines, i);
      // Advance past all indented lines consumed by the array parser
      while (i < lines.length && lines[i].startsWith(" ")) i++;
    }
  }
  return result;
}

/**
 * Parse an indented YAML array block starting at lines[start].
 *
 * @param {string[]} lines
 * @param {number}   start
 * @returns {any[]}
 */
function parseYamlArray(lines, start) {
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || !line.startsWith(" ")) break;

    if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2).trim();
      const objM = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

      if (objM) {
        // Object-style array item
        const obj = {};
        obj[objM[1]] = objM[2].replace(/^["']|["']$/g, "").trim();
        const baseIndent = line.search(/\S/);
        i++;

        // Collect sibling keys at deeper indent
        while (i < lines.length) {
          const cl = lines[i];
          const ct = cl.trim();
          const ci = cl.search(/\S/);
          if (ci <= baseIndent || ct.startsWith("- ")) break;
          const sm = ct.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (sm) obj[sm[1]] = sm[2].replace(/^["']|["']$/g, "").trim();
          i++;
        }
        items.push(obj);
      } else {
        // Plain string array item
        items.push(content);
        i++;
      }
    } else {
      i++;
    }
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP download
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch a URL and return its body as a string.
 * Follows HTTP 3xx redirects automatically.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const MAX_REDIRECTS = 5;
    let remaining = MAX_REDIRECTS;

    function doGet(u) {
      const mod = u.startsWith("https") ? require("https") : require("http");
      const req = mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (--remaining <= 0) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      });
      req.setTimeout(10000, () => {
        req.destroy(new Error(`Timeout for ${u}`));
      });
      req.on("error", reject);
    }
    doGet(url);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// XML rule block management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escape special XML characters in an attribute value.
 * @param {string} s
 * @returns {string}
 */
function escapeXmlAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build a <rule name="..."> block from its name and body content.
 *
 * WARNING: The content must not contain the literal string `</rule>` — it
 * would break the identity-based replacement regex. The extension logs a
 * warning to stderr if detected.
 *
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function makeRuleBlock(name, content) {
  if (content.includes("</rule>")) {
    process.stderr.write(
      `ruler: warning — rule "${name}" contains "</rule>" in its content; ` +
        "the XML block boundary may be unreliable\n"
    );
  }
  return `<rule name="${escapeXmlAttr(name)}">\n${content.trim()}\n</rule>`;
}

/**
 * Escape regex special characters.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Upsert a <rule name="X"> block into existing file content.
 *
 * - If a <rule name="X"> block already exists → replace its entire content
 * - If no matching block exists → append at the end of the file
 *
 * Non-rule content (plain Markdown, other XML blocks, etc.) is preserved.
 *
 * @param {string} existing  — current file content
 * @param {string} ruleName — value of the name attribute
 * @param {string} newBlock — full <rule>...</rule> string
 * @returns {string}
 */
function upsertRule(existing, ruleName, newBlock) {
  const nameAttr = escapeRegex(ruleName);
  const re = new RegExp(`<rule\\s+name="${nameAttr}">[\\s\\S]*?<\\/rule>`, "g");

  if (re.test(existing)) {
    return existing.replace(re, newBlock);
  }

  // Append at end with blank-line separation
  const needsLeadingBlank = existing !== "" && !existing.endsWith("\n\n");
  const suffix = existing.endsWith("\n") ? "" : "\n";
  return existing + suffix + (needsLeadingBlank ? "\n" : "") + newBlock + "\n";
}

// ═══════════════════════════════════════════════════════════════════════════
// Project root detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the user's home directory in a cross-platform way.
 *
 * Node sets `process.env.HOME` on POSIX, but on Windows the home lives in
 * `USERPROFILE` (or the `HOMEDRIVE` + `HOMEPATH` pair). Falling back through
 * these avoids `~` expansion silently producing a drive-root-relative path
 * (e.g. `\.codex\AGENTS.md`) on Windows, where `process.env.HOME` is unset.
 *
 * @returns {string}
 */
function homeDir() {
  return (
    process.env.HOME ||
    process.env.USERPROFILE ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? process.env.HOMEDRIVE + process.env.HOMEPATH
      : "") ||
    ""
  );
}

/**
 * Infer the project root directory from SS_TARGET_DIR.
 *
 * Strategy:
 *   Project mode: SS_TARGET_DIR = /abs/path/to/project/.skillshare/extensions/…
 *                 → everything before "/.skillshare/" is the project root
 *   Global mode:  SS_TARGET_DIR = ~/.config/skillshare/extensions/…
 *                 → no ".skillshare/" in path → fall back to $HOME
 *
 * @param {string} targetDir  — value of SS_TARGET_DIR (already ~-expanded)
 * @returns {string}
 */
function findProjectRoot(targetDir) {
  const abs = targetDir ? require("path").resolve(targetDir) : "";
  if (!abs) return homeDir() || process.cwd();

  const sep = require("path").sep;
  const marker = sep + ".skillshare" + sep;
  const idx = abs.indexOf(marker);
  if (idx !== -1) return abs.slice(0, idx);

  // Global mode — no project context
  return homeDir() || process.cwd();
}

/**
 * Resolve a list of output file paths (relative, absolute, or ~) to
 * absolute paths.
 *
 * @param {string[]}  outputs     — file path list
 * @param {string}    projectRoot — fallback base for relative paths
 * @returns {string[]}
 */
function resolveOutputs(outputs, projectRoot) {
  const home = homeDir();
  return outputs.map((out) => {
    if (out.startsWith("~")) return require("path").join(home, out.slice(1));
    if (require("path").isAbsolute(out)) return out;
    return require("path").join(projectRoot, out);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── 1. Read stdin ──
  const input = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });

  // ── 2. Parse frontmatter ──
  const fmMatch = input.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
  const fmRaw = fmMatch ? fmMatch[1] : "";
  const fm = parseYamlSubset(fmRaw);

  /** @type {{name?:string, url?:string}[]} */
  const urls = fm.urls || [];
  const body = (fmMatch ? fmMatch[2] : input).trim();

// ── Concurrent download pool ──

/**
 * Maximum concurrent HTTP requests. Chosen to balance throughput
 * against server-side rate-limiting for common hosts (GitHub, GitLab).
 * @type {number}
 */
const FETCH_CONCURRENCY = 4;

/**
 * Run async tasks with a concurrency cap.
 * Preserves result order. Rejected tasks produce `{error}` at their index.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<Array<{value?:T, error?:string}>>}
 */
function runLimited(tasks, concurrency) {
  return new Promise((resolve) => {
    /** @type {Array<{value?:T, error?:string}>} */
    const results = new Array(tasks.length);
    let next = 0;
    let running = 0;
    let done = 0;

    function startOne() {
      while (running < concurrency && next < tasks.length) {
        const idx = next++;
        running++;
        tasks[idx]()
          .then((val) => { results[idx] = { value: val }; })
          .catch((err) => { results[idx] = { error: err && err.message ? err.message : String(err) }; })
          .finally(() => {
            running--;
            done++;
            if (done === tasks.length) resolve(results);
            else startOne();
          });
      }
    }

    if (tasks.length === 0) resolve(results);
    else startOne();
  });
}

// ── 3. Build rules list ──
/** @type {{name:string, content:string}[]} */
const rules = [];

// 3a. Remote URLs: download concurrently, one failing URL does not stop others
/** @type {Array<{idx:number, name:string, url:string}>} */
const remoteTasks = [];
for (let i = 0; i < urls.length; i++) {
  const entry = urls[i];
  if (!entry.url) continue;
  const name =
    entry.name ||
    require("path").basename(entry.url, require("path").extname(entry.url));
  remoteTasks.push({ idx: remoteTasks.length, name, url: entry.url });
}

if (remoteTasks.length > 0) {
  const downloadResults = await runLimited(
    remoteTasks.map((t) => () => fetchUrl(t.url)),
    FETCH_CONCURRENCY
  );

  for (let i = 0; i < remoteTasks.length; i++) {
    const t = remoteTasks[i];
    const r = downloadResults[i];
    if (r && r.value !== undefined) {
      rules.push({ name: t.name, content: r.value });
    } else {
      process.stderr.write("ruler: failed to fetch " + t.url + (r && r.error ? ": " + r.error : "") + "\n");
    }
  }
}

  // 3b. Local body content: use the stub's own Markdown body as a rule
  if (body) {
    const relPath = process.env.SS_REL_PATH || "";
    const localName =
      fm.name ||
      (relPath
        ? require("path").basename(relPath, require("path").extname(relPath))
        : "local-rule");
    rules.push({ name: localName, content: body });
  }

  if (!rules.length) {
    // Nothing to do (no urls and no body content)
    return;
  }

  // ── 4. Determine project root and output paths ──
  const tmplOutputs = fm.outputs && fm.outputs.length > 0 ? fm.outputs : null;
  const outputs = tmplOutputs || ["AGENTS.md", "CLAUDE.md"];
  const projectRoot = findProjectRoot(process.env.SS_TARGET_DIR || "");
  const outputPaths = resolveOutputs(outputs, projectRoot);

  // ── 5. Write / merge into each output file ──
  for (const outPath of outputPaths) {
    let existing = "";
    try {
      existing = require("fs").readFileSync(outPath, "utf8");
    } catch {
      // File does not exist yet — start fresh
    }

    for (const rule of rules) {
      const block = makeRuleBlock(rule.name, rule.content);
      existing = upsertRule(existing, rule.name, block);
    }

    require("fs").mkdirSync(require("path").dirname(outPath), { recursive: true });
    require("fs").writeFileSync(outPath, existing, "utf8");
  }

  // stdout intentionally empty — skillshare writes a zero-byte placeholder
  // into the dummy target directory, which .gitignore suppresses.
}

main().catch((err) => {
  process.stderr.write("ruler: " + (err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});

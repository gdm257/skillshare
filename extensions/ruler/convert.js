#!/usr/bin/env node
/**
 * ruler — Remote + local rules extension for skillshare.
 *
* Reads stub .md files and injects rules into AGENTS.md / CLAUDE.md (or
 * custom outputs) via <!-- rule-{name}:start/end --> HTML comment markers.
*
* Two sources of rules, both optional and composable:
*
*   1. Remote URLs  — frontmatter `urls` array: each URL is downloaded
 *                     and wrapped in a comment marker block using the entry's `name`.
*   2. Local body   — the stub's own Markdown body (after frontmatter) is
 *                     wrapped in a comment marker block named after the filename stem
*                     (or frontmatter `name` if present).
*
* Frontmatter format (YAML subset):
 *   enable: true              # optional top-level toggle (default: true)
 *   urls:
 *     - name: my-rule
 *       url: https://raw.githubusercontent.com/.../rules.md
 *       enable: true          # optional per-url toggle (overrides top-level)
 *   outputs:
 *     - AGENTS.md
 *     - CLAUDE.md
 *
* `enable: false` withdraws a rule: it is NOT downloaded, and any existing
 * <!-- rule-{name}:start/end --> block with the same name is removed from each output
* file (blank lines re-normalized). Per-url `enable` overrides the stub's
* top-level `enable`; the local body has no per-entry knob and follows the
* top-level `enable` only.
*
* If outputs is omitted it defaults to ["AGENTS.md", "CLAUDE.md"].
 * Paths can be relative (resolved against the project root), absolute, or
 * start with ~ (expanded to $HOME).
 *
 * The extension writes nothing meaningful to stdout — skillshare creates
 * empty placeholder files under the dummy output directory, which a
 * companion .gitignore suppresses.
 *
* Pure helpers are exported (parseYamlSubset, makeRuleBlock, upsertRule,
 * deleteRule, migrateXmlToComments, isEnabled, classifyRules, ...) so
 * test-ruler.js exercises the real implementation instead of a divergent copy.
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
 *   key: value               -> string property
 *   key:                     -> array (each indented "- " item)
 *   - key: value             -> object in array
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
// Concurrent download pool
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Rule block management (HTML comment markers)
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
 * Unescape XML entities in an attribute value (reverse of escapeXmlAttr).
 * Used during migration from the old <rule name="..."> format.
 * @param {string} s
 * @returns {string}
 */
function unescapeXmlAttr(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Build a <!-- rule-{name}:start/end --> block from its name and body content.
 *
 * If `name` contains `--` or `>` (which can break HTML comment parsing), or
 * if `content` contains the block's end marker string, a warning is emitted
 * to stderr but the block is still returned as-is.
 *
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function makeRuleBlock(name, content) {
  if (name.includes("--") || name.includes(">")) {
    process.stderr.write(
      `ruler: warning — rule name "${name}" contains "--" or ">" which may break HTML comment markers\n`
    );
  }
  const endMarker = `<!-- rule-${name}:end -->`;
  if (content.includes(endMarker)) {
    process.stderr.write(
      `ruler: warning — rule "${name}" content contains its end marker; ` +
        "the comment boundary may be unreliable\n"
    );
  }
  return `<!-- rule-${name}:start -->\n${content.trim()}\n<!-- rule-${name}:end -->`;
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
 * Upsert a <!-- rule-{name}:start/end --> block into existing file content.
 *
 * - If a matching comment block already exists -> replace its entire content
 * - If no matching block exists -> append at the end of the file
 *
 * Non-rule content (plain Markdown, other comments, etc.) is preserved.
 * A fresh (empty) file gets no leading blank line; appended blocks are
 * separated from preceding content by exactly one blank line.
 *
 * @param {string} existing  — current file content
 * @param {string} ruleName — rule name embedded in comment markers
 * @param {string} newBlock — full comment marker block string
 * @returns {string}
 */
function upsertRule(existing, ruleName, newBlock) {
  const esc = escapeRegex(ruleName);
  const re = new RegExp(`<!-- rule-${esc}:start -->[\\s\\S]*?<!-- rule-${esc}:end -->`, "g");

  if (re.test(existing)) {
    return existing.replace(re, newBlock);
  }

  // Append at end. Empty file -> no leading blank; otherwise ensure exactly
  // one blank line between the new block and any preceding content.
  if (existing === "") return newBlock + "\n";
  const sep = existing.endsWith("\n") ? (existing.endsWith("\n\n") ? "" : "\n") : "\n\n";
  return existing + sep + newBlock + "\n";
}

/**
 * Remove a <!-- rule-{name}:start/end --> block by name and normalize blank lines.
 *
 * After removal: 3+ consecutive newlines collapse to exactly one blank line
 * (\n\n), leading blank lines are stripped, the file ends with a single
 * newline, and an all-empty result returns "".
 *
 * The invariant kept across operations is: any two adjacent comment blocks
 * are separated by exactly one blank line, the first block has no leading
 * blank line, and the file ends with a single newline.
 *
 * @param {string} existing
 * @param {string} ruleName
 * @returns {string}
 */
function deleteRule(existing, ruleName) {
  const esc = escapeRegex(ruleName);
  const re = new RegExp(`<!-- rule-${esc}:start -->[\\s\\S]*?<!-- rule-${esc}:end -->`, "g");
  let out = existing.replace(re, "");
  // Collapse runs of 3+ newlines (from the gap left by the removed block)
  // down to a single blank line.
  out = out.replace(/\n{3,}/g, "\n\n");
  // No leading blank line before the first remaining content.
  out = out.replace(/^\n+/, "");
  // Single trailing newline; empty -> "".
  out = out.replace(/\n+$/, "");
  return out === "" ? "" : out + "\n";
}

/**
 * Migrate old <rule name="X">…</rule> XML blocks to comment markers.
 *
 * - name attribute values are XML-entity-unescaped (&amp; -> & etc.)
 * - body content is preserved exactly (including surrounding newlines)
 * - idempotent: input already in comment format is unchanged (regex only
 *   matches `<rule` open tags)
 *
 * @param {string} content
 * @returns {string}
 */
function migrateXmlToComments(content) {
  return content.replace(
    /<rule\s+name="([^"]*)">([\s\S]*?)<\/rule>/g,
    (_match, rawName, body) => {
      const name = unescapeXmlAttr(rawName);
      return `<!-- rule-${name}:start -->${body}<!-- rule-${name}:end -->`;
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sync manifest (state tracking for orphan-rule cleanup)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manifest filename, written in the extension dir (process.cwd()).
 * @type {string}
 */
const MANIFEST_FILE = ".ruler-manifest.json";

/**
 * Read the sync manifest from a directory.
 * Returns {} on missing file or corrupt JSON (treat as fresh start).
 *
 * @param {string} extDir  — extension directory (usually process.cwd())
 * @returns {Record<string, any>}
 */
function readManifest(extDir) {
  try {
    const data = require("fs").readFileSync(
      require("path").join(extDir, MANIFEST_FILE),
      "utf8"
    );
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write the sync manifest to a directory with a timestamp.
 *
 * @param {string} extDir
 * @param {Record<string, any>} manifest
 */
function writeManifest(extDir, manifest) {
  manifest["_updated_at"] = new Date().toISOString();
  require("fs").writeFileSync(
    require("path").join(extDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Derive the source root directory from SS_SRC_PATH and SS_REL_PATH.
 *
 * SS_SRC_PATH = /home/user/extras/rules/sub/file.md
 * SS_REL_PATH = sub/file.md
 * -> sourceRoot = /home/user/extras/rules
 *
 * Falls back to path.dirname(srcPath) if the suffix doesn't match.
 * Returns "" if srcPath is empty.
 *
 * @param {string} srcPath  — value of SS_SRC_PATH
 * @param {string} relPath  — value of SS_REL_PATH
 * @returns {string}
 */
function findSourceRoot(srcPath, relPath) {
  if (!srcPath) return "";
  const normSrc = srcPath.replace(/\\/g, "/");
  const normRel = (relPath || "").replace(/\\/g, "/");
  if (normRel && normSrc.endsWith(normRel)) {
    return normSrc.slice(0, normSrc.length - normRel.length).replace(/\/+$/, "");
  }
  return require("path").dirname(srcPath);
}

/**
 * Recursively list all .md files under sourceRoot as normalized ('/')
 * relative paths. Used by GC to detect deleted stubs.
 *
 * Skips .git directories. Returns null if sourceRoot is empty or
 * unreadable (GC is skipped in that case).
 *
 * @param {string} sourceRoot
 * @returns {Set<string>|null}
 */
function listStubs(sourceRoot) {
  if (!sourceRoot) return null;
  const fs = require("fs");
  const path = require("path");
  const stubs = new Set();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        stubs.add(path.relative(sourceRoot, full).replace(/\\/g, "/"));
      }
    }
  }
  try {
    walk(sourceRoot);
  } catch {
    return null;
  }
  return stubs;
}

/**
 * Compute rule names present in oldNames but absent from enabledNames.
 * These are "stale" — previously injected but no longer active — and
 * should be deleted from output files.
 *
 * @param {string[]} oldNames      — rules recorded in the manifest
 * @param {string[]} enabledNames  — rules that should exist now
 * @returns {string[]}
 */
function diffRuleNames(oldNames, enabledNames) {
  if (!Array.isArray(oldNames) || oldNames.length === 0) return [];
  const enabled = new Set(enabledNames);
  return oldNames.filter((n) => !enabled.has(n));
}

// ═══════════════════════════════════════════════════════════════════════════
// Enable classification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decide whether a rule is enabled given the top-level and per-entry
 * `enable` values.
 *
 * A per-entry value overrides the top-level. The zero-dependency YAML
 * parser yields string values, so only the string "false" (strictly) means
 * disabled; "true", undefined, or any other value means enabled.
 *
 * @param {string|undefined} topEnable
 * @param {string|undefined} entryEnable
 * @returns {boolean}
 */
function isEnabled(topEnable, entryEnable) {
  const effective = entryEnable !== undefined ? entryEnable : topEnable;
  return effective !== "false";
}

/**
 * Derive the rule name for the stub's local body content.
*
* Priority: frontmatter `name` -> filename stem of SS_REL_PATH ->
 * "local-rule".
 *
 * @param {Record<string, any>} fm
 * @param {string} relPath  — value of SS_REL_PATH (may be "")
 * @returns {string}
 */
function deriveLocalName(fm, relPath) {
  if (fm && fm.name) return fm.name;
  if (relPath) {
    return require("path").basename(relPath, require("path").extname(relPath));
  }
  return "local-rule";
}

/**
 * Split the stub's rules into enabled (to download/upsert) and disabled
 * (to delete) based on the `enable` cascade.
 *
 * - Remote `urls`: per-url `enable` overrides top-level; disabled urls are
 *   NOT downloaded (zero network) and their names are returned for deletion.
 * - Local body: follows the top-level `enable` only (no per-entry knob);
 *   when disabled its name is also returned for deletion.
 *
 * @param {string|undefined}    topEnable
 * @param {any[]}               urls
 * @param {string}              localName
 * @param {string}              body
 * @returns {{remoteEnabled: Array<{name:string, url:string}>, localEnabled: boolean, disabledNames: string[]}}
 */
function classifyRules(topEnable, urls, localName, body) {
  const remoteEnabled = [];
  const disabledNames = [];

  const list = Array.isArray(urls) ? urls : [];
  for (const entry of list) {
    if (!entry || !entry.url) continue;
    const name =
      entry.name ||
      require("path").basename(entry.url, require("path").extname(entry.url));
    if (isEnabled(topEnable, entry.enable)) {
      remoteEnabled.push({ name: name, url: entry.url });
    } else {
      disabledNames.push(name);
    }
  }

  const localEnabled = body ? isEnabled(topEnable, undefined) : false;
  if (body && !localEnabled) disabledNames.push(localName);

  return { remoteEnabled: remoteEnabled, localEnabled: localEnabled, disabledNames: disabledNames };
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
 *   Project mode: SS_TARGET_DIR = /abs/path/to/project/.skillshare/extensions/...
 *                 -> everything before "/.skillshare/" is the project root
 *   Global mode:  SS_TARGET_DIR = ~/.config/skillshare/extensions/...
 *                 -> no ".skillshare/" in path -> fall back to $HOME
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
  // -- 1. Read stdin --
  const input = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    // Normalize CRLF -> LF on read. The whole extension assumes LF: the
    // comment marker block format, the upsert/delete invariants, and deleteRule's
    // blank-line regex are all expressed in \n. Windows-authored stubs
    // arrive as CRLF; normalizing here keeps frontmatter parsing, the local
    // body, and the downstream output consistent. Existing output files
    // are normalized on read too (see step 6).
    process.stdin.on("end", () => resolve(data.replace(/\r\n/g, "\n")));
  });

  // -- 2. Parse frontmatter --
  const fmMatch = input.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
  const fmRaw = fmMatch ? fmMatch[1] : "";
  const fm = parseYamlSubset(fmRaw);
  const body = (fmMatch ? fmMatch[2] : input).trim();

  // -- 3. Classify rules by enable state --
  // Disabled rules are not downloaded (zero-network). Their deletion is
  // handled by the manifest diff below (not in enabledNames -> stale).
  // disabledNames is kept as a fallback for pre-manifest migration.
  const classified = classifyRules(
    fm.enable,
    fm.urls,
   deriveLocalName(fm, process.env.SS_REL_PATH || ""),
   body
  );

  // -- 3b. Manifest: read, GC deleted stubs, diff current stub --
  const extDir = process.cwd();
  const manifest = readManifest(extDir);
  const targetKey = (process.env.SS_TARGET_DIR || "_default").replace(/\\/g, "/");
  const stubKey = (process.env.SS_REL_PATH || "").replace(/\\/g, "/");
  if (!manifest[targetKey]) manifest[targetKey] = {};
  const targetEntry = manifest[targetKey];

  // GC: detect stubs whose source files no longer exist.
  const sourceRoot = findSourceRoot(
    process.env.SS_SRC_PATH || "",
    process.env.SS_REL_PATH || ""
  );
  const existingStubs = listStubs(sourceRoot);
  if (existingStubs) {
    for (const oldStub of Object.keys(targetEntry)) {
      if (oldStub === stubKey) continue; // current stub handled by diff
      if (!existingStubs.has(oldStub)) {
       const entry = targetEntry[oldStub];
        for (const outPath of entry.outputs || []) {
         let content = "";
          try {
            content = require("fs").readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
         } catch {
           continue; // output file gone, nothing to clean
         }
          content = migrateXmlToComments(content);
         for (const name of entry.rules || []) {
            content = deleteRule(content, name);
          }
          require("fs").writeFileSync(outPath, content, "utf8");
        }
        delete targetEntry[oldStub];
      }
    }
  }

  // Per-stub diff: old rule names no longer in the current enabled set.
  const oldEntry = targetEntry[stubKey];
  const oldNames = oldEntry ? oldEntry.rules || [] : [];
  const enabledNames = classified.remoteEnabled.map((r) => r.name);
  if (classified.localEnabled) {
    enabledNames.push(deriveLocalName(fm, process.env.SS_REL_PATH || ""));
  }
  const staleNames = diffRuleNames(oldNames, enabledNames);
  const namesToDelete = [...new Set([...classified.disabledNames, ...staleNames])];

  // -- 4. Download enabled remote rules (concurrent, fault-tolerant) --
  /** @type {{name:string, content:string}[]} */
  const rules = [];
  if (classified.remoteEnabled.length > 0) {
    const downloadResults = await runLimited(
      classified.remoteEnabled.map((t) => () => fetchUrl(t.url)),
      FETCH_CONCURRENCY
    );

    for (let i = 0; i < classified.remoteEnabled.length; i++) {
      const t = classified.remoteEnabled[i];
      const r = downloadResults[i];
      if (r && r.value !== undefined) {
        rules.push({ name: t.name, content: r.value });
      } else {
        process.stderr.write(
          "ruler: failed to fetch " + t.url + (r && r.error ? ": " + r.error : "") + "\n"
        );
      }
    }
  }

  // Local body is appended after all remote rules so a same-named local
  // rule overrides its remote counterpart (closer source, higher priority).
  if (classified.localEnabled) {
    rules.push({ name: deriveLocalName(fm, process.env.SS_REL_PATH || ""), content: body });
  }

  // -- 5. Resolve output paths --
  const tmplOutputs = fm.outputs && fm.outputs.length > 0 ? fm.outputs : null;
  const outputs = tmplOutputs || ["AGENTS.md", "CLAUDE.md"];
  const projectRoot = findProjectRoot(process.env.SS_TARGET_DIR || "");
  const outputPaths = resolveOutputs(outputs, projectRoot);

  // -- 6. Per output file: delete stale + disabled, then upsert enabled --
  for (const outPath of outputPaths) {
    let existed = true;
    let existing = "";
    try {
      // Normalize on read: existing AGENTS.md/CLAUDE.md may use CRLF
      // (Windows-authored or editor-converted). The merge invariants
      // assume LF and deleteRule's blank-line regex only matches \n, so
      // CRLF would both leak mixed endings into the output and silently
      // break blank-line normalization on delete.
      existing = require("fs").readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
   } catch {
     // File does not exist yet — start fresh.
     existed = false;
   }

    // Migrate old <rule name="X">…</rule> blocks to comment markers before
    // any delete/upsert so stale deletions work on the migrated content.
    existing = migrateXmlToComments(existing);

   for (const name of namesToDelete) {
      existing = deleteRule(existing, name);
    }
    for (const rule of rules) {
      existing = upsertRule(existing, rule.name, makeRuleBlock(rule.name, rule.content));
    }

    // Skip writing a spurious empty file when nothing existed, nothing was
    // injected, and all that happened was (no-op) deletes.
    const shouldWrite = existing !== "" || rules.length > 0 || existed;
    if (!shouldWrite) continue;

    require("fs").mkdirSync(require("path").dirname(outPath), { recursive: true });
    require("fs").writeFileSync(outPath, existing, "utf8");
  }

  // -- 7. Update manifest with current stub's state --
  targetEntry[stubKey] = { outputs: outputPaths, rules: enabledNames };
  writeManifest(extDir, manifest);

  // stdout intentionally empty — skillshare writes a zero-byte placeholder
  // into the dummy target directory, which .gitignore suppresses.
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write("ruler: " + (err && err.message ? err.message : String(err)) + "\n");
    process.exit(1);
  });
}

// Pure helpers exported for test-ruler.js so tests exercise the real
// implementation rather than a divergent copy.
module.exports = {
  parseYamlSubset,
  parseYamlArray,
  escapeXmlAttr,
  escapeRegex,
  makeRuleBlock,
  upsertRule,
 deleteRule,
 migrateXmlToComments,
 isEnabled,
  deriveLocalName,
  classifyRules,
  findProjectRoot,
  resolveOutputs,
  homeDir,
  readManifest,
  writeManifest,
  findSourceRoot,
  listStubs,
  diffRuleNames,
};

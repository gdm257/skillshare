#!/usr/bin/env node
/**
 * Quick smoke test for the ruler extension.
 * Tests frontmatter parsing, XML upsert, and project root detection
 * WITHOUT network access (URL fetching is mocked).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Helpers extracted from convert.js ──

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
      result[key] = (function parseArray(lines, start) {
        const items = [];
        let i = start;
        while (i < lines.length) {
          const l = lines[i];
          const t = l.trim();
          if (!t || !l.startsWith(" ")) break;
          if (t.startsWith("- ")) {
            const c = t.slice(2).trim();
            const om = c.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
            if (om) {
              const obj = {};
              obj[om[1]] = om[2].replace(/^["']|["']$/g, "").trim();
              const bi = l.search(/\S/);
              i++;
              while (i < lines.length) {
                const cl = lines[i];
                const ct = cl.trim();
                const ci = cl.search(/\S/);
                if (ci <= bi || ct.startsWith("- ")) break;
                const sm = ct.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
                if (sm) obj[sm[1]] = sm[2].replace(/^["']|["']$/g, "").trim();
                i++;
              }
              items.push(obj);
            } else {
              items.push(c);
              i++;
            }
          } else {
            i++;
          }
        }
        return items;
      })(lines, i);
      while (i < lines.length && lines[i].startsWith(" ")) i++;
    }
  }
  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRuleBlock(name, content) {
  return '<rule name="' + name + '">\n' + content.trim() + '\n</rule>';
}

function upsertRule(existing, ruleName, newBlock) {
  const re = new RegExp('<rule\\s+name="' + escapeRegex(ruleName) + '">[\\s\\S]*?<\\/rule>', "g");
  if (re.test(existing)) {
    return existing.replace(re, newBlock);
  }
  const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
  return existing + separator + newBlock + "\n";
}

// Mirrors convert.js: HOME -> USERPROFILE -> HOMEDRIVE+HOMEPATH
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

function findProjectRoot(targetDir) {
  const abs = targetDir ? path.resolve(targetDir) : "";
  if (!abs) return homeDir() || process.cwd();
  const marker = path.sep + ".skillshare" + path.sep;
  const idx = abs.indexOf(marker);
  if (idx !== -1) return abs.slice(0, idx);
  return homeDir() || process.cwd();
}

// ── Tests ──

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log("  [PASS] " + msg);
    passed++;
  } else {
    console.log("  [FAIL] " + msg);
    failed++;
  }
}

// Test 1: YAML parser
console.log("\n=== YAML Parser ===");

var fm1 = [
  "urls:",
  "  - name: code-review",
  "    url: https://example.com/a.md",
  "  - name: security",
  "    url: https://example.com/b.md",
  "outputs:",
  "  - AGENTS.md",
  "  - CLAUDE.md"
].join("\n");

var parsed = parseYamlSubset(fm1);
assert(Array.isArray(parsed.urls), "urls is an array");
assert(parsed.urls.length === 2, "urls has 2 items");
assert(parsed.urls[0].name === "code-review", "first url name");
assert(parsed.urls[0].url === "https://example.com/a.md", "first url value");
assert(parsed.urls[1].name === "security", "second url name");
assert(parsed.urls[1].url === "https://example.com/b.md", "second url value");
assert(Array.isArray(parsed.outputs), "outputs is an array");
assert(parsed.outputs.length === 2, "outputs has 2 items");
assert(parsed.outputs[0] === "AGENTS.md", "first output");
assert(parsed.outputs[1] === "CLAUDE.md", "second output");

// Test 2: YAML parser with defaults (no urls)
var fm2 = "name: empty-stub";
var parsed2 = parseYamlSubset(fm2);
assert(parsed2.urls === undefined, "no urls key when absent");
assert(parsed2.name === "empty-stub", "simple key preserved");

// Test 3: makeRuleBlock
console.log("\n=== makeRuleBlock ===");
var block = makeRuleBlock("test-rule", "Do something\nGreat!");
assert(block.indexOf('<rule name="test-rule">') === 0, "starts with opening tag");
assert(block.indexOf("</rule>") === block.length - 7, "ends with closing tag");
assert(block.indexOf("Do something") !== -1, "includes content");
assert(block.indexOf("Great!") !== -1, "includes all content");

// Test 4: upsertRule - replace
console.log("\n=== upsertRule (replace) ===");
var existing1 = [
  "# AGENTS",
  "",
  "Manual content.",
  "",
  '<rule name="code-review">',
  "Old content",
  "</rule>",
  "",
  "More text."
].join("\n");
var newBlock1 = '<rule name="code-review">\nNew content\n</rule>';
var result1 = upsertRule(existing1, "code-review", newBlock1);
assert(result1.indexOf("New content") !== -1, "replaced content is present");
assert(result1.indexOf("Old content") === -1, "old content is gone");
assert(result1.indexOf("Manual content") !== -1, "non-rule content preserved");
assert(result1.indexOf("More text.") !== -1, "non-rule content after rule preserved");

// Test 5: upsertRule - append
console.log("\n=== upsertRule (append) ===");
var existing2 = "# AGENTS\n\nManual content.";
var newBlock2 = '<rule name="new-rule">\nNew stuff\n</rule>';
var result2 = upsertRule(existing2, "new-rule", newBlock2);
assert(result2.indexOf("New stuff") !== -1, "new rule content present");
assert(result2.indexOf("Manual content") !== -1, "existing content preserved");
assert(result2.indexOf("</rule>") === result2.length - 8, "new rule at end");

// Test 6: findProjectRoot
console.log("\n=== findProjectRoot ===");
var sep = path.sep;
var fakeProjectRoot = path.resolve(sep + "tmp" + sep + "test-project");
var projectMode = findProjectRoot(path.join(fakeProjectRoot, ".skillshare", "extensions", "ruler", "dummy"));
assert(projectMode === fakeProjectRoot, "project mode detects .skillshare/ boundary");

var fakeGlobalRoot = homeDir() || process.cwd();
var globalMode = findProjectRoot(path.join(fakeGlobalRoot, ".config", "skillshare", "extensions", "ruler", "dummy"));
assert(globalMode === fakeGlobalRoot, "global mode falls back to HOME");

var emptyTarget = findProjectRoot("");
assert(emptyTarget === fakeGlobalRoot, "empty target falls back to HOME");

// Test 6b: homeDir + resolveOutputs (~ expansion, Windows-safe)
// On Windows process.env.HOME is unset; the home lives in USERPROFILE.
// A bare HOME lookup would yield "" and turn "~/.codex/AGENTS.md" into a
// drive-root-relative path. We assert USERPROFILE is consulted.
console.log("\n=== resolveOutputs (~ expansion) ===");
function resolveOutputs(outputs, projectRoot) {
  var home = homeDir();
  return outputs.map(function (out) {
    if (out[0] === "~") return path.join(home, out.slice(1));
    if (path.isAbsolute(out)) return out;
    return path.join(projectRoot, out);
  });
}
var savedHOME = process.env.HOME;
var savedUSERPROFILE = process.env.USERPROFILE;
process.env.HOME = "";
process.env.USERPROFILE = path.resolve(sep + "Users" + sep + "demo");
var tildeResolved = resolveOutputs(
  ["~/.codex/AGENTS.md", "~/.claude/rules/artifacts.md", "AGENTS.md"],
  "/some/project"
);
assert(tildeResolved[0] === path.join(process.env.USERPROFILE, ".codex", "AGENTS.md"), "~ expands under USERPROFILE when HOME unset");
assert(tildeResolved[1] === path.join(process.env.USERPROFILE, ".claude", "rules", "artifacts.md"), "~ nested path expands under USERPROFILE");
assert(tildeResolved[2] === path.join("/some/project", "AGENTS.md"), "relative output stays under project root");
process.env.HOME = savedHOME;
process.env.USERPROFILE = savedUSERPROFILE;

// Test 7: Special chars in name
console.log("\n=== Special characters ===");
var blockSpecial = makeRuleBlock("my-rule-1", "Content <with> brackets & stuff");
assert(blockSpecial.indexOf('name="my-rule-1"') !== -1, "rule name preserved");

// Test 8: Empty frontmatter
console.log("\n=== Empty/Edge cases ===");
var parsedEmpty = parseYamlSubset("");
assert(Object.keys(parsedEmpty).length === 0, "empty string yields empty object");

var parsedNoFm = parseYamlSubset("just some text\nno frontmatter here");
assert(Object.keys(parsedNoFm).length === 0, "no frontmatter yields empty object");

// Test 9: upsert with no existing content
console.log("\n=== Fresh file (empty existing) ===");
var fresh = upsertRule("", "my-rule", '<rule name="my-rule">\ncontent\n</rule>');
assert(fresh === '<rule name="my-rule">\ncontent\n</rule>\n', "fresh file gets rule with trailing newline");

// Test 10: Local rules from body content
console.log("\n=== Local rules (body only) ===");

// Simulate a stub with body content and no urls
var stubWithBody = [
  "---",
  "name: my-local-rule",
  "---",
  "This is the local rule content.",
  "",
  "It has multiple lines."
].join("\n");

var bodyMatch = stubWithBody.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
var bodyContent = bodyMatch ? bodyMatch[2].trim() : stubWithBody.trim();
assert(bodyContent === "This is the local rule content.\n\nIt has multiple lines.", "body extracted correctly");

var fmLocal = parseYamlSubset(bodyMatch ? bodyMatch[1] : "");
assert(fmLocal.name === "my-local-rule", "frontmatter name extracted");

// Test 11: Stub with no frontmatter at all (bare text)
console.log("\n=== Raw Markdown (no frontmatter) ===");
var rawMd = "# Just some rules\n\nRule content here.";
var rawMatch = rawMd.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
// No --- markers, so no match
assert(rawMatch === null, "no frontmatter match for raw markdown");

// Test 12: Combined urls + body
console.log("\n=== Combined urls + body ===");
var combined = [
  "---",
  "urls:",
  "  - name: remote-rule",
  "    url: https://example.com/remote.md",
  "---",
  "Local body content here."
].join("\n");
var combinedMatch = combined.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
assert(combinedMatch !== null, "combined frontmatter matched");
var combinedFm = parseYamlSubset(combinedMatch[1]);
var combinedBody = combinedMatch[2].trim();
assert(Array.isArray(combinedFm.urls), "combined has urls array");
assert(combinedFm.urls.length === 1, "combined has 1 url");
assert(combinedBody === "Local body content here.", "combined body extracted");

// Summary
console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);

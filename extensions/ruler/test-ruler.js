#!/usr/bin/env node
/**
 * Offline smoke test for the ruler extension.
 *
 * Imports the REAL helpers from convert.js (no divergent copies) and
 * exercises frontmatter parsing, comment block construction, upsert/delete
 * logic, enable cascade, delete normalization, old-format migration,
 * mixed delete+upsert ordering, and the round-trip invariant — with
 * NO network access.
 *
 * Run: node extensions/ruler/test-ruler.js
 */

"use strict";

const path = require("path");
const C = require("./convert.js");

// ── Tiny assert harness ──

let passed = 0;
let failed = 0;

/** @param {boolean} condition @param {string} msg */
function assert(condition, msg) {
  if (condition) {
    console.log("  [PASS] " + msg);
    passed++;
  } else {
    console.log("  [FAIL] " + msg);
    failed++;
  }
}

// Suppress the stderr warning makeRuleBlock emits for the one </rule>
// content-conflict test so the test output stays readable.
let _origStderr;

// ════════════════════════════════════════════════════════════════════════════
// YAML parser
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== YAML Parser ===");

const fm1 = [
  "urls:",
  "  - name: code-review",
  "    url: https://example.com/a.md",
  "  - name: security",
  "    url: https://example.com/b.md",
  "outputs:",
  "  - AGENTS.md",
  "  - CLAUDE.md",
].join("\n");

const parsed = C.parseYamlSubset(fm1);
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

// defaults / missing keys
const parsed2 = C.parseYamlSubset("name: empty-stub");
assert(parsed2.urls === undefined, "no urls key when absent");
assert(parsed2.name === "empty-stub", "simple key preserved");

const parsedEmpty = C.parseYamlSubset("");
assert(Object.keys(parsedEmpty).length === 0, "empty string yields empty object");

const parsedNoFm = C.parseYamlSubset("just some text\nno frontmatter here");
assert(Object.keys(parsedNoFm).length === 0, "no frontmatter yields empty object");

// enable field parsing (top-level + per-url)
const fmEnable = C.parseYamlSubset(
  [
    "enable: false",
    "urls:",
    "  - name: a",
    "    url: https://example.com/a.md",
    "  - name: b",
    "    url: https://example.com/b.md",
    "    enable: true",
  ].join("\n")
);
assert(fmEnable.enable === "false", "top-level enable parsed as string");
assert(fmEnable.urls[0].enable === undefined, "url a has no per-entry enable");
assert(fmEnable.urls[1].enable === "true", "url b has per-entry enable true");

// ════════════════════════════════════════════════════════════════════════════
// makeRuleBlock
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== makeRuleBlock ===");

const block = C.makeRuleBlock("test-rule", "Do something\nGreat!");
assert(block.indexOf("<!-- rule-test-rule:start -->") === 0, "starts with start marker");
assert(block.indexOf("<!-- rule-test-rule:end -->") === block.length - ("<!-- rule-test-rule:end -->").length, "ends with end marker");
assert(block.indexOf("Do something") !== -1, "includes content");
assert(block.indexOf("Great!") !== -1, "includes all content");

// Name is embedded directly in comment markers (no XML escaping needed)
const blockRaw = C.makeRuleBlock('a&b"c', "body");
assert(blockRaw.indexOf("<!-- rule-a&b\"c:start -->") !== -1, "name embedded raw in start marker");
assert(blockRaw.indexOf("<!-- rule-a&b\"c:end -->") !== -1, "name embedded raw in end marker");

// end-marker string in content -> warning (still emitted)
_origStderr = process.stderr.write.bind(process.stderr);
let warned = false;
process.stderr.write = (s) => {
  if (String(s).indexOf("end marker") !== -1) warned = true;
  return true;
};
const blockConflict = C.makeRuleBlock("r", "x\n<!-- rule-r:end -->\ny");
process.stderr.write = _origStderr;
assert(warned, "warns when content contains end marker");
assert(blockConflict.indexOf("<!-- rule-r:end -->") !== -1, "block still written despite conflict");

// Name containing "--" -> warning (HTML comment hazard)
_origStderr = process.stderr.write.bind(process.stderr);
let nameWarned = false;
process.stderr.write = (s) => {
  if (String(s).indexOf("a--b") !== -1) nameWarned = true;
  return true;
};
const blockDash = C.makeRuleBlock("a--b", "body");
process.stderr.write = _origStderr;
assert(nameWarned, "warns when name contains --");
assert(blockDash.indexOf("<!-- rule-a--b:start -->") !== -1, "block still written despite name warning");

// ════════════════════════════════════════════════════════════════════════════
// upsertRule
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== upsertRule ===");

// replace existing
const existing1 = [
  "# AGENTS",
  "",
  "Manual content.",
  "",
  "<!-- rule-code-review:start -->",
  "Old content",
  "<!-- rule-code-review:end -->",
  "",
  "More text.",
].join("\n");
const newBlock1 = "<!-- rule-code-review:start -->\nNew content\n<!-- rule-code-review:end -->";
const result1 = C.upsertRule(existing1, "code-review", newBlock1);
assert(result1.indexOf("New content") !== -1, "replaced content is present");
assert(result1.indexOf("Old content") === -1, "old content is gone");
assert(result1.indexOf("Manual content.") !== -1, "non-rule content preserved");
assert(result1.indexOf("More text.") !== -1, "non-rule content after rule preserved");

// append to non-empty
const existing2 = "# AGENTS\n\nManual content.";
const newBlock2 = "<!-- rule-new-rule:start -->\nNew stuff\n<!-- rule-new-rule:end -->";
const result2 = C.upsertRule(existing2, "new-rule", newBlock2);
assert(result2.indexOf("New stuff") !== -1, "new rule content present");
assert(result2.indexOf("Manual content.") !== -1, "existing content preserved");
assert(result2.endsWith("<!-- rule-new-rule:end -->\n"), "new rule at end");

// fresh file: NO leading blank line, single trailing newline (fixed)
const fresh = C.upsertRule("", "my-rule", "<!-- rule-my-rule:start -->\ncontent\n<!-- rule-my-rule:end -->");
assert(fresh === "<!-- rule-my-rule:start -->\ncontent\n<!-- rule-my-rule:end -->\n", "fresh file: block + single newline, no leading blank");

// ════════════════════════════════════════════════════════════════════════════
// Enable cascade (isEnabled) — 8 cases
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== enable cascade (8 cases) ===");

assert(C.isEnabled(undefined, undefined) === true, "1 default (no flags) -> enabled");
assert(C.isEnabled("false", undefined) === false, "2 top false -> disabled");
assert(C.isEnabled("false", "true") === true, "3 per-url true overrides top false");
assert(C.isEnabled(undefined, "false") === false, "4 per-url false disables");
assert(C.isEnabled("true", "false") === false, "5 per-url false overrides top true");
assert(C.isEnabled("false", "false") === false, "6 both false -> disabled");
assert(C.isEnabled("true", "true") === true, "7 both true -> enabled");
assert(C.isEnabled("false", "maybe") === true, "8 non-'false' string -> enabled");

// ════════════════════════════════════════════════════════════════════════════
// deleteRule normalization — 6 cases
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== deleteRule normalization (6 cases) ===");

// Build a clean 3-block file via upsert so spacing mirrors reality.
const A = C.makeRuleBlock("a", "A content");
const B = C.makeRuleBlock("b", "B content");
const BLK_C = C.makeRuleBlock("c", "C content");
let file3 = "";
file3 = C.upsertRule(file3, "a", A);
file3 = C.upsertRule(file3, "b", B);
file3 = C.upsertRule(file3, "c", BLK_C);

// delete middle -> 1 blank line between survivors
assert(
  C.deleteRule(file3, "b") === A + "\n\n" + BLK_C + "\n",
  "delete middle: A and C separated by exactly 1 blank line"
);
// delete first -> starts with B, no leading blank
assert(
  C.deleteRule(file3, "a") === B + "\n\n" + BLK_C + "\n",
  "delete first: no leading blank line"
);
// delete last -> ends with B + single newline
assert(
  C.deleteRule(file3, "c") === A + "\n\n" + B + "\n",
  "delete last: single trailing newline"
);
// delete all (sequentially) -> ""
let allGone = file3;
for (const n of ["a", "b", "c"]) allGone = C.deleteRule(allGone, n);
assert(allGone === "", "delete all: result is empty string");
// delete with hand-written header -> header preserved, clean tail
const headerFile = "# AGENTS\n\n" + A + "\n";
assert(
  C.deleteRule(headerFile, "a") === "# AGENTS\n",
  "delete with header: header preserved, no trailing blank"
);
// delete non-existent -> unchanged
assert(C.deleteRule(file3, "zzz") === file3, "delete non-existent: file unchanged");

// ════════════════════════════════════════════════════════════════════════════
// classifyRules — zero network for disabled rules
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== classifyRules (enable -> zero network) ===");

// all disabled: nothing to download (zero network), both names queued for deletion
const fmAll = C.parseYamlSubset(
  [
    "enable: false",
    "urls:",
    "  - name: a",
    "    url: https://example.com/a.md",
    "  - name: b",
    "    url: https://example.com/b.md",
  ].join("\n")
);
const clsAll = C.classifyRules(fmAll.enable, fmAll.urls, "stub", "");
assert(clsAll.remoteEnabled.length === 0, "all-disabled: no remote to download (zero network)");
assert(clsAll.disabledNames.length === 2, "all-disabled: both names marked for deletion");
assert(clsAll.localEnabled === false, "all-disabled: local disabled");

// partial: top false, b overrides true -> only b is downloaded
const fmPart = C.parseYamlSubset(
  [
    "enable: false",
    "urls:",
    "  - name: a",
    "    url: https://example.com/a.md",
    "  - name: b",
    "    url: https://example.com/b.md",
    "    enable: true",
  ].join("\n")
);
const clsPart = C.classifyRules(fmPart.enable, fmPart.urls, "stub", "");
assert(clsPart.remoteEnabled.length === 1, "partial: only one remote enabled");
assert(clsPart.remoteEnabled[0].name === "b", "partial: enabled remote is b");
assert(
  clsPart.disabledNames.length === 1 && clsPart.disabledNames[0] === "a",
  "partial: a queued for deletion"
);

// local body follows top-level enable only
const clsLocalOff = C.classifyRules("false", [], "my-local", "body text");
assert(clsLocalOff.localEnabled === false, "local body disabled by top-level false");
assert(
  clsLocalOff.disabledNames.length === 1 && clsLocalOff.disabledNames[0] === "my-local",
  "local body name queued for deletion when disabled"
);
const clsLocalOn = C.classifyRules(undefined, [], "my-local", "body text");
assert(clsLocalOn.localEnabled === true, "local body enabled when top-level unset");

// ════════════════════════════════════════════════════════════════════════════
// Mixed delete + upsert ordering (single sync: delete-all, then upsert-all)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== mixed delete + upsert ordering ===");

// File holds old A and old B; disable B, re-upsert A (new content).
let mix = C.upsertRule("", "a", C.makeRuleBlock("a", "old A"));
mix = C.upsertRule(mix, "b", C.makeRuleBlock("b", "old B"));
// mirror main()'s per-file order: delete disabled, then upsert enabled
mix = C.deleteRule(mix, "b");
mix = C.upsertRule(mix, "a", C.makeRuleBlock("a", "new A"));
assert(mix.indexOf("old B") === -1, "disabled B removed");
assert(mix.indexOf("old A") === -1, "old A replaced by new A");
assert(mix.indexOf("new A") !== -1, "enabled A updated");
assert(mix === C.makeRuleBlock("a", "new A") + "\n", "single clean block remains");

// ════════════════════════════════════════════════════════════════════════════
// Round-trip: false -> delete, true -> restore (invariant preserved)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== enable round-trip ===");

let rt = C.upsertRule("", "rt", C.makeRuleBlock("rt", "original"));
rt = C.deleteRule(rt, "rt"); // disable
assert(rt === "", "round-trip: disable empties the file");
rt = C.upsertRule(rt, "rt", C.makeRuleBlock("rt", "restored")); // re-enable
assert(
  rt === C.makeRuleBlock("rt", "restored") + "\n",
  "round-trip: restore is clean with no leading blank"
);
assert(rt.indexOf("\n\n\n") === -1, "round-trip: no doubled blank lines");

// multi-block round-trip: remove a middle block, invariant still holds
let rtm = C.upsertRule("", "x", C.makeRuleBlock("x", "X"));
rtm = C.upsertRule(rtm, "y", C.makeRuleBlock("y", "Y"));
rtm = C.deleteRule(rtm, "x");
assert(
  rtm === C.makeRuleBlock("y", "Y") + "\n",
  "round-trip multi: x removed, y is clean"
);
assert(rtm.indexOf("\n\n\n") === -1, "round-trip multi: invariant holds");

// ════════════════════════════════════════════════════════════════════════════
// CRLF normalization (LF invariant on read)
// ════════════════════════════════════════════════════════════════════════════
//
// main() normalizes CRLF -> LF on read (stdin AND existing output files),
// so the pure helpers always see LF. These cases mirror that contract:
// normalize first, then exercise upsert/delete and assert the LF invariant
// (no CR, exactly one blank line between blocks, single trailing newline).

console.log("\n=== CRLF normalization (LF invariant on read) ===");

// CRLF existing file, normalized then upserted -> no mixed endings
const crlfSeed = "# AGENTS\r\n\r\n<!-- rule-old:start -->\r\nold body\r\n<!-- rule-old:end -->\r\n";
const lfSeed = crlfSeed.replace(/\r\n/g, "\n");
const upsertOnNormalized = C.upsertRule(lfSeed, "fresh", C.makeRuleBlock("fresh", "new rule"));
assert(upsertOnNormalized.indexOf("\r") === -1, "CRLF->LF upsert: no CR in result");
assert(upsertOnNormalized.indexOf("new rule") !== -1, "CRLF->LF upsert: new block present");
assert(upsertOnNormalized.indexOf("\n\n\n") === -1, "CRLF->LF upsert: no doubled blank lines");
assert(upsertOnNormalized.indexOf("old body") !== -1, "CRLF->LF upsert: old block preserved");

// CRLF three-block file, delete middle after normalization -> regex works
const crlfThree =
  "<!-- rule-a:start -->\nA\n<!-- rule-a:end -->\n\n" +
  "<!-- rule-b:start -->\nB\n<!-- rule-b:end -->\n\n" +
  "<!-- rule-c:start -->\nC\n<!-- rule-c:end -->\n";
const delMid = C.deleteRule(crlfThree, "b");
assert(delMid.indexOf("\r") === -1, "CRLF->LF delete middle: no CR");
assert(
  delMid === "<!-- rule-a:start -->\nA\n<!-- rule-a:end -->\n\n<!-- rule-c:start -->\nC\n<!-- rule-c:end -->\n",
  "CRLF->LF delete middle: survivors separated by exactly 1 blank line"
);

// CRLF header + rule, delete rule after normalization -> header kept, LF only
const crlfHeaderRule = "# Header\r\n\r\n<!-- rule-x:start -->\r\nX\r\n<!-- rule-x:end -->\r\n".replace(/\r\n/g, "\n");
const headerAfterDel = C.deleteRule(crlfHeaderRule, "x");
assert(headerAfterDel === "# Header\n", "CRLF->LF delete with header: header kept, rule gone");
assert(headerAfterDel.indexOf("\r") === -1, "CRLF->LF delete with header: no CR remains");

// Full round-trip: CRLF seed -> normalize -> upsert -> stays LF on re-read
const rtCrlf = "<!-- rule-rt:start -->\r\nv1\r\n<!-- rule-rt:end -->\r\n".replace(/\r\n/g, "\n");
let rtLf = C.upsertRule("", "rt", C.makeRuleBlock("rt", "v1"));
rtLf = C.deleteRule(rtLf, "rt");
assert(rtLf === "", "CRLF->LF round-trip: disable empties file");
rtLf = C.upsertRule(rtLf, "rt", C.makeRuleBlock("rt", "v2"));
assert(rtLf === "<!-- rule-rt:start -->\nv2\n<!-- rule-rt:end -->\n", "CRLF->LF round-trip: restore is clean LF");
assert(rtLf.indexOf("\r") === -1, "CRLF->LF round-trip: final output is pure LF");

// ════════════════════════════════════════════════════════════════════════════
// Project root detection & path resolution
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== findProjectRoot / resolveOutputs ===");

const sep = path.sep;
const fakeProjectRoot = path.resolve(sep + "tmp" + sep + "test-project");
const projectMode = C.findProjectRoot(
  path.join(fakeProjectRoot, ".skillshare", "extensions", "ruler", "dummy")
);
assert(projectMode === fakeProjectRoot, "project mode detects .skillshare/ boundary");

const fakeGlobalRoot = C.homeDir() || process.cwd();
const globalMode = C.findProjectRoot(
  path.join(fakeGlobalRoot, ".config", "skillshare", "extensions", "ruler", "dummy")
);
assert(globalMode === fakeGlobalRoot, "global mode falls back to HOME");
assert(C.findProjectRoot("") === fakeGlobalRoot, "empty target falls back to HOME");

function resolveOutputs(outputs, projectRoot) {
  return C.resolveOutputs(outputs, projectRoot);
}
const savedHOME = process.env.HOME;
const savedUSERPROFILE = process.env.USERPROFILE;
process.env.HOME = "";
process.env.USERPROFILE = path.resolve(sep + "Users" + sep + "demo");
const tildeResolved = resolveOutputs(
  ["~/.codex/AGENTS.md", "~/.claude/rules/artifacts.md", "AGENTS.md"],
  "/some/project"
);
assert(
  tildeResolved[0] === path.join(process.env.USERPROFILE, ".codex", "AGENTS.md"),
  "~ expands under USERPROFILE when HOME unset"
);
assert(
  tildeResolved[1] === path.join(process.env.USERPROFILE, ".claude", "rules", "artifacts.md"),
  "~ nested path expands under USERPROFILE"
);
assert(
  tildeResolved[2] === path.join("/some/project", "AGENTS.md"),
  "relative output stays under project root"
);
process.env.HOME = savedHOME;
process.env.USERPROFILE = savedUSERPROFILE;

// ════════════════════════════════════════════════════════════════════════════
// Stub body extraction (frontmatter parsing helpers)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== stub body / frontmatter extraction ===");

// local rule: frontmatter name overrides filename stem
const stubWithBody = [
  "---",
  "name: my-local-rule",
  "---",
  "This is the local rule content.",
  "",
  "It has multiple lines.",
].join("\n");
const bodyMatch = stubWithBody.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
const bodyContent = bodyMatch ? bodyMatch[2].trim() : stubWithBody.trim();
assert(
  bodyContent === "This is the local rule content.\n\nIt has multiple lines.",
  "body extracted correctly"
);
const fmLocal = C.parseYamlSubset(bodyMatch ? bodyMatch[1] : "");
assert(fmLocal.name === "my-local-rule", "frontmatter name extracted");

// bare markdown (no frontmatter) -> no match
const rawMd = "# Just some rules\n\nRule content here.";
const rawMatch = rawMd.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
assert(rawMatch === null, "no frontmatter match for raw markdown");

// combined urls + body
const combined = [
  "---",
  "urls:",
  "  - name: remote-rule",
  "    url: https://example.com/remote.md",
  "---",
  "Local body content here.",
].join("\n");
const combinedMatch = combined.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
assert(combinedMatch !== null, "combined frontmatter matched");
const combinedFm = C.parseYamlSubset(combinedMatch[1]);
const combinedBody = combinedMatch[2].trim();
assert(Array.isArray(combinedFm.urls), "combined has urls array");
assert(combinedFm.urls.length === 1, "combined has 1 url");
assert(combinedBody === "Local body content here.", "combined body extracted");

// ── Summary ──

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: diffRuleNames (pure)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== diffRuleNames (pure) ===");

assert(
  C.diffRuleNames(["a", "b", "c"], ["a", "c"]).join(",") === "b",
  "diff: b is stale (removed from enabled)"
);
assert(
  C.diffRuleNames(["a"], ["a", "b"]).length === 0,
  "diff: no stale when new rule added"
);
assert(
  C.diffRuleNames([], ["a"]).length === 0,
  "diff: first run (old empty) -> nothing stale"
);
assert(
  C.diffRuleNames(["a", "b"], []).join(",") === "a,b",
  "diff: all stale when nothing enabled"
);
assert(
  C.diffRuleNames(undefined, ["a"]).length === 0,
  "diff: undefined oldNames -> empty"
);

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: findSourceRoot (pure)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== findSourceRoot (pure) ===");

const fs_real = require("fs");
const os_real = require("os");
const tmpDir = fs_real.mkdtempSync(path.join(os_real.tmpdir(), "ruler-test-"));

// Normal case: srcPath ends with relPath (normalized /)
const sr1 = C.findSourceRoot(
  path.join(tmpDir, "extras", "rules", "sub", "file.md"),
  path.join("sub", "file.md")
);
assert(
  sr1 === path.join(tmpDir, "extras", "rules").replace(/\\/g, "/"),
  "findSourceRoot: strips relPath suffix (normalized /)"
);

// Top-level stub
const sr2 = C.findSourceRoot(
  path.join(tmpDir, "extras", "rules", "file.md"),
  "file.md"
);
assert(
  sr2 === path.join(tmpDir, "extras", "rules").replace(/\\/g, "/"),
  "findSourceRoot: top-level stub"
);

// Mismatch -> fallback to dirname
assert(
  C.findSourceRoot("/some/dir/file.md", "other.md") === path.dirname("/some/dir/file.md"),
  "findSourceRoot: fallback to dirname on mismatch"
);

// Empty srcPath
assert(C.findSourceRoot("", "rel.md") === "", "findSourceRoot: empty srcPath -> empty");

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: readManifest / writeManifest (I/O)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== readManifest / writeManifest (I/O) ===");

const manifestDir = path.join(tmpDir, "ext-dir");
fs_real.mkdirSync(manifestDir, { recursive: true });

// Missing manifest -> {}
assert(Object.keys(C.readManifest(manifestDir)).length === 0, "readManifest: missing file -> {}");

// Write + read round-trip
C.writeManifest(manifestDir, {
  "/target/dir": { "stub-a.md": { outputs: ["/abs/AGENTS.md"], rules: ["rule-a"] } },
});
const readBack = C.readManifest(manifestDir);
assert(readBack["/target/dir"]["stub-a.md"].rules[0] === "rule-a", "manifest round-trip");
assert(typeof readBack._updated_at === "string", "manifest has _updated_at");

// Corrupt JSON -> {}
fs_real.writeFileSync(path.join(manifestDir, ".ruler-manifest.json"), "{broken", "utf8");
assert(Object.keys(C.readManifest(manifestDir)).length === 0, "readManifest: corrupt JSON -> {}");

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: listStubs (I/O)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== listStubs (I/O) ===");

const sourceDir = path.join(tmpDir, "source");
fs_real.mkdirSync(path.join(sourceDir, "sub"), { recursive: true });
fs_real.writeFileSync(path.join(sourceDir, "a.md"), "", "utf8");
fs_real.writeFileSync(path.join(sourceDir, "sub", "b.md"), "", "utf8");
fs_real.writeFileSync(path.join(sourceDir, "c.txt"), "", "utf8");
fs_real.mkdirSync(path.join(sourceDir, ".git"), { recursive: true });
fs_real.writeFileSync(path.join(sourceDir, ".git", "ignore.md"), "", "utf8");

const stubs = C.listStubs(sourceDir);
assert(stubs !== null, "listStubs: returns a Set");
assert(stubs.has("a.md"), "listStubs: finds top-level .md");
assert(stubs.has(path.join("sub", "b.md").replace(/\\/g, "/")), "listStubs: finds nested .md (normalized /)");
assert(!stubs.has("c.txt"), "listStubs: skips non-.md");
assert(
  !stubs.has(".git/ignore.md") && !stubs.has(path.join(".git", "ignore.md").replace(/\\/g, "/")),
  "listStubs: skips .git"
);
assert(C.listStubs("") === null, "listStubs: empty sourceRoot -> null");

// ════════════════════════════════════════════════════════════════════════════
// Migration: old <rule name="X">…</rule> → comment markers
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== migrateXmlToComments ===");

// Basic: old XML block → comment markers
const mig1 = C.migrateXmlToComments('<rule name="security-check">\nold content\n</rule>');
assert(
  mig1 === "<!-- rule-security-check:start -->\nold content\n<!-- rule-security-check:end -->",
  "migration: single XML block converted to comment markers"
);

// Body preserved exactly (no trimming)
const mig2 = C.migrateXmlToComments('<rule name="x">\nline1\nline2\n</rule>');
assert(
  mig2 === "<!-- rule-x:start -->\nline1\nline2\n<!-- rule-x:end -->",
  "migration: multi-line body preserved"
);

// Mixed: old XML + existing comment blocks coexist
const mig3 = C.migrateXmlToComments(
  '<rule name="old">\nold body\n</rule>\n\n<!-- rule-new:start -->\nnew body\n<!-- rule-new:end -->'
);
assert(
  mig3.indexOf("<!-- rule-old:start -->") !== -1 &&
    mig3.indexOf("<!-- rule-old:end -->") !== -1,
  "migration: old XML block converted in mixed file"
);
assert(
  mig3.indexOf("<rule ") === -1,
  "migration: no XML tags remain after migration"
);
assert(
  mig3.indexOf("<!-- rule-new:start -->") !== -1 &&
    mig3.indexOf("<!-- rule-new:end -->") !== -1,
  "migration: existing comment blocks unaffected"
);

// Idempotent: pure comment input → unchanged
const pureComments = "<!-- rule-a:start -->\nA\n<!-- rule-a:end -->";
assert(C.migrateXmlToComments(pureComments) === pureComments, "migration: idempotent on comment-only input");

// Empty input
assert(C.migrateXmlToComments("") === "", "migration: empty string unchanged");

// XML entity unescaping in name attribute
const migEntity = C.migrateXmlToComments('<rule name="a&amp;b">body</rule>');
assert(
  migEntity.indexOf("<!-- rule-a&b:start -->") !== -1,
  "migration: &amp; unescaped in name"
);

// Migration enables upsert on old-format files
const migThenUpsert = C.upsertRule(
  C.migrateXmlToComments('<rule name="x">old</rule>'),
  "x",
  C.makeRuleBlock("x", "new content")
);
assert(migThenUpsert.indexOf("new content") !== -1, "migrate + upsert: old block replaced");
assert(migThenUpsert.indexOf("old") === -1, "migrate + upsert: old content gone");

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: GC simulation (deleted stub -> rules cleaned)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== manifest GC simulation ===");

// Inline readOutput helper (was exported, now inlined in convert.js)
function readOutput(p) {
  try { return fs_real.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); } catch { return ""; }
}

// Manifest has stubs A, B, C. Source dir only has A and C (B deleted).
const gcExtDir = path.join(tmpDir, "gc-ext");
fs_real.mkdirSync(gcExtDir, { recursive: true });
const gcSourceDir = path.join(tmpDir, "gc-source");
fs_real.mkdirSync(gcSourceDir, { recursive: true });
fs_real.writeFileSync(path.join(gcSourceDir, "a.md"), "rule A", "utf8");
fs_real.writeFileSync(path.join(gcSourceDir, "c.md"), "rule C", "utf8");

// Create output file with A, B, C rules
const gcOutputDir = path.join(tmpDir, "gc-output");
fs_real.mkdirSync(gcOutputDir, { recursive: true });
const gcOutputPath = path.join(gcOutputDir, "AGENTS.md");
fs_real.writeFileSync(
  gcOutputPath,
  C.makeRuleBlock("rule-a", "A content") + "\n\n" +
  C.makeRuleBlock("rule-b", "B content") + "\n\n" +
  C.makeRuleBlock("rule-c", "C content") + "\n",
  "utf8"
);

// Write manifest with A, B, C
const gcTargetKey = gcOutputDir.replace(/\\/g, "/");
C.writeManifest(gcExtDir, {
  [gcTargetKey]: {
    "a.md": { outputs: [gcOutputPath], rules: ["rule-a"] },
    "b.md": { outputs: [gcOutputPath], rules: ["rule-b"] },
    "c.md": { outputs: [gcOutputPath], rules: ["rule-c"] },
  },
});

// Simulate GC (processing stub "a.md"): B is gone -> delete rule-b
const gcManifest = C.readManifest(gcExtDir);
const gcEntry = gcManifest[gcTargetKey];
const gcStubs = C.listStubs(gcSourceDir);
let gcDeleted = [];
for (const oldStub of Object.keys(gcEntry)) {
  if (oldStub === "a.md") continue;
  if (!gcStubs.has(oldStub)) {
    const e = gcEntry[oldStub];
    for (const outP of e.outputs || []) {
      let content = readOutput(outP);
      for (const name of e.rules || []) { content = C.deleteRule(content, name); gcDeleted.push(name); }
      if (fs_real.existsSync(outP)) fs_real.writeFileSync(outP, content, "utf8");
    }
    delete gcEntry[oldStub];
  }
}
assert(gcDeleted.indexOf("rule-b") !== -1, "GC: deleted rule-b (stub b.md gone)");
assert(gcDeleted.indexOf("rule-a") === -1, "GC: did NOT delete rule-a (stub exists)");
assert(gcDeleted.indexOf("rule-c") === -1, "GC: did NOT delete rule-c (stub exists)");
const gcAfter = readOutput(gcOutputPath);
assert(gcAfter.indexOf("rule-b") === -1, "GC: rule-b block gone from output");
assert(gcAfter.indexOf("rule-a") !== -1, "GC: rule-a preserved");
assert(gcAfter.indexOf("rule-c") !== -1, "GC: rule-c preserved");
assert(gcAfter.indexOf("\n\n\n") === -1, "GC: blank-line invariant");
assert(!gcEntry["b.md"], "GC: b.md removed from manifest");
assert(gcEntry["a.md"] !== undefined && gcEntry["c.md"] !== undefined, "GC: a.md and c.md still in manifest");

// ════════════════════════════════════════════════════════════════════════════
// Sync manifest: enable=false + diff interaction
// ════════════════════════════════════════════════════════════════════════════

console.log("\n=== enable=false + manifest diff ===");

// Manifest had ["a","b"]. enable:false on b -> not downloaded, in stale.
const eCls = C.classifyRules("false", [
  { name: "a", url: "https://example.com/a.md", enable: "true" },
  { name: "b", url: "https://example.com/b.md" },
], "stub-local", "");
const eEnabled = eCls.remoteEnabled.map(function (r) { return r.name; });
const eStale = C.diffRuleNames(["a", "b"], eEnabled);
const eToDelete = Array.from(new Set([].concat(eCls.disabledNames, eStale)));
assert(eEnabled.indexOf("b") === -1, "enable=false: b not downloaded (zero-network)");
assert(eToDelete.indexOf("b") !== -1, "enable=false: b in namesToDelete");
assert(eCls.remoteEnabled.length === 1, "enable=false: only a enabled");

// Cleanup temp dir
try { fs_real.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);
// MANIFEST_END
// MANIFEST_END

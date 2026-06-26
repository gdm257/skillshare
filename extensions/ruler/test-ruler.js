#!/usr/bin/env node
/**
 * Offline smoke test for the ruler extension.
 *
 * Imports the REAL helpers from convert.js (no divergent copies) and
 * exercises frontmatter parsing, XML block construction, upsert/delete
 * logic, enable cascade, delete normalization, mixed delete+upsert
 * ordering, and the round-trip invariant — with NO network access.
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
assert(block.indexOf('<rule name="test-rule">') === 0, "starts with opening tag");
assert(block.indexOf("</rule>") === block.length - 7, "ends with closing tag");
assert(block.indexOf("Do something") !== -1, "includes content");
assert(block.indexOf("Great!") !== -1, "includes all content");

// Name-attribute XML escaping (real makeRuleBlock escapes &, ", <, >)
const blockEsc = C.makeRuleBlock('a&b"c', "body");
assert(blockEsc.indexOf('&amp;') !== -1, "& escaped in attr");
assert(blockEsc.indexOf('&quot;') !== -1, '" escaped in attr');

// </rule> content conflict -> warning (still emitted)
_origStderr = process.stderr.write.bind(process.stderr);
let warned = false;
process.stderr.write = (s) => {
  if (String(s).indexOf("</rule>") !== -1) warned = true;
  return true;
};
const blockConflict = C.makeRuleBlock("r", "x\n</rule>\ny");
process.stderr.write = _origStderr;
assert(warned, "warns when content contains </rule>");
assert(blockConflict.indexOf("</rule>") !== -1, "block still written despite conflict");

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
  '<rule name="code-review">',
  "Old content",
  "</rule>",
  "",
  "More text.",
].join("\n");
const newBlock1 = '<rule name="code-review">\nNew content\n</rule>';
const result1 = C.upsertRule(existing1, "code-review", newBlock1);
assert(result1.indexOf("New content") !== -1, "replaced content is present");
assert(result1.indexOf("Old content") === -1, "old content is gone");
assert(result1.indexOf("Manual content.") !== -1, "non-rule content preserved");
assert(result1.indexOf("More text.") !== -1, "non-rule content after rule preserved");

// append to non-empty
const existing2 = "# AGENTS\n\nManual content.";
const newBlock2 = '<rule name="new-rule">\nNew stuff\n</rule>';
const result2 = C.upsertRule(existing2, "new-rule", newBlock2);
assert(result2.indexOf("New stuff") !== -1, "new rule content present");
assert(result2.indexOf("Manual content.") !== -1, "existing content preserved");
assert(result2.indexOf("</rule>") === result2.length - 8, "new rule at end");

// fresh file: NO leading blank line, single trailing newline (fixed)
const fresh = C.upsertRule("", "my-rule", '<rule name="my-rule">\ncontent\n</rule>');
assert(fresh === '<rule name="my-rule">\ncontent\n</rule>\n', "fresh file: block + single newline, no leading blank");

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
const crlfSeed = "# AGENTS\r\n\r\n<rule name=\"old\">\r\nold body\r\n</rule>\r\n";
const lfSeed = crlfSeed.replace(/\r\n/g, "\n");
const upsertOnNormalized = C.upsertRule(lfSeed, "fresh", C.makeRuleBlock("fresh", "new rule"));
assert(upsertOnNormalized.indexOf("\r") === -1, "CRLF->LF upsert: no CR in result");
assert(upsertOnNormalized.indexOf("new rule") !== -1, "CRLF->LF upsert: new block present");
assert(upsertOnNormalized.indexOf("\n\n\n") === -1, "CRLF->LF upsert: no doubled blank lines");
assert(upsertOnNormalized.indexOf("old body") !== -1, "CRLF->LF upsert: old block preserved");

// CRLF three-block file, delete middle after normalization -> regex works
const crlfThree =
  "<rule name=\"a\">\nA\n</rule>\n\n" +
  "<rule name=\"b\">\nB\n</rule>\n\n" +
  "<rule name=\"c\">\nC\n</rule>\n";
const delMid = C.deleteRule(crlfThree, "b");
assert(delMid.indexOf("\r") === -1, "CRLF->LF delete middle: no CR");
assert(
  delMid === "<rule name=\"a\">\nA\n</rule>\n\n<rule name=\"c\">\nC\n</rule>\n",
  "CRLF->LF delete middle: survivors separated by exactly 1 blank line"
);

// CRLF header + rule, delete rule after normalization -> header kept, LF only
const crlfHeaderRule = "# Header\r\n\r\n<rule name=\"x\">\r\nX\r\n</rule>\r\n".replace(/\r\n/g, "\n");
const headerAfterDel = C.deleteRule(crlfHeaderRule, "x");
assert(headerAfterDel === "# Header\n", "CRLF->LF delete with header: header kept, rule gone");
assert(headerAfterDel.indexOf("\r") === -1, "CRLF->LF delete with header: no CR remains");

// Full round-trip: CRLF seed -> normalize -> upsert -> stays LF on re-read
const rtCrlf = "<rule name=\"rt\">\r\nv1\r\n</rule>\r\n".replace(/\r\n/g, "\n");
let rtLf = C.upsertRule("", "rt", C.makeRuleBlock("rt", "v1"));
rtLf = C.deleteRule(rtLf, "rt");
assert(rtLf === "", "CRLF->LF round-trip: disable empties file");
rtLf = C.upsertRule(rtLf, "rt", C.makeRuleBlock("rt", "v2"));
assert(rtLf === "<rule name=\"rt\">\nv2\n</rule>\n", "CRLF->LF round-trip: restore is clean LF");
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
console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);

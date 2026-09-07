#!/usr/bin/env node
const path = require("path");

// OMP agents share Claude's markdown shape, so pass through and only fill a missing name
convert();

function convert() {
  readStdin().then((input) => {
    const relPath = process.env.SS_REL_PATH || "input.md";
    const stem = path.basename(relPath, path.extname(relPath));
    process.stdout.write(normalize(addName(stripBom(input), stem)));
  }).catch((err) => {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exit(1);
  });
}

function stripBom(input) {
  return input.replace(/^\uFEFF/, "");
}

function addName(input, stem) {
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return `---\nname: ${stem}\n---\n${input}`;
  const frontmatter = match[1];
  if (/^\s*name\s*:/m.test(frontmatter)) return input;
  return `---\nname: ${stem}\n${frontmatter}\n---\n${input.slice(match[0].length)}`;
}

function normalize(doc) {
  return doc.replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

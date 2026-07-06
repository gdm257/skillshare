# ruler

Remote + local rules extension for skillshare. Reads stub `.md` files and
injects rules into `AGENTS.md` / `CLAUDE.md` (or custom outputs) via
`<!-- rule-{name}:start/end -->` HTML comment markers.

## Quick start

### 1. Install

Dashboard: Extensions → ruler → Install.

Or manually:

```bash
cp -R extensions/ruler ~/.config/skillshare/extensions/ruler      # global
cp -R extensions/ruler .skillshare/extensions/ruler                # project
```

### 2. Configure

Add an `extras` entry to `config.yaml`. The `targets.path` and
`targets.extension` values depend on which mode youʼre in — copy the
matching block:

```yaml
# ── Global mode  (~/.config/skillshare/config.yaml) ──
extras:
  - name: rules
    source: ~/.config/skillshare/stubs/rules    # optional; see below
    targets:
      - path: ~/.config/skillshare/extensions/ruler/dummy
        extension: ruler

# ── Project mode (.skillshare/config.yaml) ──
extras:
  - name: rules
    ### source: .skillshare/stubs/rules         # optional; see below
    targets:
      - path: .skillshare/extensions/ruler/dummy
        extension: ruler
```

**`targets.path` is always the `dummy/` directory inside the ruler
extension.** The extension writes real output files to `AGENTS.md`,
`CLAUDE.md`, etc., while skillshare writes empty placeholder files into
`dummy/`.  Skillshare auto-creates `dummy/` on first sync; the
bundled `.gitignore` at the extension root keeps it out of version
control.

**`source` resolution (optional)** — where skillshare looks for stub
`.md` files. Three-level priority:

| Priority | Config field | Global default | Project default |
|----------|-------------|----------------|-----------------|
| 1. per-extra | `extra.source` | — | — |
| 2. extras parent | `sources.extras` (or legacy `extras_source`) | — | — |
| 3. fallback | (none) | `~/.config/skillshare/extras/<name>/` | `.skillshare/extras/<name>/` |

- **Absolute paths** (e.g. `/home/me/rules`, `C:\Users\me\rules`) → used directly.
- **Tilde paths** (`~/.config/…`) → expanded to `$HOME`.  Only expanded
  in **global** mode; project mode expands `~` too via `ExpandPath`.
- **Relative paths** (`./stubs`, `../shared/stubs`) → relative to the
  working directory when `skillshare` runs (typically the project root
  in project mode, or `$HOME` in global mode).  Prefer tilde or absolute
  paths for predictability.

If you omit `source`, the fallback directory is created automatically on
first sync.

### 3. Create stub files

Drop `.md` files into the source directory. Three styles, all valid:

```markdown
---
urls:
  - name: code-review
    url: https://raw.githubusercontent.com/owner/repo/main/rules/code-review.md
---
```

```markdown
# Use TypeScript for all new code.

Prefer `async/await` over raw promises.
```

```markdown
---
urls:
  - name: security
    url: https://raw.githubusercontent.com/team/policies/main/security.md
---

Additionally, the team uses Prettier with the config in `.prettierrc`.
```

### 4. Sync

```bash
skillshare sync extras
```

## Frontmatter reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `urls` | array of `{name, url, enable?}` | — | Remote rules to download |
| `outputs` | string array | `["AGENTS.md", "CLAUDE.md"]` | Output file paths |
| `name` | string | filename stem | Overrides the rule name for local body content |
| `enable` (top-level) | `true` / `false` | `true` | Toggles all rules in this stub; `false` skips download and deletes matching comment blocks |
| `enable` (per-url) | `true` / `false` | inherits top-level | Overrides top-level `enable` for one URL |
| `description` | string | — | Ignored by ruler (accepted for compatibility) |

### Output paths

- **Relative** (`AGENTS.md`) → resolved against the project root
- **Absolute** (`/etc/rules.md`) → used directly
- **Tilde** (`~/.claude/rules.md`) → expanded to `$HOME`

## How rules are merged

Each stub produces one or more comment marker blocks that are merged into
every output file:

- **Remote URL** → `<!-- rule-{name}:start -->` … `<!-- rule-{name}:end -->`
- **Local body** → `<!-- rule-{name}:start -->` … `<!-- rule-{name}:end -->`

When a matching `<!-- rule-{name}:start/end -->` pair already exists in the output file, it is
replaced in-place. Otherwise it is appended at the end. Non-rule
content (hand-written headers, other comments) is never touched.

### Migrating from the old XML format

Older versions of ruler used `<rule name="X">…</rule>` XML tags. On the
first sync after upgrading, ruler automatically converts all old-format
blocks in existing output files to the new HTML comment markers — no
manual intervention needed. The migration is one-way and idempotent.

### Processing order

1. Remote `urls` — downloaded concurrently (max 4 in-flight; any
   failing URL is skipped with an error logged to the sync output).
2. Local body content — always processed last.

If remote and local rules share the same `name`, the local rule wins
(closer source, higher priority).

### Enable / disable

Set `enable: false` to temporarily withdraw a rule without deleting its
config. Disabled rules are **not** downloaded; ruler removes any
existing `<!-- rule-{name}:start/end -->` block with the same name from each output
file and normalizes the surrounding blank lines so exactly one blank
line stays between blocks. Flip it back to `true` (or omit it) to
restore the rule on the next sync.

A per-url `enable` overrides the stub's top-level `enable`:

```yaml
---
enable: false          # withdraw everything by default
urls:
  - name: keep
    url: https://example.com/keep.md
    enable: true       # ...except this one stays
---
```

The local body has no per-entry knob — it follows the top-level
`enable` only.

Within a single sync, ruler deletes every disabled rule first (then
normalizes blank lines), and upserts every enabled rule afterward, so a
stub that both disables one rule and enables another leaves the output
file with exactly one blank line between remaining blocks. Disabled rules
never touch the network: the download is skipped and only the deletion runs.

## Automatic cleanup (sync manifest)

ruler maintains a `.ruler-manifest.json` in the extension directory that
records which rules each stub injected and which output files they went
to. On every sync this state drives two automatic cleanup mechanisms:

1. **Orphan GC** — if a stub `.md` file is deleted from the source
  directory, the next sync of any *other* stub detects the missing file,
   removes the deleted stub's comment blocks from every output, and
   prunes its manifest entry. No manual `enable: false` needed.
2. **Per-stub diff** — if a URL entry is removed from a stub's
   frontmatter (or its `name` changes), the stale comment block is
   automatically deleted on the next sync.

The manifest is a derived state file (gitignored) — you never need to
edit it, and deleting it simply means the next sync rebuilds the
baseline without cleanup (rules already present are preserved, not
re-deleted).

The first sync after upgrading (no manifest yet) behaves exactly like
before: no deletions, only upserts. After that baseline is written, all
subsequent syncs are fully manifest-driven.

## Test locally

Set `SS_TARGET_DIR` to match your mode (the value skillshare passes
to the extension at runtime):

| Mode | `SS_TARGET_DIR` |
|------|-----------------|
| Global | `~/.config/skillshare/extensions/ruler/dummy` |
| Project | `<project>/.skillshare/extensions/ruler/dummy` |

```bash
# Remote rules example
printf '%s\n' \
  '---' \
  'urls:' \
  '  - name: example' \
  '    url: https://raw.githubusercontent.com/owner/repo/main/rules/example.md' \
  '---' \
  | SS_REL_PATH=test.md \
    SS_TARGET_DIR="$HOME/.config/skillshare/extensions/ruler/dummy" \
    node extensions/ruler/convert.js

# Local rules example (no frontmatter)
printf '%s\n' 'Use TypeScript.' 'Prefer async/await.' \
  | SS_REL_PATH=my-rules.md \
    SS_TARGET_DIR="$HOME/.config/skillshare/extensions/ruler/dummy" \
    node extensions/ruler/convert.js

# Combined: remote URLs + local body
printf '%s\n' \
  '---' \
  'urls:' \
  '  - name: team-policy' \
  '    url: https://example.com/policy.md' \
  '---' \
  'Prefer tabs over spaces.' \
  | SS_REL_PATH=project-rules.md \
    SS_TARGET_DIR="$HOME/project/.skillshare/extensions/ruler/dummy" \
    node extensions/ruler/convert.js
```

## Offline smoke test

```bash
node extensions/ruler/test-ruler.js
```

Covers YAML parsing, comment block construction, upsert + delete logic,
the `enable` cascade, delete blank-line normalization, the disable to
re-enable round-trip invariant, old-format migration, project-root
detection, and local/combined rule extraction. No network access needed.

## Files

```
extensions/ruler/
├── extension.yaml       # Tells skillshare how to run this extension
├── convert.js           # Core transform logic (zero deps; exports pure helpers)
├── convert.d.ts         # TypeScript declarations for IDE support
├── test-ruler.js        # Offline smoke test (exercises the real convert.js exports)
├── .gitignore           # Ignores dummy/ so placeholder files stay out of VC
                          #          + .ruler-manifest.json (sync state, derived)
└── README.md            # This file
```

`dummy/` is not committed — skillshare auto-creates it on first sync.

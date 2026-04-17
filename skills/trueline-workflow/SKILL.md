---
name: trueline-workflow
description: Use when editing, reading, searching, or exploring files in a project where trueline MCP tools (trueline_read, trueline_edit, trueline_search, trueline_outline, trueline_verify, trueline_changes) are available. Covers when to pick trueline over built-in Read/Edit/Grep, ref reuse, hash-verified edits, search-then-edit, insert_after semantics, and workflows that cut context tokens by 60-90%.
---

# Trueline Workflow

Trueline MCP tools replace built-in `Read` / `Edit` / `Grep` with hash-verified, streaming, ref-based equivalents. They catch hallucinated edits before they land and dramatically cut context tokens — but only when used in the right order. This skill is the workflow.

## Tool cheat sheet

| Tool | Use when | Why |
|------|----------|-----|
| `trueline_outline` | First look at any file, any size | ~10-20 lines vs hundreds from a full read |
| `trueline_search` | You know the target string/symbol | Returns lines with hash prefixes and edit-ready refs in one call |
| `trueline_read` | You need exact context for editing | Per-line hashes + range checksums; supports globs and `path:range` inline |
| `trueline_edit` | All edits | Hash-verified, streaming, atomic; built-in Edit is blocked by hook |
| `trueline_verify` | Refs held across turns | Checks staleness without re-reading the file |
| `trueline_changes` | Review work vs git | Symbol-level semantic diff (added/removed/renamed/signature) |

## The three workflows

Pick the one that matches what you know.

### 1. Surgical (default) — when you know the target

```
trueline_search(file_paths, pattern) → trueline_edit
```

No read step. `trueline_search` returns lines with hash prefixes plus a ref. Feed those straight into `trueline_edit`. Fastest path. Use it for renames, string swaps, bugfixes on a named function.

### 2. Exploratory — when you need context first

```
trueline_outline → trueline_read (targeted ranges) → trueline_edit
```

Outline tells you the structure. Read only the ranges you actually need — not the whole file. `trueline_read` accepts `path:startLine-endLine` inline, so you can pull multiple slices in one call.

### 3. Re-entering — when you held refs across turns

```
trueline_verify(refs) → re-read only stale ranges → trueline_edit
```

If nothing changed, you edit straight away. If `verify` reports stale, re-read just that range. Don't re-read the whole file on spec.

## Worked example: search → edit

`trueline_search` output looks like:

```
ab.10    old line one
cd.11    old line two
ref:R1
```

To replace both lines:

```
trueline_edit(
  file_path=…,
  edits=[{ range: "ab.10-cd.11", ref: "R1", content: "new line one\nnew line two" }]
)
```

- `range` uses the `hash.line` identifiers **verbatim** from the output.
- `ref` is the short token (`R1`) — copy it verbatim, never guess.
- A wide ref (e.g. covering lines 1-157) is valid for editing any sub-range inside it. Don't re-read to get a narrower one.

## Load-bearing rules

These are non-negotiable. Violations produce verification errors or silent data loss.

- **Never fabricate refs.** Copy `R1` / `R2` / … directly from `trueline_read` or `trueline_search` output. A made-up ref will fail verification.
- **Hash prefixes on line numbers (`ab.10`) are required.** They are not decoration — they verify content at that line.
- **`action="insert_after"` to add lines.** Without it, the range is *replaced* and existing content is lost. If you want to add lines next to existing ones, you must pass `action: "insert_after"`.
- **Don't re-read for data you already have.** If you have a ref and hash.line identifiers from a prior search or read, go straight to `trueline_edit`.

## Multi-file batches

Need to edit many files? Use `Grep` (or platform equivalent) only to find the files, then pass **all** paths to a single `trueline_search` call. You get refs for every match in one round-trip.

## Deferred tool loading (Claude Code / Copilot CLI)

If trueline tool schemas are marked deferred, load them all in one batch:

```
ToolSearch("+trueline read edit")
```

Loads `trueline_read`, `trueline_edit`, `trueline_search`, `trueline_outline`, `trueline_verify`, `trueline_changes` schemas together. One call, not six.

## Quick reference

- Exploration default: `trueline_outline`.
- Edit default: `trueline_search` → `trueline_edit`.
- Reviewing your changes: `trueline_changes`.
- Holding refs between turns: `trueline_verify`.

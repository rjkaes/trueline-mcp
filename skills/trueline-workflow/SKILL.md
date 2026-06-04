---
name: trueline-workflow
description: Use when editing, reading, searching, or exploring files with trueline MCP tools (trueline_read, trueline_edit, trueline_search, trueline_outline, trueline_verify, trueline_changes). Covers when to pick trueline over built-in Read/Edit/Grep, ref reuse, hash-verified edits, search-then-edit, insert_after semantics, workflows cutting context tokens 60-90%.
---

# Trueline Workflow

Trueline MCP tools replace built-in `Read`/`Edit`/`Grep` with hash-verified, streaming, ref-based equivalents. Catches hallucinated edits, cuts tokens. Use in right order.

## CLI vs MCP

The same six tools are also available as a standalone `trueline` shell binary (at `bin/trueline` in the repo), useful for shell scripts, CI pipelines, and git hooks where no MCP-aware agent is running. The same hash-verification guarantees apply.

```sh
trueline outline <paths...>
trueline read <paths...> [--ranges 10-20]
trueline search <pattern> <paths...> [-i] [-r] [--multiline] [-C N]
trueline edit <path> --edits @file|-|<flat flags>
trueline verify <path> --refs ...
trueline changes [paths...]   # alias: diff
```

Every subcommand accepts `--help`/`-h`. Pass `--json` on any subcommand for `{ok, result}` machine-readable output. Exit codes: `0` ok, `1` search no match, `2` tool error, `3` usage error.

**Never pipe `trueline read`/`trueline search` through `head`, `tail`, `sed`, `grep`, or any filter that drops lines.** The ref checksum (e.g. `ref: ab10-cd11/efghij`) is printed at the *end* of the output. Truncating it loses the ref, which makes `trueline_edit` unusable — there is nothing valid to pass as `ref`. Read the full output; scope it with `--ranges` (CLI) or `path:start-end` (MCP) instead of piping.

Use MCP tools (this skill) for in-agent file work. Use the CLI for anything outside an agent context.

## Tool cheat sheet

| Tool | Use when | Why |
|------|----------|-----|
| `trueline_outline` | First look, any file | ~10-20 lines vs hundreds |
| `trueline_search` | Know target string/symbol | Lines with hash prefixes + refs, one call |
| `trueline_read` | Need exact edit context | Per-line hashes + checksums; globs and `path:range` |
| `trueline_edit` | All edits | Hash-verified, atomic; built-in Edit blocked by hook |
| `trueline_verify` | Refs held across turns | Checks staleness without re-read |
| `trueline_changes` | Review vs git | Symbol-level semantic diff |

## Three workflows

Pick one matching what you know.

### 1. Surgical (default) — know the target

```
trueline_search(file_paths, pattern) -> trueline_edit
```

No read step. `trueline_search` returns lines with hash prefixes plus ref. Feed straight into `trueline_edit`. Fastest. Use for renames, string swaps, bugfixes on named function.

### 2. Exploratory — need context first

```
trueline_outline -> trueline_read (targeted ranges) -> trueline_edit
```

Outline gives structure. Read only ranges you need. `trueline_read` accepts `path:startLine-endLine` inline for multiple slices in one call.

### 3. Re-entering — refs held across turns

```
trueline_verify(refs) -> re-read only stale ranges -> trueline_edit
```

Nothing changed -> edit straight away. Stale -> re-read just that range. Never re-read whole file on spec.

## Worked example: search -> edit

`trueline_search` output:

```
->ab10	old line one
cd11	old line two
ref: ab10-cd11/efghij
```

Replace both:

```
trueline_edit(
  file_path=…,
  edits=[{ range: "ab10-cd11", ref: "ab10-cd11/efghij", content: "new line one\nnew line two" }]
)
```

- `range` uses `hashLine` identifiers **verbatim** from output.
- `ref` is the full range checksum (e.g. `ab10-cd11/efghij`) — copy verbatim, never guess.
- Wide ref (e.g. lines 1-157) valid for any sub-range inside. Don't re-read narrower.
- Lines prefixed with `->` are matches; lines without `->` are context. Both carry `hashLine` identifiers usable in `range`.

## Load-bearing rules

Non-negotiable. Violations -> verification errors or silent data loss.

- **Never fabricate refs.** Copy the full ref (e.g. `ab10-cd11/efghij`) directly from output. Made-up ref fails verification.
- **Hash prefixes (`ab10`) required.** Not decoration — verify content at that line.
- **`action="insert_after"` to add lines.** Without it, range is *replaced* and content lost. To add next to existing lines, pass `action: "insert_after"`.
- **Don't re-read data you have.** With ref and `hashLine` from prior search/read, go straight to `trueline_edit`.

## Multi-file batches

Editing many files? Use `Grep` to find files, then pass **all** paths to one `trueline_search` call. Refs for every match in one round-trip.

## Deferred tool loading

If trueline schemas deferred, load in one batch:

```
ToolSearch("+trueline read edit")
```

Loads all six schemas together. One call, not six.

## Quick reference

- Exploration default: `trueline_outline`.
- Edit default: `trueline_search` -> `trueline_edit`.
- Review changes: `trueline_changes`.
- Refs between turns: `trueline_verify`.

# trueline-mcp

trueline-mcp replaces the built-in read and edit tools with hash-verified,
token-efficient alternatives. Always use the trueline MCP tools instead of
built-in file operations.

## Tools

- **trueline_read** — Read files with per-line hashes and refs. Supports globs and `path:start-end` ranges. Call before editing.
- **trueline_edit** — Apply hash-verified edits. Each edit needs a ref from trueline_read or trueline_search.
- **trueline_changes** — Semantic AST-based summary of structural changes vs a git ref. Pass all files in one call.
- **trueline_outline** — Get a compact structural outline (functions, classes, types, headings) with line ranges.
- **trueline_search** — Search files for a string or regex. Returns matching lines with hashes and refs, ready for editing.
- **trueline_verify** — Check whether held refs are still valid. Cheaper than re-reading.

## Workflow

trueline_outline (navigate) → trueline_search or trueline_read (targeted ranges) → trueline_edit

## Rules

- Never use the built-in read or view tools, or shell cat/head/tail — use trueline_read instead.
- Never use the built-in edit tools — use trueline_edit instead.
- trueline_outline is often enough for navigation. Only call trueline_read when you need source code.
- After trueline_outline, read only the specific ranges you need — do NOT read the entire file.
- Always pass the ref from trueline_read or trueline_search when editing. If a ref is stale, re-read the range.
- File paths must be absolute.

## Note

Where the platform has no hook support (Codex CLI has none), nothing enforces
these rules. Follow them manually for best results.

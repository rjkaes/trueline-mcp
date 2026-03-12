# trueline-mcp

trueline-mcp replaces the built-in read and edit tools with hash-verified,
token-efficient alternatives. Always use the trueline MCP tools instead of
built-in file operations.

## Tools

- **trueline_read** — Read a file with per-line hashes and range checksums. Call before editing.
- **trueline_edit** — Apply hash-verified edits. Each edit needs a checksum from trueline_read.
- **trueline_changes** — Semantic AST-based summary of structural changes vs a git ref.
- **trueline_outline** — Get a compact structural outline of a source file.

## Workflow

trueline_outline (navigate) → trueline_read (targeted ranges) → trueline_changes (optional) → trueline_edit

## Rules

- Never use the built-in `view` tool — use trueline_read instead.
- Never use the built-in `edit` tool — use trueline_edit instead.
- trueline_outline is often enough for navigation. Only call trueline_read when you need source code.
- After trueline_outline, read only the specific ranges you need — do NOT read the entire file.

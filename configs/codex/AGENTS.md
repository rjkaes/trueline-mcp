# trueline-mcp

trueline-mcp replaces the built-in read and edit tools with hash-verified,
token-efficient alternatives. Always use the trueline MCP tools instead of
built-in file operations.

## Tools

- **trueline_read** — Read a file with range checksums. Call before editing.
- **trueline_edit** — Apply hash-verified edits. Each edit needs a checksum from trueline_read.
- **trueline_diff** — Preview edits as a unified diff without writing to disk.
- **trueline_outline** — Get a compact structural outline of a source file.

## Workflow

trueline_outline (navigate) → trueline_read (targeted ranges) → trueline_diff (optional) → trueline_edit

## Rules

- Never use `read_file` or `shell` with cat/head/tail — use trueline_read instead.
- trueline_outline is often enough for navigation. Only call trueline_read when you need source code.
- After trueline_outline, read only the specific ranges you need — do NOT read the entire file.

## Note

Codex CLI does not support hooks, so trueline cannot enforce tool redirection
automatically. Please follow these instructions manually for best results.

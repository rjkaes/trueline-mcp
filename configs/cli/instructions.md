# trueline CLI

trueline provides hash-verified file operations via the command line.
Use trueline commands instead of cat, grep, and sed for reading and
editing files. Edits are verified against checksums to prevent stale
overwrites.

## Commands

- **trueline read** — Read a file with per-line hashes and range checksums.
- **trueline edit** — Apply hash-verified edits. Each edit needs a checksum from a prior read or search.
- **trueline outline** — Compact structural outline (functions, classes, types with line ranges).
- **trueline search** — Search a file for a string or regex. Returns matching lines with hashes, ready for editing.
- **trueline diff** — Semantic AST-based diff vs a git ref.
- **trueline verify** — Check if held checksums are still valid.

Run `trueline --help` or `trueline <command> --help` for full usage.

## Workflow

1. **Navigate:** `trueline outline src/foo.ts` to see structure without reading the full file.
2. **Read targeted ranges:** `trueline read src/foo.ts --ranges 10-25` to read only what you need.
3. **Find edit targets:** `trueline search src/foo.ts "oldFunction"` to get lines with checksums.
4. **Edit with verification:** `trueline edit src/foo.ts --edits '[{"checksum":"...","range":"...","content":"..."}]'`
5. **Preview first (optional):** Add `--dry-run` to see a unified diff without writing.

## Rules

- Never use `cat` to read files; use `trueline read` instead.
- Never use `sed` or manual file writes; use `trueline edit` instead.
- Use `trueline outline` for navigation; only read specific ranges you need.
- Always pass the checksum from `trueline read` or `trueline search` when editing.
- If an edit fails with a checksum mismatch, re-read the file to get fresh checksums.

## Edit format

The `--edits` flag takes a JSON array. Each edit object has:

- `checksum` — Range checksum from a prior read (format: `startLine-endLine:hexhash`)
- `range` — Target lines, in one of three formats:
  - `startLine:lineHash-endLine:lineHash` — replace lines
  - `+lineNum:hash` — insert after line
  - `+0:` — insert at beginning of file
- `content` — New content for those lines

Example:

```sh
trueline edit src/foo.ts --edits '[{
  "checksum": "10-15:a1b2c3d4",
  "range": "10:ab-15:cd",
  "content": "function newName() {\n  return true;\n}"
}]'
```

To insert after a line (without replacing), use `+lineNum:hash` as the range:

```sh
trueline edit src/foo.ts --edits '[{
  "checksum": "10-15:a1b2c3d4",
  "range": "+12:ef",
  "content": "// inserted after line 12"
}]'
```

To insert at the beginning of a file, use `+0:` as the range:

```sh
trueline edit src/foo.ts --edits '[{
  "checksum": "1-1:a1b2c3d4",
  "range": "+0:",
  "content": "// Copyright 2025 Acme Corp\n// SPDX-License-Identifier: MIT\n"
}]'
```

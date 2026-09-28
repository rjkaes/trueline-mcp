# trueline CLI

trueline provides hash-verified file operations via the command line.
Use trueline commands instead of cat, grep, and sed for reading and
editing files. Edits are verified against checksums to prevent stale
overwrites.

## Commands

- **trueline read** — Read a file with per-line hashes and refs.
- **trueline edit** — Apply hash-verified edits. Each edit needs a ref from a prior read or search.
- **trueline outline** — Compact structural outline (functions, classes, types with line ranges).
- **trueline search** — Search a file for a string or regex. Returns matching lines with hashes, ready for editing.
- **trueline diff** — Semantic AST-based diff vs a git ref.
- **trueline verify** — Check if held refs are still valid.

Run `trueline --help` or `trueline <command> --help` for full usage.

## Workflow

1. **Navigate:** `trueline outline src/foo.ts` to see structure without reading the full file.
2. **Read targeted ranges:** `trueline read src/foo.ts --ranges 10-25` to read only what you need.
3. **Find edit targets:** `trueline search "oldFunction" src/foo.ts` to get lines with hashes and refs.
4. **Edit with verification:** `trueline edit src/foo.ts --edits '[{"ref":"...","range":"...","content":"..."}]'`
5. **Preview first (optional):** Add `--dry-run` to see a unified diff without writing.

## Rules

- Never use `cat` to read files; use `trueline read` instead.
- Never use `sed` or manual file writes; use `trueline edit` instead.
- Use `trueline outline` for navigation; only read specific ranges you need.
- Always pass the ref from `trueline read` or `trueline search` when editing.
- If an edit fails with a stale ref, re-read the file to get fresh refs.

## Edit format

The `--edits` flag takes a JSON array (literal, `@file`, or `-` for stdin). Each edit object has:

- `ref` — Ref from a prior read or search (e.g. `ml1-bh2/eaickz`). Valid for any lines within its range.
- `range` — Target lines. Each line number carries the 2-letter hash shown in the output:
  - `ml1-bh2` — replace lines 1-2
  - `ml1` — replace line 1
  - `+ml1` — insert after line 1
  - `+0` — insert at beginning of file
- `content` — New lines, newline-separated. An empty string deletes the range.
- `action` (optional) — `replace` (default) or `insert_after`

Given this `trueline read src/server.ts` output:

```
ml1	const port = 8080;
bh2	export default port;

ref: ml1-bh2/eaickz
```

Replace line 1:

```sh
trueline edit src/server.ts --edits '[{
  "ref": "ml1-bh2/eaickz",
  "range": "ml1",
  "content": "const port = 3000;"
}]'
```

For a single edit, flat flags work too:

```sh
trueline edit src/server.ts --ref ml1-bh2/eaickz --range ml1 --content 'const port = 3000;'
```

To insert after a line (without replacing), prefix the range with `+`:

```sh
trueline edit src/server.ts --edits '[{
  "ref": "ml1-bh2/eaickz",
  "range": "+ml1",
  "content": "const host = \"localhost\";"
}]'
```

To insert at the beginning of a file, use `+0` as the range:

```sh
trueline edit src/server.ts --edits '[{
  "ref": "ml1-bh2/eaickz",
  "range": "+0",
  "content": "// SPDX-License-Identifier: Apache-2.0"
}]'
```

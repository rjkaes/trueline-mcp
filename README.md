# trueline-mcp

[![CI](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp) [![Last commit](https://img.shields.io/github/last-commit/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp/commits/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A [Claude Code](https://code.claude.com) MCP plugin for truth-verified file editing.

Each line is tagged with a short hash. Before writing, the server verifies that
the lines being replaced still match the hashes the agent observed — catching
stale edits caused by concurrent changes or model hallucination.

## Installation

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

## Why Trueline?

Trueline saves tokens on every edit — and catches mistakes the built-in
tools can't.

### Fewer output tokens

Claude Code's built-in `Edit` tool uses string matching: the model must
echo back the exact text being replaced (`old_string`) plus the
replacement (`new_string`). The old text is pure overhead — it's already
in the file.

```json
// Built-in Edit — model must output the old text to locate the edit
{
  "file_path": "src/server.ts",
  "old_string": "export function handleRequest(req: Request) {\n  const body = await req.json();\n  validate(body);\n  return process(body);\n}",
  "new_string": "export function handleRequest(req: Request) {\n  const body = await req.json();\n  const parsed = schema.parse(body);\n  return process(parsed);\n}"
}
```

trueline_edit replaces the old text with a compact line-range reference:

```json
// trueline_edit — just the range and the new content
{
  "file_path": "src/server.ts",
  "edits": [{
    "checksum": "1-50:a3b1c2d4",
    "range": "12:kf..16:qz",
    "content": "export function handleRequest(req: Request) {\n  const body = await req.json();\n  const parsed = schema.parse(body);\n  return process(parsed);\n}"
  }]
}
```

The model never echoes the old text. For a typical 15-line edit, that's
**~200 fewer output tokens per edit** — the most expensive token class.

### No uniqueness problem

The built-in `Edit` fails if `old_string` appears more than once in the
file, forcing the model to include extra context lines until the match is
unique. trueline_edit addresses lines directly — no ambiguity, no wasted
context.

### Batch edits in one call

The built-in `Edit` handles one replacement per call. trueline_edit
accepts an array of edits applied atomically in a single call, cutting
tool-call overhead for multi-site changes.

### Hash verification catches mistakes

Per-line hashes and range checksums verify that the file hasn't changed
since the model read it. Stale edits from concurrent changes or model
hallucination are rejected before they corrupt your code.

### Cost comparison

| Scenario: replace 15 lines in a 200-line file | Built-in Edit | trueline_edit |
|------------------------------------------------|---------------|---------------|
| Old text echoed back (output tokens)           | ~225          | 0             |
| New text (output tokens)                       | ~225          | ~225          |
| Range/checksum overhead                        | 0             | ~13           |
| Boilerplate                                    | ~20           | ~25           |
| **Total output tokens**                        | **~470**      | **~263**      |
| **Savings**                                    |               | **44%**       |

If `old_string` isn't unique and extra context is needed, built-in Edit
cost rises further — trueline stays constant.

## How it works

`trueline_read` returns file content in trueline format. It supports reading
multiple disjoint ranges in a single call, each producing its own checksum.
Each line is prefixed with its line number and a 2-letter hash derived from
FNV-1a 32-bit. A range checksum (FNV-1a 32-bit, 8 hex chars) covers each
range of lines read:

```
1:bx|import { Server } from "@modelcontextprotocol/sdk/server/index.js";
2:dd|
3:ew|const server = new Server({ name: "trueline-mcp", version: "0.1.0" });

checksum: 1-3:8a64a3f7
```

`trueline_edit` takes a range specifier (`startLine:startHash..endLine:endHash`,
e.g. `"1:bx..3:ew"`) and a per-edit checksum from the read. Both are verified
before the write — if either has changed since the read, the edit is rejected.

Here is what a `trueline_edit` call looks like in practice:

```
trueline_edit(
  file_path: "README.md",
  edits: [{
    checksum: "1-112:a509e33a",
    range: "+56:dd",
    content: "\\nthis is awesome\\n"
  }]
)
```

```
Edit applied. (10ms)

inserted 3 lines after line 56
checksum: 1-115:52d30156
```

`trueline_diff` previews the proposed changes as a unified diff without writing
to disk.

### Workflow

```
trueline_read → trueline_diff (optional) → trueline_edit
```

### Hooks

A `SessionStart` hook injects instructions into every session directing the
agent to use the trueline tools instead of the built-in `Read`/`Edit` tools.
A `PreToolUse` hook blocks the built-in `Edit` tool outright and redirects
to the trueline workflow.

### Path access

By default, trueline tools can access files inside the project directory
(`CLAUDE_PROJECT_DIR`) and `~/.claude/` (where Claude Code stores plans,
memory, and settings). To allow additional directories, set the
`TRUELINE_ALLOWED_DIRS` environment variable to a colon-separated list of
paths.

## Tools

### `trueline_read`

Read a file and return its content with per-line hashes and a range checksum.

| Parameter    | Type    | Description                                             |
|--------------|---------|-------------------------------------------------------  |
| `file_path`  | string  | Path to the file                                        |
| `ranges`     | array   | Optional array of `{start, end}` ranges to read (default: whole file) |

### `trueline_edit`

Apply one or more edits to a file with hash verification.

| Parameter  | Type   | Description                                              |
|------------|--------|----------------------------------------------------------|
| `file_path`| string | Path to the file                                         |
| `edits`    | array  | List of edit operations (see below)                      |

Each edit:

| Field      | Type     | Description                                                                          |
|------------|----------|--------------------------------------------------------------------------------------|
| `checksum` | string   | Range checksum from `trueline_read` (e.g. `1-50:ab12cd34`)                          |
| `range`    | string   | `startLine:hash..endLine:hash` or `startLine:hash`; prefix `+` for insert-after     |
| `content`  | string   | Replacement lines, newline-separated. Empty string to delete range.                  |

### `trueline_diff`

Preview edits as a unified diff. Takes the same
parameters as `trueline_edit`.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install          # install dependencies
bun test             # run tests
bun run build        # build binary for the current platform
```

## Inspiration

Inspired by [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
by Can Boluk and the
[vscode-hashline-edit-tool](https://github.com/sethml/vscode-hashline-edit-tool)
by Seth Livingston.

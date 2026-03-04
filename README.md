# trueline-mcp

A [Claude Code](https://code.claude.com) MCP plugin for truth-verified file editing.

Each line is tagged with a short hash. Before writing, the server verifies that
the lines being replaced still match the hashes the agent observed — catching
stale edits caused by concurrent changes or model hallucination.

## Installation

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

The plugin binary is downloaded automatically on first use. No build step
required.

## How it works

`trueline_read` returns file content in trueline format. Each line is prefixed
with its line number and a 2-letter hash derived from FNV-1a 32-bit. A range
checksum (FNV-1a 32-bit, lower 16 bits, 4 hex chars) covers the lines read:

```
1:bq|import { Server } from "@modelcontextprotocol/sdk/server/index.js";
2:ab|
3:mz|const server = new Server({ name: "trueline-mcp", version: "0.1.0" });

checksum: 1-3:a4b5
```

`trueline_edit` takes a range specifier (`startLine:startHash..endLine:endHash`,
e.g. `"1:bq..3:mz"`) and the checksum from the read. Both are verified before
the write — if either has changed since the read, the edit is rejected.

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

## Tools

### `trueline_read`

Read a file and return its content with per-line hashes and a range checksum.

| Parameter    | Type    | Description                              |
|--------------|---------|------------------------------------------|
| `file_path`  | string  | Path to the file                         |
| `start_line` | integer | First line to read (default: 1)          |
| `end_line`   | integer | Last line to read (default: end of file) |

### `trueline_edit`

Apply one or more edits to a file with hash verification.

| Parameter   | Type  | Description                         |
|-------------|-------|-------------------------------------|
| `file_path` | string | Path to the file                   |
| `edits`     | array  | List of edit operations (see below) |

Each edit:

| Field          | Type    | Description                                                    |
|----------------|---------|----------------------------------------------------------------|
| `range`        | string  | `"startLine:startHash..endLine:endHash"` from `trueline_read`  |
| `content`      | string  | Replacement text (empty string to delete the range)            |
| `checksum`     | string  | Range checksum from `trueline_read`                            |
| `insert_after` | boolean | Insert `content` after the range instead of replacing it       |

### `trueline_diff`

Preview edits as a unified diff without writing to disk. Takes the same
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

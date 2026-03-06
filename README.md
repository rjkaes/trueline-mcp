# trueline-mcp

[![CI](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp) [![Last commit](https://img.shields.io/github/last-commit/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp/commits/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A [Claude Code](https://code.claude.com) MCP plugin that cuts context
usage and catches editing mistakes.

## Installation

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

## The problem

AI agents waste tokens in two ways:

1. **Reading too much.** To find a function in a 500-line file, the agent
   reads all 500 lines — most of which it doesn't need.

2. **Echoing on edit.** The built-in `Edit` tool requires the agent to
   output the old text being replaced (`old_string`) plus the new text.
   The old text is pure overhead.

Both problems compound. A typical editing session reads dozens of files
and makes multiple edits, burning through context on redundant content.

And when things go wrong — stale reads, hallucinated anchors, ambiguous
matches — the agent silently corrupts your code.

## How trueline fixes this

trueline replaces Claude Code's built-in `Read` and `Edit` with four
tools that are smaller, faster, and verified.

### 95% fewer input tokens with `trueline_outline`

Instead of reading an entire file to understand its structure,
`trueline_outline` returns a compact AST outline — just the functions,
classes, types, and declarations with their line ranges:

```
1-10: (10 imports)
12-12: const VERSION = pkg.version;
14-17: const server = new McpServer({
25-45: async function resolveAllowedDirs(): Promise<string[]> {
49-69: server.registerTool(
71-92: server.registerTool(

(12 symbols, 139 source lines)
```

12 lines instead of 139. The agent sees the full structure, picks the
ranges it needs, and reads only those — skipping hundreds of irrelevant
lines.

| File size   | Full read | Outline | Savings |
|-------------|-----------|---------|---------|
| 140 lines   | 140 tokens | 12 tokens | 91% |
| 245 lines   | 245 tokens | 14 tokens | 94% |
| 504 lines   | 504 tokens | 4 tokens  | 99% |

Every line range in the outline maps directly to a `trueline_read` call.

Supports 20+ languages: TypeScript, JavaScript, Python, Go, Rust, Java, C,
C++, C#, Ruby, PHP, Kotlin, Swift, Scala, Elixir, Lua, Dart, Zig, Bash.

### 44% fewer output tokens with `trueline_edit`

The built-in `Edit` makes the model echo back the text being replaced:

```json
// Built-in Edit — model must output the old text
{
  "old_string": "export function handleRequest(req: Request) {\n  ...\n}",
  "new_string": "export function handleRequest(req: Request) {\n  ...(new)...\n}"
}
```

`trueline_edit` replaces old text with a compact line-range reference:

```json
// trueline_edit — just the range and the new content
{
  "edits": [{
    "checksum": "1-50:a3b1c2d4",
    "range": "12:kf..16:qz",
    "content": "export function handleRequest(req: Request) {\n  ...(new)...\n}"
  }]
}
```

The model never echoes old text. For a typical 15-line edit:

| | Built-in Edit | trueline_edit |
|---|---|---|
| Old text echoed (output tokens) | ~225 | 0 |
| New text (output tokens) | ~225 | ~225 |
| Range/checksum overhead | 0 | ~13 |
| **Total output tokens** | **~470** | **~263** |
| **Savings** | | **44%** |

Output tokens are the most expensive token class. Cutting them by 44%
on every edit adds up fast.

### Targeted reads save more input tokens

`trueline_read` supports multiple disjoint ranges in a single call.
Instead of re-reading a 2000-line file to edit two distant sections,
the agent reads only the ranges it needs:

```
trueline_read(file_path: "big-file.ts", ranges: [{start: 45, end: 60}, {start: 200, end: 215}])
```

30 lines instead of 2000 — with separate checksums for each range.

### Hash verification catches mistakes

Every line from `trueline_read` carries a content hash. Every edit must
present those hashes back, proving the agent is working against the
file's actual content:

```
1:bx|import { Server } from "@modelcontextprotocol/sdk/server/index.js";
2:dd|
3:ew|const server = new Server({ name: "trueline-mcp", version: "0.1.0" });

checksum: 1-3:8a64a3f7
```

If anything changed since the read — concurrent edits, model
hallucination, stale context — the edit is rejected before any bytes
hit disk. Three layers of protection:

| Layer | What it catches |
|-------|----------------|
| Per-line hash | Changed content at edit boundaries |
| Range checksum | Any change within the read window |
| mtime guard | Concurrent modification by another process |

No more silent corruption. No more ambiguous string matches.

### Batch edits in one call

The built-in `Edit` handles one replacement per call. `trueline_edit`
accepts an array of edits applied atomically, cutting tool-call
overhead for multi-site changes.

## Workflow

```
trueline_outline (navigate)
    → trueline_read (targeted ranges)
    → trueline_diff (preview) [optional]
    → trueline_edit (apply)
```

A `SessionStart` hook injects instructions directing the agent to use
trueline tools. A `PreToolUse` hook blocks the built-in `Edit` tool and
redirects to the trueline workflow.

## Path access

By default, trueline tools can access files inside the project directory
(`CLAUDE_PROJECT_DIR`) and `~/.claude/`. To allow additional directories,
set `TRUELINE_ALLOWED_DIRS` to a colon-separated list of paths.

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

# trueline-mcp

[![CI](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp) [![Last commit](https://img.shields.io/github/last-commit/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp/commits/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A [Model Context Protocol](https://modelcontextprotocol.io/) plugin that cuts
context usage and catches editing mistakes. Works with Claude Code, Gemini CLI,
VS Code Copilot, OpenCode, and Codex CLI.

## Installation

**Claude Code** (recommended — hooks are automatic):

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

**Other platforms** (Gemini CLI, VS Code Copilot, OpenCode, Codex CLI):
See [INSTALL.md](INSTALL.md) for platform-specific setup instructions.

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

trueline replaces Claude Code's built-in `Read` and `Edit` with five
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

For exploratory reads where you don't plan to edit, pass `hashes: false`
to omit per-line hashes and save ~3 tokens per line. Checksums are
always included, so you can still use the output for subsequent edits
after a targeted re-read.

### Find-and-fix in one step with `trueline_search`

`trueline_search` finds lines by regex and returns them with context,
per-line hashes, and checksums — ready for immediate editing:

```
trueline_search(file_path: "server.ts", pattern: "validatePath", context_lines: 3)
```

Instead of outline → read → find the right lines, the agent goes
straight to the code it needs. In benchmarks, a search-based workflow
uses **~127 tokens** vs **~2000** for outline+read — a 93% reduction
for targeted lookups.

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

trueline_search (find pattern)
    → trueline_edit (immediate edit from search results)
```

A `SessionStart` hook injects instructions directing the agent to use
trueline tools. A `PreToolUse` hook blocks the built-in `Edit` tool and
redirects to the trueline workflow. On other platforms, equivalent hooks
are available via the `trueline-hook` CLI dispatcher — see
[INSTALL.md](INSTALL.md).

## Path access

By default, trueline tools can access files inside the project directory.
When running under Claude Code, `~/.claude/` is also allowed (it stores
plans, memory, and settings). To allow additional directories on any
platform, set `TRUELINE_ALLOWED_DIRS` to a colon-separated list of paths
(semicolon-separated on Windows).

## Runtime Engine Selection

trueline runs on Bun, Deno, and Node.js. It will use whichever runtime is
available on your system, but the choice matters for performance. Bun is the
fastest by a comfortable margin, followed by Deno, with Node.js coming in last.
If you have the option, install [Bun](https://bun.sh) — you'll notice the
difference on large files and batch edits.

## Benchmarks

Measured on Apple M4 Max (48 GB) with Bun 1.3.9. Edit times include a
fresh range-read for checksum verification.

| File size | Read (full) | Read (100 lines) | Edit (11-line replace) |
|-----------|-------------|-------------------|------------------------|
| 10 KB / 100 lines | 0.4 ms | 0.3 ms | 0.6 ms |
| 100 KB / 1K lines | 1.3 ms | 0.5 ms | 1.9 ms |
| 1 MB / 10K lines | 2.1 ms | 3.7 ms | 15.4 ms |
| 5 MB / 50K lines | 2.1 ms | 17.8 ms | 75.5 ms |
| 10 MB / 100K lines | 2.2 ms | 37.7 ms | 152 ms |

Full reads cap at ~2 ms for files above 1 MB because the 2,000-line output
limit triggers early truncation. Range reads and edits scale linearly with
file size since they stream the entire file.

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

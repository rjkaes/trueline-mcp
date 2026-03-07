# trueline-mcp

[![CI](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp) [![Last commit](https://img.shields.io/github/last-commit/rjkaes/trueline-mcp)](https://github.com/rjkaes/trueline-mcp/commits/main) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A [Model Context Protocol](https://modelcontextprotocol.io/) plugin that cuts
context usage and catches editing mistakes. Works with Claude Code, Gemini CLI,
VS Code Copilot, OpenCode, and Codex CLI.

## Installation

**Claude Code** (recommended; hooks are automatic):

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

**Other platforms** (Gemini CLI, VS Code Copilot, OpenCode, Codex CLI):
See [INSTALL.md](INSTALL.md) for platform-specific setup instructions.

## The problem

AI agents waste tokens in two ways:

1. **Reading too much.** To find a function in a 500-line file, the agent
   reads all 500 lines, most of which it doesn't need.

2. **Echoing on edit.** The built-in `Edit` tool requires the agent to
   output the old text being replaced (`old_string`) plus the new text.
   The old text is pure overhead.

Both problems compound. A typical editing session reads dozens of files
and makes multiple edits, burning through context on redundant content.

And when things go wrong (stale reads, hallucinated anchors, ambiguous
matches) the agent silently corrupts your code.

## How trueline fixes this

trueline replaces the built-in `Read` and `Edit` with five tools that
are smaller, faster, and verified.

### Read less: `trueline_outline` + `trueline_read`

Instead of reading an entire file, the agent starts with
`trueline_outline`, a compact AST outline showing just the functions,
classes, and declarations with their line ranges:

```
1-10: (10 imports)
12-12: const VERSION = pkg.version;
14-17: const server = new McpServer({
25-45: async function resolveAllowedDirs(): Promise<string[]> {
49-69: server.registerTool(
71-92: server.registerTool(

(12 symbols, 139 source lines)
```

12 lines instead of 139. The agent sees the full structure, then reads
only the ranges it needs, skipping hundreds of irrelevant lines.

| File size   | Full read | Outline | Savings |
|-------------|-----------|---------|--------|
| 140 lines   | 140 tokens | 12 tokens | 91% |
| 245 lines   | 245 tokens | 14 tokens | 94% |
| 504 lines   | 504 tokens | 4 tokens  | 99% |

`trueline_read` supports multiple disjoint ranges in a single call and
an optional `hashes: false` mode for exploratory reads that saves ~3
tokens per line.

### Find and fix: `trueline_search`

When the agent knows what it's looking for, `trueline_search` finds
lines by regex and returns them with enough context to edit immediately,
no outline or read step needed.

A search-based workflow uses **~127 tokens** vs **~2000** for
outline+read, a 93% reduction for targeted lookups.

### Write less: `trueline_edit`

The built-in `Edit` makes the model echo back the old text being
replaced. `trueline_edit` replaces that with a compact line-range
reference: the model only outputs the new content.

For a typical 15-line edit, that's **44% fewer output tokens**. Output
tokens are the most expensive token class, so this adds up fast.

Multiple edits can be batched in a single call and applied atomically.

### Never corrupt: hash verification

Every line from `trueline_read` carries a content hash. Every edit must
present those hashes back, proving the agent is working against the
file's actual content. If anything changed (concurrent edits, model
hallucination, stale context) the edit is rejected before any bytes hit
disk.

No more silent corruption. No more ambiguous string matches.

## Design

See [DESIGN.md](DESIGN.md) for the protocol specification, hash
algorithm details, streaming architecture, and security model.

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

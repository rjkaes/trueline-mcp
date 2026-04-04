# trueline-mcp

[![CI](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rjkaes/trueline-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io/) plugin that gives AI coding agents
hash-verified file editing and targeted reads. Works with Claude Code, Gemini
CLI, VS Code Copilot, OpenCode, and Codex CLI.

## Installation

**Claude Code** (recommended; hooks are automatic):

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

**Other platforms** (Gemini CLI, VS Code Copilot, OpenCode, Codex CLI):
See [INSTALL.md](INSTALL.md) for platform-specific setup.

**CLI (no MCP):** For agents that use shell commands instead of MCP, install
globally with `npm i -g trueline-mcp` and add `configs/cli/instructions.md`
to your agent's system prompt. See [INSTALL.md](INSTALL.md#cli-no-mcp).

## Why

AI coding agents read entire files to find one function, then echo back
everything they're replacing. Both waste context on content the agent already
knows or doesn't need. That context costs money, eats into the conversation
window, and limits how much real work fits in a session.

Worse, the built-in edit tools match by string content. If the agent
hallucinates a line, works from stale context, or hits an ambiguous match,
your code gets silently corrupted.

trueline fixes both problems: it reads less, writes less, and rejects every
edit that doesn't match the file's actual content.

## How it works

trueline provides six MCP tools organized around three workflows.

### Explore: understand before you read

`trueline_outline` returns an AST-based structural outline of any file:
functions, classes, declarations, and their line ranges. For a typical
source file, that's 10-20 lines instead of hundreds.

```
1-10: (10 imports)
12-12: const VERSION = pkg.version;
14-17: const server = new McpServer({
25-45: async function resolveAllowedDirs(): Promise<string[]> {
49-69: server.registerTool(
71-92: server.registerTool(

(12 symbols, 139 source lines)
```

The agent sees the full structure, then uses `trueline_read` to fetch only
the ranges it needs. Ranges are specified inline on each path:

```
file_paths: ["src/server.ts:25-45", "src/utils.ts:1-10,80-90"]
```

A 500-line file where the agent needs one 20-line function? It reads 20
lines, not 500. Multiple files with different ranges in a single call.

`trueline_search` finds lines by literal string or regex and returns them
with edit-ready refs, no outline or read step needed. For targeted
edits where the agent knows what it's looking for, this is the fastest path.

### Edit: compact and verified

The built-in edit tool requires the agent to echo back the old text being
replaced. `trueline_edit` replaces that with a compact line-range reference
and a content hash. The agent outputs only the new content.

The savings scale with the size of the replaced block. A one-line change
saves little; replacing 30 lines of old code saves the agent from
outputting all 30 of those lines again.

Multiple edits can be batched in a single call and applied atomically.

### Review: semantic diffs

`trueline_changes` provides an AST-based summary of structural changes
compared to a git ref. Instead of raw line diffs, it reports
added/removed/renamed symbols, signature changes, and logic modifications
with inline mini-diffs. Pass `["*"]` to diff all changed files at once.

### Hash verification: no silent corruption

Every line from `trueline_read` and `trueline_search` carries a content
hash. Every edit must present those hashes back, proving the agent is
editing what it thinks it's editing.

If the file changed since the agent read it (concurrent edits, a build
step, another tool), the edit is rejected. If the agent hallucinates
content that doesn't match what's on disk, the edit is rejected. If the
agent targets the wrong lines, the edit is rejected. Nothing hits disk
unless the hashes match.

`trueline_verify` checks whether held refs are still valid without
re-reading the file. When nothing changed (the common case), the response
is a single line.

## How agents actually use it

trueline doesn't just register tools and hope the agent picks them up.
On platforms that support hooks, it actively intercepts the agent's
workflow:

- **SessionStart** injects instructions telling the agent how and when
  to use each trueline tool, calibrated per platform.
- **PreToolUse** intercepts calls to the built-in read and edit tools,
  redirecting reads of files over 3 KB to trueline and blocking
  unverified edits entirely.

With hooks, agent compliance is ~98%. Without hooks (instruction-only
platforms like OpenCode and Codex CLI), compliance is ~60%. The
instruction file still helps; hooks make it reliable.

The instructions are not one-size-fits-all. They reference each
platform's native tool names (`Read`/`Edit` on Claude Code,
`read_file`/`edit_file` on Gemini CLI, `view`/`edit` on OpenCode) and
adapt advice accordingly.

## Where it helps most

trueline's overhead is an MCP round-trip per tool call. For small files
(under ~3 KB), the built-in tools are perfectly fine and pass through
without interception.

The payoff comes on larger files and multi-file editing sessions, where
targeted reads and compact edits avoid sending hundreds or thousands of
redundant lines through the context window.

In a typical 20-turn session exploring 8 files and editing 3, trueline
saves roughly 11,000 tokens of mid-session context plus 623 tokens per
turn from leaner instructions, for an estimated $1.58 per session in
reduced API cost.

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

## Special Thanks

<a href="https://github.com/domis86"><img src="https://avatars.githubusercontent.com/u/2327600?v=4" width="32"></a>

# Installation

trueline-mcp works with any AI coding agent that speaks MCP. Platform-specific
hooks bring compliance from ~60% (instruction-only) to ~98% (with hooks).

## Claude Code

Install from the plugin marketplace — no manual configuration needed:

```
/plugin marketplace add rjkaes/trueline-mcp
/plugin install trueline-mcp@trueline-mcp
```

Hooks (`SessionStart`, `PreToolUse`) are registered automatically via the
plugin's `hooks.json`.

## Gemini CLI

### 1. Add the MCP server

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "trueline": {
      "command": "npx",
      "args": ["-y", "trueline-mcp@latest"]
    }
  }
}
```

### 2. Add the instruction file

Copy `configs/gemini-cli/GEMINI.md` into your project root. This tells the
agent to prefer trueline tools over built-in `read_file` and `edit_file`.

### 3. Add hooks (optional, recommended)

Install trueline globally so the hook dispatcher is available:

```sh
npm i -g trueline-mcp
```

Then add to `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "command": "trueline-hook gemini-cli beforetool"
      }
    ]
  }
}
```

This intercepts `read_file` and `edit_file` calls and redirects them to
trueline equivalents.

## VS Code Copilot

### 1. Add the MCP server

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "trueline": {
      "command": "npx",
      "args": ["-y", "trueline-mcp@latest"]
    }
  }
}
```

### 2. Add the instruction file

Copy `configs/vscode-copilot/copilot-instructions.md` into your project's
`.github/` directory (or wherever your Copilot instructions live).

### 3. Add hooks (optional, recommended)

Install trueline globally:

```sh
npm i -g trueline-mcp
```

Then configure the hook in your VS Code Copilot agent settings to run:

```
trueline-hook vscode-copilot pretooluse
```

## OpenCode

### 1. Add the MCP server

Add to your `opencode.json`:

```json
{
  "mcp": {
    "trueline": {
      "command": "npx",
      "args": ["-y", "trueline-mcp@latest"]
    }
  }
}
```

### 2. Add the instruction file

Copy `configs/opencode/AGENTS.md` into your project root. This tells the
agent to use trueline tools instead of built-in `view` and `edit`.

### 3. Hooks

OpenCode uses in-process TypeScript plugins rather than JSON stdin/stdout
hooks. Hook support for OpenCode is not yet implemented — the instruction file
provides ~60% compliance on its own.

## Codex CLI

### 1. Add the MCP server

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.trueline]
command = "npx"
args = ["-y", "trueline-mcp@latest"]
```

### 2. Add the instruction file

Copy `configs/codex/AGENTS.md` into your project root. This tells the agent
to use trueline tools instead of `read_file` and `shell cat`.

### 3. Hooks

Codex CLI does not support hooks. The instruction file is the only mechanism
for tool redirection (~60% compliance).

## CLI hook dispatcher

The `trueline-hook` command is the universal entry point for hook integration:

```
trueline-hook <platform> <event>
```

| Platform       | Event          | Description                     |
|----------------|----------------|---------------------------------|
| gemini-cli     | beforetool     | Intercept tool calls            |
| gemini-cli     | session-start  | Inject trueline instructions    |
| vscode-copilot | pretooluse     | Intercept tool calls            |
| vscode-copilot | session-start  | Inject trueline instructions    |
| claude-code    | pretooluse     | Intercept tool calls            |
| claude-code    | session-start  | Inject trueline instructions    |

Install globally to make it available:

```sh
npm i -g trueline-mcp
```

## Path access

By default, trueline tools can access files inside the project directory.
When running under Claude Code, `~/.claude/` is also allowed (it stores
plans, memory, and settings). To allow additional directories on any
platform, set `TRUELINE_ALLOWED_DIRS` to a colon-separated list of paths
(semicolon-separated on Windows).

## Platform detection

The hook dispatcher auto-detects the platform from environment variables:

| Env var                | Platform       |
|------------------------|----------------|
| `GEMINI_PROJECT_DIR`   | gemini-cli     |
| `CLAUDE_PROJECT_DIR`   | claude-code    |

Override with `TRUELINE_PLATFORM=<platform>` if auto-detection doesn't work.

## Keeping trueline up to date

The recommended `npx -y trueline-mcp@latest` configuration checks the npm
registry on each launch and always runs the newest version. If you prefer
faster startup and offline resilience, drop the `@latest` suffix — npx will
use whichever version it cached on first install. You can update manually at
any time with `npm i -g trueline-mcp`.

Regardless of configuration, the server prints a notice to stderr when a newer
version is available (checked at most once every 24 hours). This notice is
never sent to the agent — it only appears in MCP server logs.

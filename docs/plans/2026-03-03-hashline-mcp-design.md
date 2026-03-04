# hashline-mcp Design

Claude Code plugin providing hash-verified file editing via MCP tools.
Ported from [claude-context-mode](https://github.com/mksglu/claude-context-mode)
`hashline.ts` and `security.ts`, rebuilt with TypeScript + Bun.

## Scope

Focused plugin — hashline read/edit/diff tools plus security enforcement.
No code execution, FTS5 knowledge base, or content indexing.

## Plugin Structure

```
hashline-mcp/
├── .claude-plugin/
│   └── plugin.json               # Plugin manifest
├── bin/                           # Compiled binaries per platform
│   ├── hashline-mcp-darwin-arm64
│   ├── hashline-mcp-darwin-x64
│   ├── hashline-mcp-linux-x64
│   ├── hashline-mcp-win32-x64.exe
│   └── hashline-mcp-win32-arm64.exe
├── hooks/
│   ├── hooks.json                 # PreToolUse hook config
│   └── pretooluse.ts              # Intercept Edit, enforce Read/Write deny
├── scripts/
│   └── resolve-binary.js          # Cross-platform binary launcher (Node.js)
├── src/
│   ├── server.ts                  # MCP server setup, tool registration
│   ├── hashline.ts                # FNV-1a, line hashing, formatting, editing
│   ├── security.ts                # 3-tier settings reader, file path deny
│   └── tools/
│       ├── read.ts                # hashline_read handler
│       ├── edit.ts                # hashline_edit handler
│       └── diff.ts                # hashline_diff handler
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

## Distribution

Single compiled binary per platform via `bun build --compile`. The plugin
manifest points at `scripts/resolve-binary.js` (Node.js, guaranteed
available) which detects `process.platform` + `process.arch` and spawns the
correct binary from `bin/`.

Targets:
- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-x64`
- `bun-windows-x64`
- `bun-windows-arm64`

## MCP Tools

### `hashline_read`

Read a file with hashline annotations: `{lineNumber}:{hash}|{content}`.

**Parameters:**
- `file_path` (string, required) — absolute or project-relative path
- `start_line` (number, optional) — 1-based first line (default: 1)
- `end_line` (number, optional) — 1-based last line (default: EOF)

**Security:** Evaluates `file_path` against Read deny patterns from 3-tier
settings before reading.

**Returns:** Hashline-formatted content + range checksum
(`"startLine-endLine:4hex"`).

### `hashline_edit`

Apply hash-verified edits to a file.

**Parameters:**
- `file_path` (string, required)
- `edits` (array):
  - `range` (string) — `"12:gh..21:yz"` start/end line:hash refs
  - `content` (string) — replacement text
  - `checksum` (string) — `"10-25:f7e2"` from prior `hashline_read`
  - `insert_after` (boolean, optional) — insertion mode

**Security:** Evaluates file path against Edit deny patterns.

**Behavior:**
1. Verify range checksums match current file content.
2. Verify line hashes at range boundaries.
3. Apply edits in descending line order (preserves earlier line numbers).
4. Write atomically (temp file + rename).
5. Return new hashline-formatted content for the affected region.

If verification fails, return error with instruction to re-read.

### `hashline_diff`

Preview edits as unified diff without writing to disk.

**Parameters:** Same as `hashline_edit`.

**Behavior:** Verifies checksums/hashes, computes result of applying edits,
returns unified diff (old vs new). Does not modify the file.

## Hooks

**PreToolUse hooks** registered in `hooks/hooks.json`:

### Edit interception

When Claude's built-in `Edit` tool is invoked, returns a message nudging
the agent to use `hashline_edit` instead. Ensures edits go through hash
verification rather than unverified string matching.

### Read deny enforcement

When `Read` is invoked, evaluates the file path against deny patterns from
the 3-tier settings. Blocks with explanation if denied.

### Write deny enforcement

When `Write` is invoked, same deny pattern evaluation as Read.

## Source Modules

### `src/hashline.ts`

Direct port from context-mode. Pure TypeScript, zero dependencies.

Functions:
- `fnv1aHash(line)` — FNV-1a 32-bit hash with inline UTF-8 encoding
- `lineHash(line)` — 2-letter content hash (676 values, matches
  vscode-hashline-edit-tool spec)
- `rangeChecksum(lines, start, end)` — range checksum as
  `"start-end:4hex"`
- `formatHashlinesFromArray(lines, startLine)` — format as
  `{num}:{hash}|{content}`
- `formatHashlines(content, startLine)` — split then format
- `parseLineHash(ref)` / `parseRange(range)` / `parseChecksum(checksum)`
- `verifyChecksum(lines, checksum)` / `verifyHashes(lines, refs)`
- `applyEdits(fileLines, ops)` — batch edit application
- `atomicWriteFile(filePath, content)` — temp file + rename

### `src/security.ts`

Scoped to file-path enforcement only — no Bash command evaluation.

Functions:
- `parseToolPattern(pattern)` — parse `"ToolName(glob)"` patterns
- `fileGlobToRegex(glob)` — file path glob to regex (`**` support)
- `readToolDenyPatterns(toolName, projectDir, globalPath)` — read deny
  globs from 3-tier settings (project local > project shared > global)
- `evaluateFilePath(filePath, denyGlobs)` — check path against deny
  patterns, normalize backslashes for cross-platform

### `src/server.ts`

MCP server using `@modelcontextprotocol/sdk`. Registers the three tools,
delegates to handler files in `tools/`. Resolves `CLAUDE_PROJECT_DIR` for
relative paths.

### `src/tools/read.ts`, `edit.ts`, `diff.ts`

One handler per tool. Each:
1. Validates and resolves file path
2. Evaluates security deny patterns
3. Performs hashline operation
4. Returns structured MCP result

## Technology

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Schema validation:** `zod`
- **Build:** `bun build --compile` for release binaries
- **Target:** ES2022, module: ESNext
- **No other runtime dependencies**

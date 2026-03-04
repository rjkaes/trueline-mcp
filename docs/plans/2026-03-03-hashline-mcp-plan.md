# hashline-mcp Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that provides hash-verified file editing via MCP tools, porting hashline and security concepts from claude-context-mode.

**Architecture:** TypeScript + Bun MCP server exposing three tools (`hashline_read`, `hashline_edit`, `hashline_diff`) with PreToolUse hooks for Edit interception and Read/Write deny enforcement. Compiled to single-file executables per platform.

**Tech Stack:** TypeScript (strict), Bun, `@modelcontextprotocol/sdk`, `zod`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "hashline-mcp",
  "version": "0.1.0",
  "type": "module",
  "description": "Claude Code MCP plugin for hash-verified file editing",
  "license": "MIT",
  "scripts": {
    "dev": "bun run src/server.ts",
    "build": "bun build src/server.ts --compile --outfile bin/hashline-mcp",
    "typecheck": "bun x tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.19.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build", "tests", "bin"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
build/
bin/
*.tgz
.DS_Store
```

**Step 4: Install dependencies**

Run: `bun install`
Expected: lockfile created, node_modules populated

**Step 5: Verify typecheck passes on empty project**

Run: `bun x tsc --noEmit`
Expected: no errors (no source files yet, clean exit)

**Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock
git commit -m "chore: scaffold hashline-mcp project with Bun + strict TypeScript"
```

---

### Task 2: Port hashline.ts

Port from `~/src/opensource/claude-context-mode/src/hashline.ts`. Direct
copy with one adjustment: the `EditOp` interface should be exported (the
tool handlers need it).

**Files:**
- Create: `src/hashline.ts`
- Create: `tests/hashline.test.ts`

**Step 1: Write tests for core hashing functions**

```typescript
import { describe, expect, test } from "bun:test";
import {
  fnv1aHash,
  lineHash,
  rangeChecksum,
  formatHashlines,
  formatHashlinesFromArray,
  parseLineHash,
  parseRange,
  parseChecksum,
  verifyChecksum,
  verifyHashes,
  applyEdits,
} from "../src/hashline.ts";

describe("fnv1aHash", () => {
  test("empty string produces FNV offset basis", () => {
    expect(fnv1aHash("")).toBe(2166136261);
  });

  test("deterministic for same input", () => {
    expect(fnv1aHash("hello")).toBe(fnv1aHash("hello"));
  });

  test("different inputs produce different hashes", () => {
    expect(fnv1aHash("hello")).not.toBe(fnv1aHash("world"));
  });

  test("handles multi-byte UTF-8", () => {
    const h = fnv1aHash("日本語");
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThan(0);
  });

  test("handles surrogate pairs (emoji)", () => {
    const h = fnv1aHash("🎉");
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThan(0);
  });
});

describe("lineHash", () => {
  test("returns exactly 2 lowercase letters", () => {
    const h = lineHash("console.log('hello')");
    expect(h).toMatch(/^[a-z]{2}$/);
  });

  test("deterministic", () => {
    expect(lineHash("foo")).toBe(lineHash("foo"));
  });

  test("empty line produces valid hash", () => {
    expect(lineHash("")).toMatch(/^[a-z]{2}$/);
  });
});

describe("rangeChecksum", () => {
  test("produces startLine-endLine:4hex format", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    expect(cs).toMatch(/^1-3:[0-9a-f]{4}$/);
  });

  test("deterministic for same content", () => {
    const lines = ["a", "b", "c"];
    expect(rangeChecksum(lines, 1, 3)).toBe(rangeChecksum(lines, 1, 3));
  });

  test("changes when content changes", () => {
    const lines1 = ["a", "b", "c"];
    const lines2 = ["a", "x", "c"];
    expect(rangeChecksum(lines1, 1, 3)).not.toBe(
      rangeChecksum(lines2, 1, 3),
    );
  });
});

describe("formatHashlines", () => {
  test("formats content with line numbers and hashes", () => {
    const result = formatHashlines("hello\nworld\n");
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|hello$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|world$/);
  });

  test("handles content without trailing newline", () => {
    const result = formatHashlines("single");
    expect(result).toMatch(/^1:[a-z]{2}\|single$/);
  });

  test("returns empty string for empty content", () => {
    expect(formatHashlines("")).toBe("");
  });

  test("respects startLine parameter", () => {
    const result = formatHashlines("hello\n", 10);
    expect(result).toMatch(/^10:[a-z]{2}\|hello$/);
  });
});

describe("formatHashlinesFromArray", () => {
  test("formats array of lines", () => {
    const result = formatHashlinesFromArray(["a", "b"], 1);
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|a$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|b$/);
  });

  test("returns empty for empty array", () => {
    expect(formatHashlinesFromArray([])).toBe("");
  });
});

describe("parseLineHash", () => {
  test("parses valid reference", () => {
    const ref = parseLineHash("4:mp");
    expect(ref).toEqual({ line: 4, hash: "mp" });
  });

  test("parses zero-line insert reference", () => {
    const ref = parseLineHash("0:");
    expect(ref).toEqual({ line: 0, hash: "" });
  });

  test("throws on missing colon", () => {
    expect(() => parseLineHash("4mp")).toThrow("missing colon");
  });

  test("throws on invalid hash", () => {
    expect(() => parseLineHash("4:M")).toThrow("2 lowercase letters");
  });

  test("throws on negative line", () => {
    expect(() => parseLineHash("-1:ab")).toThrow("non-negative integer");
  });
});

describe("parseRange", () => {
  test("parses valid range", () => {
    const r = parseRange("12:gh..21:yz");
    expect(r.start).toEqual({ line: 12, hash: "gh" });
    expect(r.end).toEqual({ line: 21, hash: "yz" });
  });

  test("parses single-line range", () => {
    const r = parseRange("5:ab..5:ab");
    expect(r.start.line).toBe(5);
    expect(r.end.line).toBe(5);
  });

  test("throws on missing separator", () => {
    expect(() => parseRange("12:gh-21:yz")).toThrow("..");
  });

  test("throws when start > end", () => {
    expect(() => parseRange("21:ab..12:cd")).toThrow("must be ≤");
  });
});

describe("parseChecksum", () => {
  test("parses valid checksum", () => {
    const cs = parseChecksum("10-25:f7e2");
    expect(cs).toEqual({ startLine: 10, endLine: 25, hash: "f7e2" });
  });

  test("throws on invalid hex", () => {
    expect(() => parseChecksum("1-2:ZZZZ")).toThrow("4 hex chars");
  });
});

describe("verifyChecksum", () => {
  test("returns null for valid checksum", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    expect(verifyChecksum(lines, cs)).toBeNull();
  });

  test("returns error for changed content", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    lines[1] = "changed";
    const err = verifyChecksum(lines, cs);
    expect(err).toContain("mismatch");
  });

  test("returns error when range exceeds file length", () => {
    const lines = ["only one"];
    const err = verifyChecksum(lines, "1-5:abcd");
    expect(err).toContain("exceeds");
  });
});

describe("verifyHashes", () => {
  test("returns null when all hashes match", () => {
    const lines = ["hello", "world"];
    const refs = [
      { line: 1, hash: lineHash("hello") },
      { line: 2, hash: lineHash("world") },
    ];
    expect(verifyHashes(lines, refs)).toBeNull();
  });

  test("returns error on hash mismatch", () => {
    const lines = ["hello", "world"];
    const refs = [{ line: 1, hash: "zz" }];
    const err = verifyHashes(lines, refs);
    expect(err).toContain("mismatch");
  });

  test("returns error on out-of-range line", () => {
    const lines = ["hello"];
    const refs = [{ line: 5, hash: "ab" }];
    const err = verifyHashes(lines, refs);
    expect(err).toContain("out of range");
  });

  test("allows zero-line insert ref", () => {
    expect(verifyHashes(["hello"], [{ line: 0, hash: "" }])).toBeNull();
  });
});

describe("applyEdits", () => {
  test("replaces a range of lines", () => {
    const lines = ["a", "b", "c", "d"];
    const result = applyEdits(lines, [
      {
        refs: [
          { line: 2, hash: lineHash("b") },
          { line: 3, hash: lineHash("c") },
        ],
        content: "x\ny",
        insertAfter: false,
      },
    ]);
    expect(result).toBe("a\nx\ny\nd\n");
  });

  test("inserts after a line", () => {
    const lines = ["a", "b", "c"];
    const result = applyEdits(lines, [
      {
        refs: [{ line: 1, hash: lineHash("a") }],
        content: "new",
        insertAfter: true,
      },
    ]);
    expect(result).toBe("a\nnew\nb\nc\n");
  });

  test("deletes lines when content is empty", () => {
    const lines = ["a", "b", "c"];
    const result = applyEdits(lines, [
      {
        refs: [{ line: 2, hash: lineHash("b") }],
        content: "",
        insertAfter: false,
      },
    ]);
    expect(result).toBe("a\nc\n");
  });

  test("handles multiple edits in correct order", () => {
    const lines = ["a", "b", "c", "d"];
    const result = applyEdits(lines, [
      {
        refs: [{ line: 1, hash: lineHash("a") }],
        content: "A",
        insertAfter: false,
      },
      {
        refs: [{ line: 4, hash: lineHash("d") }],
        content: "D",
        insertAfter: false,
      },
    ]);
    expect(result).toBe("A\nb\nc\nD\n");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/hashline.test.ts`
Expected: FAIL — `src/hashline.ts` does not exist yet

**Step 3: Copy and adapt hashline.ts**

Copy from `~/src/opensource/claude-context-mode/src/hashline.ts` to
`src/hashline.ts`. One change: export the `EditOp` interface (tool handlers
need it). The rest is identical — the file has zero external dependencies.

```bash
cp ~/src/opensource/claude-context-mode/src/hashline.ts src/hashline.ts
```

Then edit to export `EditOp`:

```typescript
// Change this:
interface EditOp {
// To this:
export interface EditOp {
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/hashline.test.ts`
Expected: all tests PASS

**Step 5: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 6: Commit**

```bash
git add src/hashline.ts tests/hashline.test.ts
git commit -m "feature: port hashline module from claude-context-mode

Direct port of FNV-1a hashing, line hashing, range checksums,
hashline formatting/parsing, edit application, and atomic file
writes. Only change from upstream: export \`EditOp\` interface
for use by tool handlers."
```

---

### Task 3: Port security.ts (file-path enforcement only)

Port the file-path-relevant subset of `security.ts`. Intentionally exclude
all Bash command evaluation functions since this plugin does not intercept
Bash.

**Files:**
- Create: `src/security.ts`
- Create: `tests/security.test.ts`

**Step 1: Write tests for security functions**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseToolPattern,
  fileGlobToRegex,
  readToolDenyPatterns,
  evaluateFilePath,
} from "../src/security.ts";

describe("parseToolPattern", () => {
  test("parses Read(.env)", () => {
    const result = parseToolPattern("Read(.env)");
    expect(result).toEqual({ tool: "Read", glob: ".env" });
  });

  test("parses Edit(**/*.secret)", () => {
    const result = parseToolPattern("Edit(**/*.secret)");
    expect(result).toEqual({ tool: "Edit", glob: "**/*.secret" });
  });

  test("handles nested parens", () => {
    const result = parseToolPattern("Read(some(path))");
    expect(result).toEqual({ tool: "Read", glob: "some(path)" });
  });

  test("returns null for non-pattern", () => {
    expect(parseToolPattern("justAString")).toBeNull();
  });

  test("returns null for Bash patterns", () => {
    // We still parse them, but tool will be "Bash"
    const result = parseToolPattern("Bash(sudo *)");
    expect(result?.tool).toBe("Bash");
  });
});

describe("fileGlobToRegex", () => {
  test("** matches any depth", () => {
    const re = fileGlobToRegex("**/*.env");
    expect(re.test("src/config/.env")).toBe(true);
    expect(re.test(".env")).toBe(true);
    expect(re.test("deep/nested/path/.env")).toBe(true);
  });

  test("* matches single segment", () => {
    const re = fileGlobToRegex("src/*.ts");
    expect(re.test("src/file.ts")).toBe(true);
    expect(re.test("src/nested/file.ts")).toBe(false);
  });

  test("? matches single character", () => {
    const re = fileGlobToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
  });

  test("exact match", () => {
    const re = fileGlobToRegex(".env");
    expect(re.test(".env")).toBe(true);
    expect(re.test("src/.env")).toBe(false);
  });

  test("case insensitive option", () => {
    const re = fileGlobToRegex("*.ENV", true);
    expect(re.test("config.env")).toBe(true);
    expect(re.test("config.ENV")).toBe(true);
  });
});

describe("readToolDenyPatterns", () => {
  test("reads deny patterns from project settings", () => {
    const tmp = mkdtempSync(join(tmpdir(), "security-test-"));
    const claudeDir = join(tmp, ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    // Create .claude/settings.json with deny patterns
    mkdtempSync; // unused, just for type
    require("fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          deny: ["Read(.env)", "Read(**/*.secret)", "Edit(**/*.key)"],
          allow: ["Bash(echo *)"],
        },
      }),
    );

    const patterns = readToolDenyPatterns("Read", tmp);
    // Should find Read patterns but not Edit or Bash
    expect(patterns.length).toBeGreaterThan(0);
    const flat = patterns.flat();
    expect(flat).toContain(".env");
    expect(flat).toContain("**/*.secret");
    expect(flat).not.toContain("**/*.key"); // Edit, not Read

    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns empty when no settings exist", () => {
    const patterns = readToolDenyPatterns("Read", "/nonexistent/path");
    expect(patterns).toEqual([]);
  });
});

describe("evaluateFilePath", () => {
  test("denies matching paths", () => {
    const result = evaluateFilePath("/project/.env", [[".env", "**/*.key"]]);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe(".env");
  });

  test("allows non-matching paths", () => {
    const result = evaluateFilePath(
      "/project/src/app.ts",
      [[".env", "**/*.key"]],
    );
    expect(result.denied).toBe(false);
  });

  test("normalizes backslashes", () => {
    const result = evaluateFilePath(
      "C:\\Users\\dev\\.env",
      [["**/.env"]],
    );
    expect(result.denied).toBe(true);
  });

  test("handles empty deny lists", () => {
    const result = evaluateFilePath("/project/file.ts", []);
    expect(result.denied).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/security.test.ts`
Expected: FAIL — `src/security.ts` does not exist yet

**Step 3: Create security.ts with file-path functions only**

Copy these functions from
`~/src/opensource/claude-context-mode/src/security.ts`:
- `parseToolPattern`
- `fileGlobToRegex` (and its helper `escapeRegex`)
- `readToolDenyPatterns`
- `evaluateFilePath`

Exclude everything Bash-related: `parseBashPattern`, `globToRegex`,
`splitChainedCommands`, `matchesAnyPattern`, `readBashPolicies`,
`evaluateCommand`, `evaluateCommandDenyOnly`, `extractShellCommands`,
and the `SHELL_ESCAPE_PATTERNS` constant.

The file should start with:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
```

Keep only the types needed for file-path evaluation. No
`SecurityPolicy`, no `PermissionDecision`, no `CommandDecision`.

**Step 4: Run tests to verify they pass**

Run: `bun test tests/security.test.ts`
Expected: all tests PASS

**Step 5: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 6: Commit**

```bash
git add src/security.ts tests/security.test.ts
git commit -m "feature: port security module (file-path enforcement only)

Subset of claude-context-mode's security.ts: \`parseToolPattern\`,
\`fileGlobToRegex\`, \`readToolDenyPatterns\`, \`evaluateFilePath\`.

Intentionally excludes all Bash command evaluation (command
splitting, shell-escape scanning, \`evaluateCommand\`) since this
plugin does not intercept Bash tool calls."
```

---

### Task 4: MCP Server Skeleton + hashline_read Tool

**Files:**
- Create: `src/server.ts`
- Create: `src/tools/read.ts`
- Create: `tests/tools/read.test.ts`

**Step 1: Write tests for the read tool handler**

The read handler is a pure function that takes a file path and options,
returns hashline-formatted content. Test it directly without MCP transport.

```typescript
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "hashline-read-test-"));
  testFile = join(testDir, "sample.ts");
  writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  // Create .claude/settings.json with a deny pattern
  const claudeDir = join(testDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      permissions: { deny: ["Read(.env)", "Read(**/*.secret)"] },
    }),
  );

  // Create a denied file
  writeFileSync(join(testDir, ".env"), "SECRET=abc\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleRead", () => {
  test("returns hashline-formatted content", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter(Boolean);
    // Should have 3 content lines + checksum line
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|const a = 1;$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|const b = 2;$/);
    expect(lines[2]).toMatch(/^3:[a-z]{2}\|const c = 3;$/);
  });

  test("returns checksum in result", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Last line should be the checksum
    expect(text).toContain("checksum:");
  });

  test("supports start_line and end_line", async () => {
    const result = await handleRead({
      file_path: testFile,
      start_line: 2,
      end_line: 2,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    const contentLines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0]).toMatch(/^2:[a-z]{2}\|const b = 2;$/);
  });

  test("denies reading .env file", async () => {
    const result = await handleRead({
      file_path: join(testDir, ".env"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
  });

  test("returns error for nonexistent file", async () => {
    const result = await handleRead({
      file_path: join(testDir, "nope.ts"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/read.test.ts`
Expected: FAIL — files don't exist yet

**Step 3: Implement src/tools/read.ts**

```typescript
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  formatHashlinesFromArray,
  rangeChecksum,
} from "../hashline.ts";
import {
  readToolDenyPatterns,
  evaluateFilePath,
} from "../security.ts";

interface ReadParams {
  file_path: string;
  start_line?: number;
  end_line?: number;
  projectDir?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleRead(params: ReadParams): Promise<ToolResult> {
  const { file_path, start_line, end_line, projectDir } = params;

  // Resolve path relative to project dir if not absolute
  const resolvedPath = file_path.startsWith("/")
    ? file_path
    : resolve(projectDir ?? process.cwd(), file_path);

  // Security: check deny patterns
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const pathToCheck = basename(resolvedPath);
  const { denied, matchedPattern } = evaluateFilePath(
    resolvedPath,
    denyGlobs,
  );
  if (denied) {
    return {
      content: [
        {
          type: "text",
          text: `Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`,
        },
      ],
      isError: true,
    };
  }

  // Read file
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading file: ${msg}` }],
      isError: true,
    };
  }

  // Split into lines
  const allLines = content.split("\n");
  // Drop trailing empty element from trailing newline
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  // Resolve range
  const start = start_line ?? 1;
  const end = end_line ?? allLines.length;

  if (start < 1 || start > allLines.length) {
    return {
      content: [
        {
          type: "text",
          text: `start_line ${start} out of range (file has ${allLines.length} lines)`,
        },
      ],
      isError: true,
    };
  }

  const clampedEnd = Math.min(end, allLines.length);
  const slice = allLines.slice(start - 1, clampedEnd);

  // Format
  const formatted = formatHashlinesFromArray(slice, start);
  const checksum = rangeChecksum(allLines, start, clampedEnd);

  const text = `${formatted}\n\nchecksum: ${checksum}`;

  return { content: [{ type: "text", text }] };
}
```

**Step 4: Implement src/server.ts (skeleton with read tool)**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleRead } from "./tools/read.ts";

const VERSION = "0.1.0";

const server = new McpServer({
  name: "hashline-mcp",
  version: VERSION,
});

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

server.registerTool(
  "hashline_read",
  {
    description:
      "Read a file with hashline annotations. Returns content as " +
      "{lineNumber}:{hash}|{content} with a range checksum for " +
      "verified editing.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute or project-relative file path"),
      start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based first line to read (default: 1)"),
      end_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based last line to read (default: end of file)"),
    }),
  },
  async (params) => {
    return handleRead({ ...params, projectDir });
  },
);

// Tools for edit and diff will be registered in subsequent tasks.

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 5: Create src/tools/ directory structure**

Run: `mkdir -p src/tools tests/tools`

**Step 6: Run tests to verify they pass**

Run: `bun test tests/tools/read.test.ts`
Expected: all tests PASS

**Step 7: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 8: Smoke test the MCP server**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | bun run src/server.ts`
Expected: JSON response with server info including `hashline_read` in tools

**Step 9: Commit**

```bash
git add src/server.ts src/tools/read.ts tests/tools/read.test.ts
git commit -m "feature: add MCP server skeleton with hashline_read tool

Registers hashline_read via @modelcontextprotocol/sdk. The tool:
- Reads files with hashline annotations ({lineNumber}:{hash}|{content})
- Returns range checksum for subsequent verified edits
- Enforces Read deny patterns from 3-tier Claude settings
- Supports start_line/end_line for partial reads"
```

---

### Task 5: hashline_edit Tool

**Files:**
- Create: `src/tools/edit.ts`
- Create: `tests/tools/edit.test.ts`
- Modify: `src/server.ts` — register `hashline_edit`

**Step 1: Write tests for the edit tool handler**

```typescript
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, rangeChecksum } from "../../src/hashline.ts";

let testDir: string;
let testFile: string;

// Fresh file before each test
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "hashline-edit-test-"));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\n");
});

afterAll(() => {
  // cleanup handled per-test via beforeEach creating new dirs
});

describe("handleEdit", () => {
  test("replaces a range of lines", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          range: `2:${h2}..3:${h3}`,
          content: "replaced 2\nreplaced 3",
          checksum: cs,
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("inserts after a line", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          range: `1:${h1}..1:${h1}`,
          content: "inserted",
          checksum: cs,
          insert_after: true,
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\ninserted\nline 2\nline 3\nline 4\n");
  });

  test("rejects stale checksum", async () => {
    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          range: "1:aa..1:aa",
          content: "nope",
          checksum: "1-4:0000", // wrong checksum
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("rejects wrong line hash", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          range: "1:zz..1:zz", // wrong hash
          content: "nope",
          checksum: cs,
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("denies editing .env file", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Edit(.env)", "Edit(**/.env)"] },
      }),
    );
    const envFile = join(testDir, ".env");
    writeFileSync(envFile, "SECRET=x\n");

    const lines = ["SECRET=x"];
    const cs = rangeChecksum(lines, 1, 1);
    const h = lineHash("SECRET=x");

    const result = await handleEdit({
      file_path: envFile,
      edits: [{ range: `1:${h}..1:${h}`, content: "hacked", checksum: cs }],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/edit.test.ts`
Expected: FAIL

**Step 3: Implement src/tools/edit.ts**

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRange,
  verifyChecksum,
  verifyHashes,
  applyEdits,
  atomicWriteFile,
  formatHashlinesFromArray,
  rangeChecksum,
  type EditOp,
  type LineRef,
} from "../hashline.ts";
import { readToolDenyPatterns, evaluateFilePath } from "../security.ts";

interface EditInput {
  range: string;
  content: string;
  checksum: string;
  insert_after?: boolean;
}

interface EditParams {
  file_path: string;
  edits: EditInput[];
  projectDir?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const { file_path, edits, projectDir } = params;

  const resolvedPath = file_path.startsWith("/")
    ? file_path
    : resolve(projectDir ?? process.cwd(), file_path);

  // Security: check deny patterns for Edit
  const denyGlobs = readToolDenyPatterns("Edit", projectDir);
  const { denied, matchedPattern } = evaluateFilePath(resolvedPath, denyGlobs);
  if (denied) {
    return {
      content: [
        {
          type: "text",
          text: `Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`,
        },
      ],
      isError: true,
    };
  }

  // Read current file
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading file: ${msg}` }],
      isError: true,
    };
  }

  const fileLines = content.split("\n");
  if (fileLines.length > 1 && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }

  // Validate and build edit operations
  const ops: EditOp[] = [];

  for (const edit of edits) {
    // Verify checksum
    const checksumErr = verifyChecksum(fileLines, edit.checksum);
    if (checksumErr) {
      return {
        content: [{ type: "text", text: checksumErr }],
        isError: true,
      };
    }

    // Parse range
    const rangeRef = parseRange(edit.range);

    // Build refs array for all lines in range
    const refs: LineRef[] = [];
    for (let l = rangeRef.start.line; l <= rangeRef.end.line; l++) {
      const hash =
        l === rangeRef.start.line
          ? rangeRef.start.hash
          : l === rangeRef.end.line
            ? rangeRef.end.hash
            : undefined;
      if (hash !== undefined) {
        refs.push({ line: l, hash });
      } else {
        // Intermediate lines — include but don't verify hash
        refs.push({
          line: l,
          hash: fileLines[l - 1] !== undefined
            ? (await import("../hashline.ts")).lineHash(fileLines[l - 1])
            : "",
        });
      }
    }

    // Verify line hashes
    const hashErr = verifyHashes(fileLines, [rangeRef.start, rangeRef.end]);
    if (hashErr) {
      return {
        content: [{ type: "text", text: hashErr }],
        isError: true,
      };
    }

    ops.push({
      refs,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
    });
  }

  // Apply edits and write
  const newContent = applyEdits(fileLines, ops);
  atomicWriteFile(resolvedPath, newContent);

  // Return updated hashlines for the affected region
  const newLines = newContent.split("\n");
  if (newLines.length > 1 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }

  const formatted = formatHashlinesFromArray(newLines, 1);
  const newChecksum = rangeChecksum(newLines, 1, newLines.length);

  return {
    content: [
      {
        type: "text",
        text: `Edit applied successfully.\n\n${formatted}\n\nchecksum: ${newChecksum}`,
      },
    ],
  };
}
```

**Step 4: Register hashline_edit in server.ts**

Add to `src/server.ts` after the `hashline_read` registration:

```typescript
import { handleEdit } from "./tools/edit.ts";

server.registerTool(
  "hashline_edit",
  {
    description:
      "Apply hash-verified edits to a file. Edits are verified " +
      "against checksums and line hashes from a prior hashline_read. " +
      "If the file has changed, returns an error.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute or project-relative file path"),
      edits: z.array(
        z.object({
          range: z
            .string()
            .describe('Line range "startLine:hash..endLine:hash"'),
          content: z.string().describe("Replacement text"),
          checksum: z
            .string()
            .describe("Range checksum from hashline_read"),
          insert_after: z
            .boolean()
            .optional()
            .describe("Insert after the range instead of replacing"),
        }),
      ),
    }),
  },
  async (params) => {
    return handleEdit({ ...params, projectDir });
  },
);
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/tools/edit.test.ts`
Expected: all tests PASS

**Step 6: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 7: Commit**

```bash
git add src/tools/edit.ts tests/tools/edit.test.ts src/server.ts
git commit -m "feature: add hashline_edit tool with hash verification

Applies edits only after verifying:
- Range checksums match current file content
- Line hashes at range boundaries are correct

Writes atomically (temp file + rename). Returns updated
hashline-formatted content with new checksum after edit.
Enforces Edit deny patterns from 3-tier settings."
```

---

### Task 6: hashline_diff Tool

**Files:**
- Create: `src/tools/diff.ts`
- Create: `tests/tools/diff.test.ts`
- Modify: `src/server.ts` — register `hashline_diff`

**Step 1: Write tests for the diff tool handler**

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDiff } from "../../src/tools/diff.ts";
import { lineHash, rangeChecksum } from "../../src/hashline.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "hashline-diff-test-"));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, "line 1\nline 2\nline 3\n");
});

describe("handleDiff", () => {
  test("returns unified diff for replacement", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleDiff({
      file_path: testFile,
      edits: [
        {
          range: `2:${h2}..2:${h2}`,
          content: "CHANGED",
          checksum: cs,
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-line 2");
    expect(text).toContain("+CHANGED");
  });

  test("does not modify the file", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");

    await handleDiff({
      file_path: testFile,
      edits: [
        {
          range: `1:${h1}..1:${h1}`,
          content: "CHANGED",
          checksum: cs,
        },
      ],
      projectDir: testDir,
    });

    // File should be unchanged
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(testFile, "utf-8");
    expect(content).toBe("line 1\nline 2\nline 3\n");
  });

  test("rejects stale checksum", async () => {
    const result = await handleDiff({
      file_path: testFile,
      edits: [
        {
          range: "1:zz..1:zz",
          content: "nope",
          checksum: "1-3:0000",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/diff.test.ts`
Expected: FAIL

**Step 3: Implement src/tools/diff.ts**

The diff handler shares verification logic with edit but produces a unified
diff instead of writing. Use a simple line-by-line diff since we know the
exact lines being changed.

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRange,
  verifyChecksum,
  verifyHashes,
  applyEdits,
  lineHash,
  type EditOp,
  type LineRef,
} from "../hashline.ts";
import { readToolDenyPatterns, evaluateFilePath } from "../security.ts";

interface DiffInput {
  range: string;
  content: string;
  checksum: string;
  insert_after?: boolean;
}

interface DiffParams {
  file_path: string;
  edits: DiffInput[];
  projectDir?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Produce a simple unified-style diff between two arrays of lines.
 */
function unifiedDiff(
  oldLines: string[],
  newLines: string[],
  filePath: string,
): string {
  const out: string[] = [];
  out.push(`--- a/${filePath}`);
  out.push(`+++ b/${filePath}`);

  // Simple approach: output full file diff with context
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      // Find the extent of the change
      // Output removed lines
      const oldStart = i;
      while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        // Look ahead to see if this old line appears soon in new
        let found = false;
        for (let k = j; k < Math.min(j + 5, newLines.length); k++) {
          if (oldLines[i] === newLines[k]) { found = true; break; }
        }
        if (found) break;
        out.push(`-${oldLines[i]}`);
        i++;
      }
      // Output added lines
      while (j < newLines.length && (i >= oldLines.length || newLines[j] !== oldLines[i])) {
        let found = false;
        for (let k = i; k < Math.min(i + 5, oldLines.length); k++) {
          if (newLines[j] === oldLines[k]) { found = true; break; }
        }
        if (found) break;
        out.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  return out.join("\n");
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { file_path, edits, projectDir } = params;

  const resolvedPath = file_path.startsWith("/")
    ? file_path
    : resolve(projectDir ?? process.cwd(), file_path);

  // Security: check deny patterns for Read (diff needs read access)
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const { denied, matchedPattern } = evaluateFilePath(resolvedPath, denyGlobs);
  if (denied) {
    return {
      content: [
        {
          type: "text",
          text: `Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`,
        },
      ],
      isError: true,
    };
  }

  // Read current file
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading file: ${msg}` }],
      isError: true,
    };
  }

  const fileLines = content.split("\n");
  if (fileLines.length > 1 && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }

  // Validate edits (same logic as handleEdit)
  const ops: EditOp[] = [];

  for (const edit of edits) {
    const checksumErr = verifyChecksum(fileLines, edit.checksum);
    if (checksumErr) {
      return {
        content: [{ type: "text", text: checksumErr }],
        isError: true,
      };
    }

    const rangeRef = parseRange(edit.range);

    const hashErr = verifyHashes(fileLines, [rangeRef.start, rangeRef.end]);
    if (hashErr) {
      return {
        content: [{ type: "text", text: hashErr }],
        isError: true,
      };
    }

    const refs: LineRef[] = [];
    for (let l = rangeRef.start.line; l <= rangeRef.end.line; l++) {
      refs.push({
        line: l,
        hash: fileLines[l - 1] !== undefined ? lineHash(fileLines[l - 1]) : "",
      });
    }

    ops.push({
      refs,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
    });
  }

  // Compute new content WITHOUT writing
  const newContent = applyEdits(fileLines, ops);
  const newLines = newContent.split("\n");
  if (newLines.length > 1 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }

  const relativePath = file_path.startsWith("/")
    ? file_path.split("/").pop() ?? file_path
    : file_path;
  const diff = unifiedDiff(fileLines, newLines, relativePath);

  return {
    content: [{ type: "text", text: diff }],
  };
}
```

**Step 4: Register hashline_diff in server.ts**

Add to `src/server.ts`:

```typescript
import { handleDiff } from "./tools/diff.ts";

server.registerTool(
  "hashline_diff",
  {
    description:
      "Preview edits as a unified diff without writing to disk. " +
      "Same parameters as hashline_edit. Use this to confirm " +
      "intent before applying changes.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute or project-relative file path"),
      edits: z.array(
        z.object({
          range: z
            .string()
            .describe('Line range "startLine:hash..endLine:hash"'),
          content: z.string().describe("Replacement text"),
          checksum: z
            .string()
            .describe("Range checksum from hashline_read"),
          insert_after: z
            .boolean()
            .optional()
            .describe("Insert after the range instead of replacing"),
        }),
      ),
    }),
  },
  async (params) => {
    return handleDiff({ ...params, projectDir });
  },
);
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/tools/diff.test.ts`
Expected: all tests PASS

**Step 6: Run all tests**

Run: `bun test`
Expected: all tests PASS across all test files

**Step 7: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 8: Commit**

```bash
git add src/tools/diff.ts tests/tools/diff.test.ts src/server.ts
git commit -m "feature: add hashline_diff tool for edit preview

Previews edits as unified diff without writing to disk. Shares
verification logic with hashline_edit (checksums + line hashes)
but produces diff output instead of modifying the file."
```

---

### Task 7: PreToolUse Hooks

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/pretooluse.ts`
- Create: `tests/hooks/pretooluse.test.ts`

**Step 1: Write tests for hook behavior**

The hook reads JSON from stdin and writes JSON to stdout. Test it as a
function rather than spawning a process.

```typescript
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processHookEvent } from "../../hooks/pretooluse.ts";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "hashline-hook-test-"));
  const claudeDir = join(testDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      permissions: { deny: ["Read(.env)", "Write(.env)"] },
    }),
  );
  writeFileSync(join(testDir, ".env"), "SECRET=x\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("PreToolUse hook", () => {
  test("intercepts Edit and suggests hashline_edit", () => {
    const result = processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: join(testDir, "app.ts"), old_string: "x", new_string: "y" },
      project_dir: testDir,
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("hashline_edit");
  });

  test("blocks Read on denied file", () => {
    const result = processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: join(testDir, ".env") },
      project_dir: testDir,
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("denied");
  });

  test("allows Read on non-denied file", () => {
    const result = processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: join(testDir, "app.ts") },
      project_dir: testDir,
    });
    expect(result.decision).toBe("approve");
  });

  test("blocks Write on denied file", () => {
    const result = processHookEvent({
      tool_name: "Write",
      tool_input: { file_path: join(testDir, ".env") },
      project_dir: testDir,
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("denied");
  });

  test("allows Write on non-denied file", () => {
    const result = processHookEvent({
      tool_name: "Write",
      tool_input: { file_path: join(testDir, "app.ts") },
      project_dir: testDir,
    });
    expect(result.decision).toBe("approve");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/pretooluse.test.ts`
Expected: FAIL

**Step 3: Implement hooks/pretooluse.ts**

```typescript
import { readToolDenyPatterns, evaluateFilePath } from "../src/security.ts";

interface HookEvent {
  tool_name: string;
  tool_input: Record<string, unknown>;
  project_dir?: string;
}

interface HookResult {
  decision: "approve" | "block";
  reason?: string;
}

export function processHookEvent(event: HookEvent): HookResult {
  const { tool_name, tool_input, project_dir } = event;

  // Edit interception: nudge toward hashline_edit
  if (tool_name === "Edit") {
    return {
      decision: "block",
      reason:
        "Use hashline_edit instead of Edit for hash-verified editing. " +
        "First call hashline_read to get line hashes and checksums, " +
        "then use hashline_edit with those values.",
    };
  }

  // Read deny enforcement
  if (tool_name === "Read") {
    const filePath = tool_input.file_path;
    if (typeof filePath !== "string") return { decision: "approve" };

    const denyGlobs = readToolDenyPatterns("Read", project_dir);
    const { denied, matchedPattern } = evaluateFilePath(filePath, denyGlobs);
    if (denied) {
      return {
        decision: "block",
        reason: `Access denied: "${filePath}" matched Read deny pattern "${matchedPattern}"`,
      };
    }
    return { decision: "approve" };
  }

  // Write deny enforcement
  if (tool_name === "Write") {
    const filePath = tool_input.file_path;
    if (typeof filePath !== "string") return { decision: "approve" };

    const denyGlobs = readToolDenyPatterns("Write", project_dir);
    const { denied, matchedPattern } = evaluateFilePath(filePath, denyGlobs);
    if (denied) {
      return {
        decision: "block",
        reason: `Access denied: "${filePath}" matched Write deny pattern "${matchedPattern}"`,
      };
    }
    return { decision: "approve" };
  }

  return { decision: "approve" };
}

// Main: read hook event from stdin, write result to stdout
if (import.meta.main) {
  const input = await Bun.stdin.text();
  const event = JSON.parse(input) as HookEvent;

  // CLAUDE_PROJECT_DIR is set by Claude Code
  if (!event.project_dir && process.env.CLAUDE_PROJECT_DIR) {
    event.project_dir = process.env.CLAUDE_PROJECT_DIR;
  }

  const result = processHookEvent(event);
  process.stdout.write(JSON.stringify(result));
}
```

**Step 4: Create hooks/hooks.json**

```json
{
  "description": "hashline-mcp PreToolUse — intercepts Edit, enforces Read/Write deny patterns",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bun ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.ts"
          }
        ]
      },
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "bun ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.ts"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "bun ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.ts"
          }
        ]
      }
    ]
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/hooks/pretooluse.test.ts`
Expected: all tests PASS

**Step 6: Run all tests**

Run: `bun test`
Expected: all tests PASS

**Step 7: Commit**

```bash
git add hooks/hooks.json hooks/pretooluse.ts tests/hooks/pretooluse.test.ts
git commit -m "feature: add PreToolUse hooks for Edit intercept and deny enforcement

Three hooks:
- Edit: blocks and redirects to hashline_edit
- Read: enforces deny patterns from 3-tier Claude settings
- Write: same deny enforcement as Read

Hook reads JSON from stdin (Claude Code hook protocol),
evaluates the event, and writes decision JSON to stdout."
```

---

### Task 8: Plugin Manifest and Distribution Scripts

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `scripts/resolve-binary.js`
- Modify: `package.json` — add cross-compile build scripts

**Step 1: Create plugin.json**

```json
{
  "name": "hashline-mcp",
  "version": "0.1.0",
  "description": "Hash-verified file editing for Claude Code agents",
  "author": {
    "name": "rjk"
  },
  "license": "MIT",
  "keywords": ["mcp", "hashline", "editing", "verification"],
  "mcpServers": {
    "hashline-mcp": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/resolve-binary.js"]
    }
  }
}
```

**Step 2: Create resolve-binary.js**

```javascript
#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const platform = process.platform;
const arch = process.arch;
const ext = platform === "win32" ? ".exe" : "";

const binary = path.join(
  __dirname,
  "..",
  "bin",
  `hashline-mcp-${platform}-${arch}${ext}`,
);

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (err) => {
  console.error(`Failed to start ${binary}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
```

**Step 3: Add cross-compile scripts to package.json**

Add to the `"scripts"` section:

```json
"build:darwin-arm64": "bun build src/server.ts --compile --target=bun-darwin-arm64 --outfile bin/hashline-mcp-darwin-arm64",
"build:darwin-x64": "bun build src/server.ts --compile --target=bun-darwin-x64 --outfile bin/hashline-mcp-darwin-x64",
"build:linux-x64": "bun build src/server.ts --compile --target=bun-linux-x64 --outfile bin/hashline-mcp-linux-x64",
"build:win32-x64": "bun build src/server.ts --compile --target=bun-windows-x64 --outfile bin/hashline-mcp-win32-x64.exe",
"build:win32-arm64": "bun build src/server.ts --compile --target=bun-windows-arm64 --outfile bin/hashline-mcp-win32-arm64.exe",
"build:all": "bun run build:darwin-arm64 && bun run build:darwin-x64 && bun run build:linux-x64 && bun run build:win32-x64 && bun run build:win32-arm64"
```

**Step 4: Test local binary compilation**

Run: `bun run build`
Expected: `bin/hashline-mcp` binary created

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | ./bin/hashline-mcp`
Expected: JSON response with server info

**Step 5: Commit**

```bash
git add .claude-plugin/plugin.json scripts/resolve-binary.js package.json
git commit -m "feature: add plugin manifest and cross-platform binary resolver

Plugin manifest declares MCP server via resolve-binary.js which
detects platform/arch and spawns the correct compiled binary.

Build scripts added for all 5 targets:
  darwin-arm64, darwin-x64, linux-x64, win32-x64, win32-arm64"
```

---

### Task 9: Final Integration Test and Cleanup

**Files:**
- Create: `tests/integration.test.ts`
- Modify: `package.json` — verify all scripts work

**Step 1: Write integration test**

End-to-end test: read a file, edit it, verify with diff.

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../src/tools/read.ts";
import { handleEdit } from "../src/tools/edit.ts";
import { handleDiff } from "../src/tools/diff.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "hashline-integration-"));
  testFile = join(testDir, "app.ts");
  writeFileSync(
    testFile,
    'function greet(name: string) {\n  return "Hello, " + name;\n}\n',
  );
});

describe("read → diff → edit roundtrip", () => {
  test("complete workflow", async () => {
    // Step 1: Read the file
    const readResult = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();
    const readText = readResult.content[0].text;

    // Extract checksum from read result
    const checksumMatch = readText.match(/checksum: (.+)$/m);
    expect(checksumMatch).not.toBeNull();
    const checksum = checksumMatch![1];

    // Extract line 2 hash from read result
    const line2Match = readText.match(/^2:([a-z]{2})\|/m);
    expect(line2Match).not.toBeNull();
    const line2Hash = line2Match![1];

    // Step 2: Preview the edit with diff
    const diffResult = await handleDiff({
      file_path: testFile,
      edits: [
        {
          range: `2:${line2Hash}..2:${line2Hash}`,
          content: '  return `Hello, ${name}!`;',
          checksum,
        },
      ],
      projectDir: testDir,
    });
    expect(diffResult.isError).toBeUndefined();
    const diffText = diffResult.content[0].text;
    expect(diffText).toContain("-");
    expect(diffText).toContain("+");

    // Verify file unchanged after diff
    const beforeEdit = readFileSync(testFile, "utf-8");
    expect(beforeEdit).toContain('"Hello, " + name');

    // Step 3: Apply the edit
    const editResult = await handleEdit({
      file_path: testFile,
      edits: [
        {
          range: `2:${line2Hash}..2:${line2Hash}`,
          content: '  return `Hello, ${name}!`;',
          checksum,
        },
      ],
      projectDir: testDir,
    });
    expect(editResult.isError).toBeUndefined();

    // Step 4: Verify file changed
    const afterEdit = readFileSync(testFile, "utf-8");
    expect(afterEdit).toContain("`Hello, ${name}!`");
    expect(afterEdit).not.toContain('"Hello, " + name');

    // Step 5: Re-read and verify new hashes work
    const rereadResult = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(rereadResult.isError).toBeUndefined();
  });
});
```

**Step 2: Run all tests**

Run: `bun test`
Expected: all tests PASS across all files

**Step 3: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 4: Verify build works**

Run: `bun run build`
Expected: binary created successfully

**Step 5: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add integration test for read → diff → edit roundtrip

Exercises the complete workflow: read file with hashlines, preview
edit with diff (verify file unchanged), apply edit, verify file
changed, re-read to confirm new hashes."
```

---

### Task 10: Refactor — Extract Shared Verification Logic

After tasks 5 and 6, `edit.ts` and `diff.ts` share duplicate verification
and file-reading logic. Extract it.

**Files:**
- Create: `src/tools/shared.ts`
- Modify: `src/tools/edit.ts`
- Modify: `src/tools/diff.ts`

**Step 1: Extract shared logic into src/tools/shared.ts**

Extract the common pattern of: resolve path → check deny → read file →
split lines → verify checksums → verify hashes → build ops.

**Step 2: Update edit.ts to use shared functions**

**Step 3: Update diff.ts to use shared functions**

**Step 4: Run all tests to verify nothing broke**

Run: `bun test`
Expected: all tests PASS

**Step 5: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: no errors

**Step 6: Commit**

```bash
git add src/tools/shared.ts src/tools/edit.ts src/tools/diff.ts
git commit -m "refactor: extract shared verification logic from edit and diff

Both tools share: path resolution, deny pattern check, file
reading, line splitting, checksum verification, hash verification,
and edit-op building. Extracted to src/tools/shared.ts to DRY."
```

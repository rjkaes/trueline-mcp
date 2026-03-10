# trueline Protocol Design

trueline is a file-editing protocol for AI agents. Every line the agent
reads carries a short content hash, and every edit must present those
hashes back — proving the agent is working against the file's actual
content rather than a stale or hallucinated version.

This document explains how the core tools — `trueline_read`,
`trueline_edit`, `trueline_diff`, `trueline_outline`, and
`trueline_search` — work together.

## The problem

When an AI agent edits a file by string matching (the default in most
tool-use setups), two things can go wrong silently:

1. **Stale context.** The file changed since the agent last read it —
   another tool, a build step, or the user modified it. The agent's edit
   lands on the wrong lines.

2. **Hallucinated anchors.** The agent mis-remembers or fabricates the
   text it's trying to match. The edit either fails to find a match or
   matches an unintended location.

trueline prevents both by requiring the agent to echo back per-line
hashes and a range checksum. If anything is wrong, the edit is rejected
before any bytes hit disk.

## Line format

`trueline_read` returns each line in this format:

```
{hash}.{lineNumber}	{content}
```

The separator between `{hash}.{lineNumber}` and `{content}` is a tab
character.

For example, reading a three-line file:

```
ab.1	#!/usr/bin/env node
mp.2	import { readFile } from "fs/promises";
qk.3	console.log("hello");

checksum: 1-3:f7e2a1b0
```

The **hash** is two characters from a 26-symbol alphabet (`a-z`) derived from the line's content via FNV-1a (a fast, non-cryptographic hash). Two characters give 676 possible values — enough to catch accidental mismatches, not enough to be a security mechanism.

The **checksum** covers the entire range of lines returned. Its format
is `startLine-endLine:8hex`, where the hex is an FNV-1a accumulator
over the full 32-bit hashes of each line in the range. This is
deliberately stronger than the 2-letter per-line hashes: the
accumulator feeds all four bytes of each line's hash into a second
FNV-1a pass, giving much better collision resistance over the whole
range.

## Reading: `trueline_read`

```
trueline_read({
  file_path: "src/main.ts",
  ranges: [{ start: 10, end: 25 }],  // optional, default: whole file
})
```

The tool streams the file line-by-line — it never loads the entire
file into memory. The pipeline:

1. Resolves the path (relative paths resolve against the project root).
2. Checks security deny patterns — files matching patterns like
   `Read(.env)` in the project's `.claude/settings.json` are blocked.
3. Opens a raw byte stream and scans for line endings (`\n`, `\r\n`,
   `\r`), yielding one decoded string per line. Lines before
   `start_line` are counted and skipped; lines after `end_line` stop
   the stream early.
4. Computes FNV-1a hashes and formats as truelines.
5. Computes and appends the range checksum.

### Partial reads

When `ranges` are specified, each range produces its own checksum
covering only those lines. This matters for `trueline_edit`: the
checksum you pass in each edit must cover at least the lines that edit
targets. Reading a few lines around your edit target is enough — you
don't need to re-read a 2000-line file to edit line 500.

Multiple disjoint ranges can be read in a single call, each producing
its own checksum. This is useful when editing lines in different parts
of a file — one read call provides all the checksums needed.

### Empty files

### Empty files

An empty file returns the sentinel checksum `0-0:00000000`. This
sentinel is accepted by `trueline_edit`, so you can insert content into
an empty file without special-casing.

## Editing: `trueline_edit`

```
trueline_edit({
  file_path: "src/main.ts",
  edits: [{
    checksum: "10-25:f7e2a1b0",
    range: "mp.12-qk.14",
    content: "  const x = 1;\n  const y = 2;",
  }]
})
```

Each edit specifies:

- **`range`** — which lines to replace, as `hash.startLine-hash.endLine`.
  A single-line shorthand `mp.12` is equivalent to `mp.12-mp.12`.
  Prefix `+` for insert-after: `+ab.5` inserts content after line 5.
  Use `+0` to prepend to the file.
- **`content`** — the replacement lines as a single newline-separated
  string. The resulting lines can be fewer or more than the range
  (shrinking or growing the file). An empty string deletes the range.

Each edit carries its own **`checksum`** — the range checksum from a
prior `trueline_read`. Must be the full string including the range
prefix (e.g. `"10-25:f7e2a1b0"`, not just `"f7e2a1b0"`). Edits
targeting different ranges can use different checksums from the same
or different `trueline_read` calls.

### Verification

The edit pipeline has two phases: structural validation (no file I/O)
and streaming application (single pass through the file). Structural
validation catches malformed inputs before the file is opened:

```
1. parseRange      — range string well-formed? + prefix valid?
2. line-0 check    — line 0 only allowed with + prefix?
3. coverage check  — checksum range covers the edit range?
4. overlap check   — no two edits target the same line?
```

If any step fails, the edit is rejected with an error message that
tells the agent what went wrong and how to recover (typically: re-read
the affected lines).

### Streaming application

Once structural validation passes, the engine streams the source file
byte-by-byte from disk to a temp file, applying edits inline. The
file is never loaded into memory as a whole.

```
1. Sort edits ascending by startLine.
2. Open a read stream on the source and a write stream to a temp file.
3. For each source line:
   a. Hash raw bytes (FNV-1a on the Buffer, no string decode).
   b. Verify boundary hashes at edit start/end lines.
   c. If the line falls in a replace range, buffer it for no-op
      detection but don't write it to the temp file.
   d. At the end of a replace range, write replacement content.
   e. After insert-after (+) anchors, write insert content.
   f. Unchanged lines are written as raw bytes — zero string
      allocation.
   g. Feed every output line's hash into an output checksum
      accumulator.
4. After the stream: verify range checksums, check for mtime changes.
5. If content changed: atomic rename of temp file over original.
6. If content unchanged (no-op): delete temp file, return existing
   checksum.
```

The ascending sort (opposite of the in-memory approach used by
the `dry_run` path) works because the streaming engine never needs
random access — it walks edits in lockstep with the line stream.

**Backpressure.** The write stream respects Node.js backpressure:
when `write()` returns `false`, the engine awaits the `drain` event
before continuing. This prevents the writable stream's internal
buffer from growing unbounded on large files.

**EOL handling.** The first line ending encountered becomes the EOL
for replacement content. Unchanged lines preserve their original raw
bytes exactly, so mixed-EOL files only normalize the lines that were
actually edited.

**Stale checksum recovery.** When the checksum fails but the
edit-target lines are still valid (meaning lines *outside* the edit
range changed), the error suggests a narrow re-read:

```
Checksum mismatch for lines 1-50: expected f7e2a1b0, got ab12cd34.
File changed since last read. Re-read with trueline_read.

However, lines 12-14 appear unchanged. Re-read with
trueline_read(ranges=[{start: 12, end: 14}]) to get a narrow checksum,
then retry the edit.
```

This avoids a full-file re-read in the common case where only distant
lines were modified externally.

**Concurrent modification.** The engine re-checks the file's mtime
before the atomic rename. If another process modified the file
between `validatePath` and the rename, the edit aborts. This narrows
the TOCTOU window but doesn't eliminate it.

### Multi-edit batches

A single `trueline_edit` call can carry multiple edits. Each edit
carries its own checksum, so edits can reference different read ranges.
All edits are verified together before any are applied. This is useful
for making several changes in one atomic operation. Edits must not
overlap — if two edits target the same line, the call is rejected.

### Return value

On success:

```
Edit applied successfully.

checksum: 1-50:newchecksum
```

The returned checksum covers the entire file after edits, so the agent
can use it for subsequent edits without re-reading.

### Dry-run preview

`trueline_edit` accepts an optional `dry_run: true` flag. When set, it
runs the full verification pipeline and applies edits in memory, but
writes nothing to disk. Instead, it returns a unified diff. Useful for
previewing changes before committing to them.

## Semantic diffing: `trueline_diff`

`trueline_diff` provides a semantic, AST-based summary of structural
changes in one or more files compared to a git ref (default: `HEAD`).
Instead of showing raw line-by-line diffs, it extracts symbols
(functions, classes, interfaces, etc.) from both the git version and
the working copy using tree-sitter, then compares them to detect:

- **Added** symbols (present on disk but not in the ref)
- **Removed** symbols (present in the ref but not on disk)
- **Renamed** symbols (different name but identical body hash)
- **Signature changes** (same name, same body, different declaration)
- **Logic modifications** (same name, different body hash)

### Body hashing

Each symbol's body is hashed using the same FNV-1a accumulator as
range checksums, but applied to the normalized body text. The
signature line (first line of the AST node) is excluded from the hash
so that renames don't change the body hash, enabling rename detection.

Whitespace normalization is language-aware: most languages use
"collapse" mode (trim + collapse runs to single space), while
indentation-significant languages like Python use "preserve-indent"
mode (keep leading whitespace, normalize trailing).

### Mini-diffs

For logic modifications with small changes (5 or fewer differing
lines), the output includes an inline mini-diff showing which lines
changed within the symbol body.

### Multi-file support

`trueline_diff` accepts an array of `file_paths`. Passing `["*"]`
expands to all unstaged changed files (tracked + untracked). Each
file produces its own section in the output. Unsupported file types
(those without a tree-sitter grammar) are reported as such.

## Outlining: `trueline_outline`

`trueline_outline` returns a compact structural outline of a source file —
functions, classes, interfaces, types, and other top-level declarations —
without reading the full content. It uses
[tree-sitter](https://tree-sitter.github.io/) via WebAssembly for
language-aware parsing.

### Why a separate tool?

An LLM agent navigating an unfamiliar codebase typically reads entire files
to understand their structure. For a 500-line file, that consumes ~500
lines of context just to learn "there are 4 functions and 2 classes."
`trueline_outline` returns the same structural information in 5-10 lines,
achieving ~95% token reduction.

The agent can then call `trueline_read` with specific line ranges to dive
into the functions it actually needs.

### Architecture

The outline system has three layers:

1. **Parser management** (`src/outline/parser.ts`) — lazily initializes
   the `web-tree-sitter` WASM runtime, resolves grammar `.wasm` files
   from the `tree-sitter-wasms` package via `require.resolve`, and caches
   loaded languages.

2. **Language configs** (`src/outline/languages.ts`) — per-language
   configuration mapping file extensions to tree-sitter grammars and
   defining which AST node types to extract. Each config specifies:
   - `outline`: node types to include (e.g. `function_declaration`,
     `class_declaration`)
   - `skip`: node types to exclude (e.g. `import_statement`)
   - `recurse`: container node types whose children should be inlined
     at depth+1 (e.g. `class_body` to show class members)
   - `topLevelOnly`: node types only included as direct children of the
     root (e.g. `expression_statement` to capture `server.registerTool()`
     calls but not nested `console.log()` inside try/catch)

3. **Extraction** (`src/outline/extract.ts`) — walks the AST, applies
   the language config, and produces `OutlineEntry` objects with line
   ranges, depth, and the first line of source for each node.

### Output format

Every entry uses a `start-end` line range format that maps directly to
`trueline_read` ranges. Skipped nodes (imports, etc.) are collapsed into
a summary showing their line range:

```
1-10: (10 imports)
12-12: const VERSION = pkg.version;
14-17: const server = new McpServer({
25-45: async function resolveAllowedDirs(): Promise<string[]> {
1-9: class Greeter {
  3-3: constructor(name: string) {
  6-8: greet(): string {

(8 symbols, 50 source lines)
```

Top-level declarations appear at depth 0; class/struct members appear
indented at depth 1. The agent can pass any line range directly to
`trueline_read(ranges: [{start: 25, end: 45}])` without transformation.

### Supported languages

20+ languages are supported via pre-built WASM grammars from the
`tree-sitter-wasms` package: TypeScript, JavaScript (+ JSX/TSX),
Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Kotlin, Swift, Scala,
Elixir, Lua, Dart, Zig, and Bash.

Adding a new language requires only a new entry in `languages.ts` — no
new dependencies.

## Searching: `trueline_search`

```
trueline_search({
  file_path: "src/server.ts",
  pattern: "validatePath",
  context_lines: 3,      // optional, default: 2
  max_matches: 10,       // optional, default: 10
})
```

`trueline_search` searches a file by regex and returns matching lines
with context, per-line hashes, and checksums — ready for immediate
editing. It replaces the outline → read → find workflow when the agent
knows what pattern to look for.

The pipeline:

1. Validates the file path through the same security boundary as other
   tools.
2. Validates the regex pattern (rejects invalid patterns with an error).
3. Streams the file in a single pass using a sliding window of
   `context_lines` capacity. Memory usage is O(context_lines) regardless
   of file size — unlike a naive approach that collects all lines first.
   Each line is decoded to a string exactly once.
4. When a match is found, the ring buffer of recent lines provides
   pre-context. The engine then switches to collecting post-context.
   Overlapping windows (matches within context distance of each other)
   are merged by extending the current window.
5. Early termination: once `max_matches` matches have been captured and
   their post-context is complete, the engine stops decoding lines
   (remaining lines are only scanned for the total match count).
6. Formats output with per-line hashes and a checksum per context
   window.

If `max_matches` is exceeded, the output includes a truncation notice
with the total match count.

The output is identical in format to `trueline_read` — same `hash.N\t`
prefix, same checksums — so the agent can pass results directly to
`trueline_edit` without a re-read step.

### When to use search vs outline+read

| Scenario | Recommended tool |
|----------|------------------|
| Understand file structure | `trueline_outline` |
| Read specific known lines | `trueline_read` |
| Find code by pattern, then edit | `trueline_search` |
| Explore unfamiliar code | `trueline_outline` → `trueline_read` |

## Security model

All five tools share a file-access layer that enforces deny patterns
from a three-tier settings hierarchy:

1. `.claude/settings.local.json` (project-local, gitignored)
2. `.claude/settings.json` (project-shared, committed)
3. `~/.claude/settings.json` (global)

Patterns look like `Read(.env)` or `Edit(**/*.key)` — a tool name
followed by a gitignore-style glob. Files matching any deny pattern are
blocked before content is read.

Additional protections:
- **Path containment:** files must resolve (after symlink resolution)
  to within one of the allowed base directories. The project directory
  (`CLAUDE_PROJECT_DIR` or cwd) is always allowed. When running under
  Claude Code, `~/.claude/` is also allowed (where it stores plans,
  memory, and settings). Additional directories can be added on any
  platform via the `TRUELINE_ALLOWED_DIRS` environment variable
  (colon-separated on macOS/Linux, semicolon-separated on Windows).
- **Binary files:** null bytes in content trigger rejection.
- **Size limit:** files over 10 MB are rejected.
- **Regular files only:** directories, devices, FIFOs, and sockets
  are rejected.

## Hash algorithm details

### FNV-1a 32-bit

All hashing uses FNV-1a 32-bit, a single-pass non-cryptographic hash
chosen by the vscode-hashline-edit-tool spec for its speed and
simplicity.

Constants:

- **Offset basis:** `0x811c9dc5` (2166136261)
- **Prime:** `0x01000193` (16777619)

For each byte `b` of input:

```
hash = (hash XOR b) * prime  (mod 2^32)
```

### Per-line hash: `fnv1aHash`

Input: the line's content as a string, with trailing `\n`, `\r\n`, or
`\r` stripped. The string is encoded as UTF-8 bytes inline (handling
surrogate pairs for codepoints above U+FFFF), and each byte is fed
into the FNV-1a accumulator.

The streaming edit engine has a byte-level equivalent,
`fnv1aHashBytes(buf, start, end)`, that hashes raw UTF-8 bytes from a
Buffer directly — identical output, no string decode/encode
round-trip.

### Two-character tag: `hashToLetters`

The 32-bit per-line hash is projected into two characters from a
32-symbol alphabet (`a-z` plus `2-7`, 1024 combinations) for the
`xy.N\tcontent` display format:

```
c1 = HASH_CHARS[hash & 0x1f]          // bits 0-4
c2 = HASH_CHARS[(hash >>> 8) & 0x1f]  // bits 8-12
```

The power-of-2 alphabet size allows bitwise AND (`& 0x1f`) instead of
integer division (`% 26`), which is measurably faster in the hot loop.

This is a lossy mapping to 1024 possible values — a typo detector, not
a security boundary.

### Range checksum: `foldHash`

The range checksum is an FNV-1a hash *of hashes*. Starting from the
offset basis, each line's full 32-bit hash is folded into the
accumulator byte-by-byte in little-endian order:

```
for each byte b in [hash & 0xff, (hash>>>8) & 0xff,
                    (hash>>>16) & 0xff, (hash>>>24) & 0xff]:
    accumulator = (accumulator XOR b) * prime  (mod 2^32)
```

Because FNV-1a is sequential, the order of lines matters — swapping
two lines produces a different checksum even if the set of line hashes
is the same.

The result is formatted as `startLine-endLine:8hex`
(e.g. `1-50:f7e2a1b0`). The 8 hex digits are the full 32-bit
accumulator, giving much stronger collision resistance than the
2-letter per-line tags.

### Three layers of edit protection

| Layer | What it checks | Granularity | Detects |
|-------|---------------|-------------|---------|
| Boundary hash | Two-letter tag at edit start/end lines | Single line | Change to the specific lines being replaced |
| Range checksum | FNV-1a accumulator over all lines in the read window | Entire read range | Change to *any* line in the window, even lines not being edited |
| mtime guard | File modification time before atomic rename | Whole file | Concurrent modification by another process between read and write |

The boundary hash is a fast-fail: the streaming engine checks it the
moment it reaches an edit's start or end line. The range checksum is
verified after the full stream completes — it catches changes to lines
the agent isn't editing but that were included in the `trueline_read`
window. The mtime guard narrows the TOCTOU window for external
writers.

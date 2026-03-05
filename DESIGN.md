# trueline Protocol Design

trueline is a file-editing protocol for AI agents. Every line the agent
reads carries a short content hash, and every edit must present those
hashes back — proving the agent is working against the file's actual
content rather than a stale or hallucinated version.

This document explains how the two core tools, `trueline_read` and
`trueline_edit`, work together.

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
{lineNumber}:{hash}|{content}
```

For example, reading a three-line file:

```
1:ab|#!/usr/bin/env node
2:mp|import { readFile } from "fs/promises";
3:qk|console.log("hello");

checksum: 1-3:f7e2a1b0
```

The **hash** is two lowercase letters derived from the line's content
via FNV-1a (a fast, non-cryptographic hash). Two letters give 676
possible values — enough to catch accidental mismatches, not enough to
be a security mechanism. The format matches the
[vscode-hashline-edit-tool](https://github.com/nicobailon/vscode-hashline-edit-tool)
spec for interoperability.

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

An empty file returns the sentinel checksum `0-0:00000000`. This
sentinel is accepted by `trueline_edit`, so you can insert content into
an empty file without special-casing.

## Editing: `trueline_edit`

```
trueline_edit({
  file_path: "src/main.ts",
  edits: [{
    checksum: "10-25:f7e2a1b0",
    range: "12:mp..14:qk",
    content: "  const x = 1;\n  const y = 2;",
  }]
})
```
```

Each edit specifies:

- **`range`** — which lines to replace, as `startLine:hash..endLine:hash`.
  A single-line shorthand `12:mp` is equivalent to `12:mp..12:mp`.
  Prefix `+` for insert-after: `+5:ab` inserts content after line 5.
  Use `+0:` to prepend to the file.
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
`trueline_diff`) works because the streaming engine never needs
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

## Diffing: `trueline_diff`

`trueline_diff` accepts the same parameters as `trueline_edit` but
writes nothing to disk. It runs the full verification pipeline, applies
the edits in memory, and returns a unified diff. Useful for previewing
changes before committing to them.

## Security model

All three tools share a file-access layer that enforces deny patterns
from a three-tier settings hierarchy:

1. `.claude/settings.local.json` (project-local, gitignored)
2. `.claude/settings.json` (project-shared, committed)
3. `~/.claude/settings.json` (global)

Patterns look like `Read(.env)` or `Edit(**/*.key)` — a tool name
followed by a gitignore-style glob. Files matching any deny pattern are
blocked before content is read.

Additional protections:
- **Path containment:** files must resolve (after symlink resolution)
  to within one of the allowed base directories. By default the
  allowed bases are the project directory (`CLAUDE_PROJECT_DIR` or
  cwd) and `~/.claude/` (where Claude Code stores plans, memory,
  and settings). Additional directories can be added via the
  `TRUELINE_ALLOWED_DIRS` environment variable (colon-separated
  paths).
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

### Two-letter tag: `hashToLetters`

The 32-bit per-line hash is projected into two lowercase letters for
the `N:xy|content` display format:

```
c1 = 'a' + (hash % 26)          // bits 0-4
c2 = 'a' + ((hash >>> 8) % 26)  // bits 8-12
```

This is a lossy mapping to 676 possible values — a typo detector, not
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

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
  start_line: 10,    // optional, default 1
  end_line: 25,      // optional, default EOF
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

When `start_line` / `end_line` are specified, the checksum covers only
that range. This matters for `trueline_edit`: the checksum you pass
must cover at least the lines you intend to edit. Reading 6 lines
around your edit target is enough — you don't need to re-read a
2000-line file to edit line 500.

### Empty files

An empty file returns the sentinel checksum `0-0:00000000`. This
sentinel is accepted by `trueline_edit`, so you can insert content into
an empty file without special-casing.

## Editing: `trueline_edit`

```
trueline_edit({
  file_path: "src/main.ts",
  edits: [{
    range: "12:mp..14:qk",
    content: ["  const x = 1;", "  const y = 2;"],
    checksum: "10-25:f7e2a1b0",
  }]
})
```

Each edit specifies:

- **`range`** — which lines to replace, as `startLine:hash..endLine:hash`.
  A single-line shorthand `12:mp` is equivalent to `12:mp..12:mp`.
- **`content`** — the replacement lines. One string per line, no
  newline characters. The array can be shorter or longer than the range
  (shrinking or growing the file).
- **`checksum`** — the range checksum from a prior `trueline_read`.
  Must be the full string including the range prefix
  (e.g. `"10-25:f7e2a1b0"`, not just `"f7e2a1b0"`).
- **`insert_after`** (optional) — when true, inserts `content` after
  the anchor line instead of replacing the range. Use `range: "0:"` with
  `insert_after: true` to prepend to the file.

### Verification

The edit pipeline has two phases: structural validation (no file I/O)
and streaming application (single pass through the file). Structural
validation catches malformed inputs before the file is opened:

```
1. parseRange      — range string is well-formed?
2. line-0 check    — line 0 only allowed with insert_after?
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
   e. After insert_after anchors, write insert content.
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
trueline_read(start_line=12, end_line=14) to get a narrow checksum,
then retry the edit.
```

This avoids a full-file re-read in the common case where only distant
lines were modified externally.

**Concurrent modification.** The engine re-checks the file's mtime
before the atomic rename. If another process modified the file
between `validatePath` and the rename, the edit aborts. This narrows
the TOCTOU window but doesn't eliminate it.

### Multi-edit batches

A single `trueline_edit` call can carry multiple edits. All edits share
the same file and are verified together before any are applied. This is
useful for making several changes in one atomic operation. Edits must
not overlap — if two edits target the same line, the call is rejected.

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
- **Path traversal:** files must resolve (after symlink resolution)
  to within the project directory.
- **Binary files:** null bytes in content trigger rejection.
- **Size limit:** files over 10 MB are rejected.
- **Regular files only:** directories, devices, FIFOs, and sockets
  are rejected.

## Why FNV-1a?

The vscode-hashline-edit-tool spec chose FNV-1a for its speed and
simplicity. It's a single-pass, non-cryptographic hash with good
distribution.

There are two implementations:

- **`fnv1aHash(str)`** — encodes UTF-8 inline from a JS string. Used
  by `trueline_read` (which decodes lines to strings for output
  formatting) and by `trueline_diff` (which works in-memory).
- **`fnv1aHashBytes(buf, start, end)`** — feeds raw UTF-8 bytes
  directly from a Buffer. Used by `trueline_edit`'s streaming engine
  to hash lines without ever decoding them to JS strings.

Both produce identical results for the same content. The Buffer
variant avoids the string decode/encode round-trip, which matters
for the streaming edit path where unchanged lines are never converted
to strings at all.

The 2-letter per-line hash (676 values) is intentionally coarse — it's
a typo detector, not a security boundary. The range checksum uses the
full 32-bit hash for each line, giving much stronger collision
resistance over the full range.

# Streaming Edit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `handleEdit`'s in-memory pipeline with a single-pass byte-level streaming engine that never loads the entire file into memory.

**Architecture:** New `src/streaming-edit.ts` module with `fnv1aHashBytes` (Buffer-native FNV-1a), `streamByteLines` (async generator yielding raw byte lines), and `streamingEdit` (the single-pass engine). `handleEdit` rewired to use the streaming pipeline. `handleDiff` untouched — it continues using `prepareFile` + `buildOps` + `applyEdits`.

**Tech Stack:** Node.js streams (`createReadStream`, `createWriteStream`), Bun test runner, existing FNV-1a constants from `trueline.ts`.

**Design doc:** `docs/plans/2026-03-04-streaming-edit-design.md`

---

## File Map

```
src/streaming-edit.ts        # NEW — fnv1aHashBytes, streamByteLines, streamingEdit
src/tools/shared.ts          # MODIFY — add validateEdits (extracted from buildOps)
src/tools/edit.ts            # MODIFY — rewire handleEdit to streaming pipeline
tests/streaming-edit.test.ts # NEW — tests for all new functions
```

Unchanged files (used by `handleDiff`):
- `src/trueline.ts` — `applyEdits`, `verifyChecksum`, `verifyHashes`, etc.
- `src/tools/shared.ts` — `prepareFile`, `buildOps` (keep both, diff still uses them)
- `tests/tools/edit.test.ts` — existing tests must pass unchanged

---

## Task 1: `fnv1aHashBytes`

**Files:**
- Create: `src/streaming-edit.ts`
- Create: `tests/streaming-edit.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/streaming-edit.test.ts
import { describe, expect, test } from "bun:test";
import { fnv1aHash, FNV_OFFSET_BASIS } from "../src/trueline.ts";
import { fnv1aHashBytes } from "../src/streaming-edit.ts";

describe("fnv1aHashBytes", () => {
  test("matches fnv1aHash for ASCII", () => {
    const str = "hello world";
    const buf = Buffer.from(str, "utf-8");
    expect(fnv1aHashBytes(buf, 0, buf.length)).toBe(fnv1aHash(str));
  });

  test("matches fnv1aHash for multi-byte UTF-8", () => {
    const str = "日本語";
    const buf = Buffer.from(str, "utf-8");
    expect(fnv1aHashBytes(buf, 0, buf.length)).toBe(fnv1aHash(str));
  });

  test("matches fnv1aHash for emoji (surrogate pairs)", () => {
    const str = "🎉🚀";
    const buf = Buffer.from(str, "utf-8");
    expect(fnv1aHashBytes(buf, 0, buf.length)).toBe(fnv1aHash(str));
  });

  test("works on buffer slice (start != 0)", () => {
    const buf = Buffer.from("hello world", "utf-8");
    expect(fnv1aHashBytes(buf, 0, 5)).toBe(fnv1aHash("hello"));
  });

  test("empty range produces FNV offset basis", () => {
    const buf = Buffer.from("hello", "utf-8");
    expect(fnv1aHashBytes(buf, 0, 0)).toBe(FNV_OFFSET_BASIS);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/streaming-edit.test.ts`
Expected: FAIL — `fnv1aHashBytes` not found / not a function

**Step 3: Write minimal implementation**

```typescript
// src/streaming-edit.ts
import { FNV_OFFSET_BASIS, FNV_PRIME } from "./trueline.ts";

/**
 * Compute FNV-1a 32-bit hash directly on raw UTF-8 bytes in a Buffer.
 *
 * Equivalent to `fnv1aHash(str)` when the buffer contains the UTF-8
 * encoding of `str`, but avoids the JS string → UTF-8 re-encoding that
 * `fnv1aHash` performs internally. This lets us hash file content
 * without ever decoding it to a JS string.
 */
export function fnv1aHashBytes(buf: Buffer, start: number, end: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    hash = Math.imul(hash ^ buf[i], FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/streaming-edit.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/streaming-edit.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): add fnv1aHashBytes for buffer-native hashing

Computes FNV-1a 32-bit hash directly on raw UTF-8 bytes in a Buffer
slice, matching fnv1aHash output without JS string decoding."
```

---

## Task 2: `streamByteLines`

Async generator that yields raw `Buffer` lines with their EOL bytes from
a file, without decoding to JS strings. Handles LF, CRLF, bare CR, and
`\r\n` split across chunk boundaries.

**Files:**
- Modify: `src/streaming-edit.ts`
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamByteLines, type ByteLine } from "../src/streaming-edit.ts";

// (Add to the same file, after the fnv1aHashBytes tests)

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-stream-test-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("streamByteLines", () => {
  async function collect(filePath: string): Promise<ByteLine[]> {
    const lines: ByteLine[] = [];
    for await (const line of streamByteLines(filePath)) {
      lines.push(line);
    }
    return lines;
  }

  test("yields lines from LF file with trailing newline", async () => {
    const f = join(testDir, "lf.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = await collect(f);
    expect(lines).toHaveLength(3);
    expect(lines[0].lineBytes.toString()).toBe("line 1");
    expect(lines[0].eolBytes.toString()).toBe("\n");
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[2].lineBytes.toString()).toBe("line 3");
    expect(lines[2].eolBytes.toString()).toBe("\n");
    expect(lines[2].lineNumber).toBe(3);
  });

  test("yields lines from CRLF file", async () => {
    const f = join(testDir, "crlf.txt");
    writeFileSync(f, "line 1\r\nline 2\r\n");
    const lines = await collect(f);
    expect(lines).toHaveLength(2);
    expect(lines[0].lineBytes.toString()).toBe("line 1");
    expect(lines[0].eolBytes.toString()).toBe("\r\n");
    expect(lines[1].lineBytes.toString()).toBe("line 2");
    expect(lines[1].eolBytes.toString()).toBe("\r\n");
  });

  test("handles file without trailing newline", async () => {
    const f = join(testDir, "no-trail.txt");
    writeFileSync(f, "line 1\nline 2");
    const lines = await collect(f);
    expect(lines).toHaveLength(2);
    expect(lines[0].eolBytes.toString()).toBe("\n");
    expect(lines[1].lineBytes.toString()).toBe("line 2");
    expect(lines[1].eolBytes.length).toBe(0);
  });

  test("handles bare CR as line ending", async () => {
    const f = join(testDir, "cr.txt");
    writeFileSync(f, "line 1\rline 2\r");
    const lines = await collect(f);
    expect(lines).toHaveLength(2);
    expect(lines[0].lineBytes.toString()).toBe("line 1");
    expect(lines[0].eolBytes.toString()).toBe("\r");
    expect(lines[1].lineBytes.toString()).toBe("line 2");
  });

  test("handles mixed EOL styles", async () => {
    const f = join(testDir, "mixed.txt");
    writeFileSync(f, "line 1\nline 2\r\nline 3\n");
    const lines = await collect(f);
    expect(lines).toHaveLength(3);
    expect(lines[0].eolBytes.toString()).toBe("\n");
    expect(lines[1].eolBytes.toString()).toBe("\r\n");
    expect(lines[2].eolBytes.toString()).toBe("\n");
  });

  test("yields nothing for empty file", async () => {
    const f = join(testDir, "empty.txt");
    writeFileSync(f, "");
    const lines = await collect(f);
    expect(lines).toHaveLength(0);
  });

  test("single line no newline", async () => {
    const f = join(testDir, "single.txt");
    writeFileSync(f, "only line");
    const lines = await collect(f);
    expect(lines).toHaveLength(1);
    expect(lines[0].lineBytes.toString()).toBe("only line");
    expect(lines[0].eolBytes.length).toBe(0);
    expect(lines[0].lineNumber).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/streaming-edit.test.ts`
Expected: FAIL — `streamByteLines` not found

**Step 3: Write minimal implementation**

```typescript
// Add to src/streaming-edit.ts
import { createReadStream } from "node:fs";

export interface ByteLine {
  lineBytes: Buffer;
  eolBytes: Buffer;
  lineNumber: number;
}

const LF_BUF = Buffer.from("\n");
const CRLF_BUF = Buffer.from("\r\n");
const CR_BUF = Buffer.from("\r");
const EMPTY_BUF = Buffer.alloc(0);

/**
 * Stream lines from a file as raw Buffers without decoding to JS strings.
 *
 * Yields one `ByteLine` per line: the raw line bytes (no EOL), the EOL
 * bytes (LF / CRLF / CR / empty for last line without trailing newline),
 * and the 1-based line number. Handles `\r\n` pairs split across chunk
 * boundaries the same way `streamLines` in `read.ts` does.
 */
export async function* streamByteLines(filePath: string): AsyncGenerator<ByteLine> {
  const stream = createReadStream(filePath);
  let partials: Buffer[] = [];
  let partialsLen = 0;
  let lineNumber = 0;
  let pendingCR = false;

  for await (const rawChunk of stream) {
    const buf: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let lineStart = 0;

    // Handle \r at end of previous chunk
    if (pendingCR) {
      pendingCR = false;
      if (buf.length > 0 && buf[0] === 0x0a) {
        // \r\n split across chunks
        lineNumber++;
        yield {
          lineBytes: flushPartials(partials, partialsLen),
          eolBytes: CRLF_BUF,
          lineNumber,
        };
        partials = [];
        partialsLen = 0;
        lineStart = 1;
      } else {
        // Bare \r
        lineNumber++;
        yield {
          lineBytes: flushPartials(partials, partialsLen),
          eolBytes: CR_BUF,
          lineNumber,
        };
        partials = [];
        partialsLen = 0;
      }
    }

    for (let i = lineStart; i < buf.length; i++) {
      if (buf[i] === 0x0d) {
        // Accumulate bytes before \r
        const slice = buf.subarray(lineStart, i);
        partials.push(slice);
        partialsLen += slice.length;

        if (i + 1 < buf.length) {
          lineNumber++;
          if (buf[i + 1] === 0x0a) {
            // \r\n within same chunk
            yield {
              lineBytes: flushPartials(partials, partialsLen),
              eolBytes: CRLF_BUF,
              lineNumber,
            };
            i++; // skip \n
          } else {
            // Bare \r
            yield {
              lineBytes: flushPartials(partials, partialsLen),
              eolBytes: CR_BUF,
              lineNumber,
            };
          }
          partials = [];
          partialsLen = 0;
        } else {
          // \r at end of chunk — defer until next chunk
          pendingCR = true;
        }
        lineStart = i + 1;
      } else if (buf[i] === 0x0a) {
        lineNumber++;
        const slice = buf.subarray(lineStart, i);
        if (partialsLen > 0) {
          partials.push(slice);
          yield {
            lineBytes: flushPartials(partials, partialsLen + slice.length),
            eolBytes: LF_BUF,
            lineNumber,
          };
          partials = [];
          partialsLen = 0;
        } else {
          yield { lineBytes: slice, eolBytes: LF_BUF, lineNumber };
        }
        lineStart = i + 1;
      }
    }

    // Remaining bytes from this chunk become partial
    if (lineStart < buf.length) {
      partials.push(buf.subarray(lineStart));
      partialsLen += buf.length - lineStart;
    }
  }

  // Handle pending \r at end of file
  if (pendingCR) {
    lineNumber++;
    yield {
      lineBytes: flushPartials(partials, partialsLen),
      eolBytes: CR_BUF,
      lineNumber,
    };
  } else if (partialsLen > 0) {
    // Content after last line ending (no trailing newline)
    lineNumber++;
    yield {
      lineBytes: flushPartials(partials, partialsLen),
      eolBytes: EMPTY_BUF,
      lineNumber,
    };
  }
}

function flushPartials(partials: Buffer[], totalLen: number): Buffer {
  if (partials.length === 0) return EMPTY_BUF;
  if (partials.length === 1) return partials[0];
  return Buffer.concat(partials, totalLen);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/streaming-edit.test.ts`
Expected: PASS (all tests including fnv1aHashBytes + streamByteLines)

**Step 5: Commit**

```bash
git add src/streaming-edit.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): add streamByteLines generator

Async generator that yields raw Buffer lines from a file without
decoding to JS strings. Handles LF, CRLF, bare CR, and \r\n split
across chunk boundaries."
```

---

## Task 3: `validateEdits`

Extract the non-file-content validation from `buildOps` into a new
`validateEdits` function. This validates edit inputs (range parsing,
line-0 constraints, checksum coverage, overlap detection) without needing
file content. File-content verification (checksum match, hash match) moves
into the streaming pass.

`buildOps` stays unchanged — `handleDiff` still uses it.

**Files:**
- Modify: `src/tools/shared.ts`
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
// Add to tests/streaming-edit.test.ts
import { validateEdits } from "../src/tools/shared.ts";

describe("validateEdits", () => {
  test("accepts valid single replace edit", () => {
    const result = validateEdits([
      { range: "2:ab..3:cd", content: ["x", "y"], checksum: "1-4:abcdef01" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].startLine).toBe(2);
      expect(result.ops[0].endLine).toBe(3);
      expect(result.checksumRefs).toHaveLength(1);
      expect(result.checksumRefs[0].startLine).toBe(1);
      expect(result.checksumRefs[0].endLine).toBe(4);
    }
  });

  test("accepts valid insert_after at line 0", () => {
    const result = validateEdits([
      { range: "0:", content: ["new"], checksum: "0-0:00000000", insert_after: true },
    ]);
    expect(result.ok).toBe(true);
  });

  test("rejects line 0 without insert_after", () => {
    const result = validateEdits([
      { range: "0:", content: ["x"], checksum: "0-0:00000000" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("insert_after");
    }
  });

  test("rejects checksum that does not cover edit range", () => {
    const result = validateEdits([
      { range: "4:ab..4:ab", content: ["x"], checksum: "1-2:abcdef01" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("does not cover");
    }
  });

  test("rejects overlapping replace ranges", () => {
    const result = validateEdits([
      { range: "1:aa..2:bb", content: ["A"], checksum: "1-4:abcdef01" },
      { range: "2:bb..2:bb", content: ["B"], checksum: "1-4:abcdef01" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Overlapping");
    }
  });

  test("allows insert_after ops at same anchor (no overlap)", () => {
    const result = validateEdits([
      { range: "1:aa", content: ["A"], checksum: "1-4:abcdef01", insert_after: true },
      { range: "1:aa", content: ["B"], checksum: "1-4:abcdef01", insert_after: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/streaming-edit.test.ts`
Expected: FAIL — `validateEdits` not found

**Step 3: Write minimal implementation**

```typescript
// Add to src/tools/shared.ts

import {
  parseRange,
  parseChecksum,
  type EditOp,
  type ChecksumRef,
} from "../trueline.ts";

// (parseRange, parseChecksum, EditOp already imported — add ChecksumRef)

type ValidateEditsOk = {
  ok: true;
  ops: EditOp[];
  checksumRefs: ChecksumRef[];
};
type ValidateEditsErr = { ok: false; error: ToolResult };
type ValidateEditsResult = ValidateEditsOk | ValidateEditsErr;

/**
 * Validate edit inputs without reading file content.
 *
 * Performs range parsing, line-0 constraints, checksum-range coverage,
 * and overlap detection. File-content verification (checksum match,
 * boundary hash match) is deferred to the streaming pass.
 *
 * Returns parsed ops sorted ascending by startLine (ready for forward
 * streaming), plus the unique checksum refs for verification.
 */
export function validateEdits(edits: EditInput[]): ValidateEditsResult {
  const ops: EditOp[] = [];
  const checksumRefs: ChecksumRef[] = [];
  const seenChecksums = new Set<string>();

  for (const edit of edits) {
    const rangeRef = parseRange(edit.range);

    // line 0 only valid for insert_after
    if (rangeRef.start.line === 0 && !edit.insert_after) {
      return {
        ok: false,
        error: {
          content: [{ type: "text", text: "range starting at line 0 requires insert_after: true" }],
          isError: true,
        },
      };
    }

    // Parse checksum (validates format)
    const csRef = parseChecksum(edit.checksum);

    // Verify checksum range covers edit target
    if (rangeRef.start.line > 0) {
      if (csRef.startLine > rangeRef.start.line || csRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: {
            content: [{
              type: "text",
              text: `Checksum range ${csRef.startLine}-${csRef.endLine} does not cover ` +
                `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
                `Re-read with trueline_read to get a checksum covering the target lines.`,
            }],
            isError: true,
          },
        };
      }
    }

    // Collect unique checksum refs for streaming verification
    if (!seenChecksums.has(edit.checksum)) {
      seenChecksums.add(edit.checksum);
      checksumRefs.push(csRef);
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
    });
  }

  // Overlap detection (same logic as buildOps)
  const touchedLines = new Set<number>();
  for (const op of ops) {
    if (op.insertAfter) continue;
    for (let l = op.startLine; l <= op.endLine; l++) {
      if (touchedLines.has(l)) {
        return {
          ok: false,
          error: {
            content: [{ type: "text", text: `Overlapping ranges: line ${l} targeted by multiple edits` }],
            isError: true,
          },
        };
      }
      touchedLines.add(l);
    }
  }

  return { ok: true, ops, checksumRefs };
}
```

Note: `validateEdits` also needs to return the parsed `RangeRef` data
(start/end line:hash pairs) so the streaming pass can verify boundary
hashes. Extend the `EditOp` type or return the range refs alongside ops.
The simplest approach is to add `startHash` and `endHash` fields to the
returned ops:

```typescript
// Extended op info for streaming verification
interface StreamEditOp extends EditOp {
  startHash: string;
  endHash: string;
  checksum: string;
}
```

Adjust the function to return `StreamEditOp[]` and store the hashes
from `rangeRef.start.hash` and `rangeRef.end.hash`.

**Step 4: Run test to verify it passes**

Run: `bun test tests/streaming-edit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/shared.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): add validateEdits for content-free validation

Extracts range parsing, line-0 constraints, checksum coverage, and
overlap detection from buildOps into a standalone function. Does not
need file content — file verification deferred to streaming pass.

buildOps stays unchanged for handleDiff."
```

---

## Task 4: `streamingEdit` — basic single replace

The core streaming engine. First iteration handles only single-line and
multi-line replace operations on LF files.

**Files:**
- Modify: `src/streaming-edit.ts`
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
import { streamingEdit, type StreamingEditResult } from "../src/streaming-edit.ts";
import { lineHash, rangeChecksum } from "../src/trueline.ts";
import { validateEdits } from "../src/tools/shared.ts";

describe("streamingEdit", () => {
  test("replaces a single line", async () => {
    const f = join(testDir, "replace.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const { mtimeMs } = statSync(f);

    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const validated = validateEdits([
      { range: `2:${h2}`, content: ["replaced"], checksum: cs },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.changed).toBe(true);
    const written = readFileSync(f, "utf-8");
    expect(written).toBe("line 1\nreplaced\nline 3\n");
  });

  test("replaces a range of lines", async () => {
    const f = join(testDir, "range.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\nline 4\n");
    const { mtimeMs } = statSync(f);

    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const validated = validateEdits([
      { range: `2:${h2}..3:${h3}`, content: ["replaced 2", "replaced 3"], checksum: cs },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = readFileSync(f, "utf-8");
    expect(written).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("deletes lines (empty replacement)", async () => {
    const f = join(testDir, "delete.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const { mtimeMs } = statSync(f);

    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const validated = validateEdits([
      { range: `2:${h2}`, content: [], checksum: cs },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(true);

    const written = readFileSync(f, "utf-8");
    expect(written).toBe("line 1\nline 3\n");
  });

  test("returns correct full-file checksum after edit", async () => {
    const f = join(testDir, "checksum.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const { mtimeMs } = statSync(f);

    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const validated = validateEdits([
      { range: `2:${h2}`, content: ["replaced"], checksum: cs },
    ]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    if (!result.ok) return;

    // Verify checksum matches what rangeChecksum would produce
    const newLines = ["line 1", "replaced", "line 3"];
    const expectedCs = rangeChecksum(newLines, 1, 3);
    expect(result.newChecksum).toBe(expectedCs);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/streaming-edit.test.ts`
Expected: FAIL — `streamingEdit` not found

**Step 3: Write minimal implementation**

The core of `streamingEdit`. This is the largest implementation step.
Key design points:

- Uses `streamByteLines` to iterate the source file
- Opens a write stream to a temp file
- Uses a "pending write" pattern for trailing newline handling:
  each line is buffered; when the next line arrives, the buffered line
  is flushed with EOL; the final buffered line is flushed with or
  without EOL based on the original file's trailing newline state
- Detects EOL style from the first line ending encountered
- Computes checksum accumulators for each unique checksum ref
- Computes output checksum accumulator for the response
- Verifies checksums after the stream completes
- Verifies boundary hashes inline during the stream
- Performs atomic rename with mtime check

```typescript
// Add to src/streaming-edit.ts
import { createWriteStream } from "node:fs";
import { rename, stat, chmod, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  EMPTY_FILE_CHECKSUM,
  type EditOp,
  type ChecksumRef,
} from "./trueline.ts";

export type StreamingEditResult =
  | { ok: true; newChecksum: string; changed: boolean }
  | { ok: false; error: string };

// Extend EditOp with boundary hashes for streaming verification
export interface StreamEditOp extends EditOp {
  startHash: string;
  endHash: string;
  checksum: string;
}

export async function streamingEdit(
  resolvedPath: string,
  ops: StreamEditOp[],
  checksumRefs: ChecksumRef[],
  mtimeMs: number,
): Promise<StreamingEditResult> {
  // Sort ops ascending by startLine for forward streaming.
  // For insert_after ops at the same anchor, preserve input order.
  const sorted = ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => {
      if (a.op.startLine !== b.op.startLine) return a.op.startLine - b.op.startLine;
      // insert_after before replace at same anchor
      if (a.op.insertAfter !== b.op.insertAfter) return a.op.insertAfter ? -1 : 1;
      // Preserve input order for insert_after at same anchor
      return a.i - b.i;
    })
    .map(x => x.op);

  // Set up temp file for atomic write
  const dir = dirname(resolvedPath);
  const tmpName = `.trueline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  let originalMode: number | undefined;
  try {
    originalMode = (await stat(resolvedPath)).mode;
  } catch { /* new file */ }

  const ws = createWriteStream(tmpPath);

  // Checksum accumulators (one per unique checksum ref)
  const csAccum = checksumRefs.map(ref => ({
    ref,
    hash: FNV_OFFSET_BASIS,
  }));

  // Output checksum accumulator
  let outputHash = FNV_OFFSET_BASIS;
  let outputLineCount = 0;

  let detectedEol: Buffer = LF_BUF; // default if file has no line endings
  let eolDetected = false;
  let contentChanged = false;
  let totalLines = 0;

  // Pending write for trailing newline handling
  let pendingWrite: Buffer | null = null;

  function flushPending(eol: Buffer): void {
    if (pendingWrite !== null) {
      ws.write(pendingWrite);
      ws.write(eol);
      pendingWrite = null;
    }
  }

  function enqueueLine(bytes: Buffer): void {
    flushPending(detectedEol);
    pendingWrite = bytes;
  }

  function feedOutputChecksum(lineH: number): void {
    outputHash = Math.imul(outputHash ^ (lineH & 0xff), FNV_PRIME) >>> 0;
    outputHash = Math.imul(outputHash ^ ((lineH >>> 8) & 0xff), FNV_PRIME) >>> 0;
    outputHash = Math.imul(outputHash ^ ((lineH >>> 16) & 0xff), FNV_PRIME) >>> 0;
    outputHash = Math.imul(outputHash ^ ((lineH >>> 24) & 0xff), FNV_PRIME) >>> 0;
    outputLineCount++;
  }

  // Compute 2-letter hash from FNV-1a value
  function twoLetterHash(h: number): string {
    return String.fromCharCode(97 + (h % 26)) +
           String.fromCharCode(97 + ((h >>> 8) % 26));
  }

  // Build a map: lineNumber → list of ops starting at that line
  const opsAtLine = new Map<number, StreamEditOp[]>();
  for (const op of sorted) {
    const key = op.insertAfter ? op.startLine : op.startLine;
    if (!opsAtLine.has(key)) opsAtLine.set(key, []);
    opsAtLine.get(key)!.push(op);
  }

  // Track which lines are inside a replace range
  let skipUntil = 0; // if > 0, skip lines up to and including this line number
  let pendingReplace: StreamEditOp | null = null;

  // Track replaced original lines for no-op comparison
  let replacedOriginalLines: Buffer[] = [];
  let replaceContentIndex = 0;

  try {
    for await (const { lineBytes, eolBytes, lineNumber } of streamByteLines(resolvedPath)) {
      totalLines = lineNumber;

      // Binary detection
      if (lineBytes.includes(0x00)) {
        ws.destroy();
        await unlink(tmpPath).catch(() => {});
        return { ok: false, error: `"${resolvedPath}" appears to be a binary file` };
      }

      // EOL detection from first line ending
      if (!eolDetected && eolBytes.length > 0) {
        detectedEol = eolBytes;
        eolDetected = true;
      }

      // Compute FNV-1a hash on raw bytes (for checksum verification + output checksum)
      const lineH = fnv1aHashBytes(lineBytes, 0, lineBytes.length);

      // Feed into checksum accumulators for lines in range
      for (const acc of csAccum) {
        if (lineNumber >= acc.ref.startLine && lineNumber <= acc.ref.endLine) {
          acc.hash = Math.imul(acc.hash ^ (lineH & 0xff), FNV_PRIME) >>> 0;
          acc.hash = Math.imul(acc.hash ^ ((lineH >>> 8) & 0xff), FNV_PRIME) >>> 0;
          acc.hash = Math.imul(acc.hash ^ ((lineH >>> 16) & 0xff), FNV_PRIME) >>> 0;
          acc.hash = Math.imul(acc.hash ^ ((lineH >>> 24) & 0xff), FNV_PRIME) >>> 0;
        }
      }

      // Verify boundary hashes inline
      for (const op of ops) {
        if (op.startLine === lineNumber && op.startHash !== "") {
          const actual = twoLetterHash(lineH);
          if (actual !== op.startHash) {
            ws.destroy();
            await unlink(tmpPath).catch(() => {});
            return {
              ok: false,
              error: `Hash mismatch at line ${lineNumber}: expected ${op.startHash}, got ${actual}. ` +
                `File may have changed since last read. Re-read with trueline_read.`,
            };
          }
        }
        if (op.endLine === lineNumber && op.endHash !== "" && op.endLine !== op.startLine) {
          const actual = twoLetterHash(lineH);
          if (actual !== op.endHash) {
            ws.destroy();
            await unlink(tmpPath).catch(() => {});
            return {
              ok: false,
              error: `Hash mismatch at line ${lineNumber}: expected ${op.endHash}, got ${actual}. ` +
                `File may have changed since last read. Re-read with trueline_read.`,
            };
          }
        }
      }

      // Check if we're in a skip range (being replaced)
      if (lineNumber <= skipUntil) {
        // Track original lines for no-op comparison
        replacedOriginalLines.push(lineBytes);

        // At end of replace range: emit replacement content
        if (lineNumber === skipUntil) {
          const op = pendingReplace!;

          // No-op comparison: check if replacement content matches original
          if (
            op.content.length === replacedOriginalLines.length &&
            op.content.every((line, idx) =>
              Buffer.from(line, "utf-8").equals(replacedOriginalLines[idx])
            )
          ) {
            // Content unchanged — write original bytes to preserve exact bytes
            for (const origLine of replacedOriginalLines) {
              enqueueLine(origLine);
              feedOutputChecksum(fnv1aHashBytes(origLine, 0, origLine.length));
            }
          } else {
            contentChanged = true;
            for (const line of op.content) {
              const buf = Buffer.from(line, "utf-8");
              enqueueLine(buf);
              feedOutputChecksum(fnv1aHashBytes(buf, 0, buf.length));
            }
          }

          skipUntil = 0;
          pendingReplace = null;
          replacedOriginalLines = [];
        }

        // Process insert_after ops at this line even if we're skipping
        // (an insert_after at the end of a replace range)
        // Actually, buildOps rejects overlapping ranges, so this shouldn't happen.
        continue;
      }

      // Check for ops starting at this line
      const lineOps = opsAtLine.get(lineNumber);
      if (lineOps) {
        for (const op of lineOps) {
          if (op.insertAfter) {
            // Write the anchor line first
            enqueueLine(lineBytes);
            feedOutputChecksum(lineH);

            // Write insert content
            contentChanged = true;
            for (const line of op.content) {
              const buf = Buffer.from(line, "utf-8");
              enqueueLine(buf);
              feedOutputChecksum(fnv1aHashBytes(buf, 0, buf.length));
            }
            // Mark that we already wrote the anchor line
            // (skip the default unchanged-line write below)
            goto_next_line = true;
          } else {
            // Start of a replace range
            if (op.startLine === op.endLine) {
              // Single-line replace: emit replacement now
              replacedOriginalLines = [lineBytes];

              if (
                op.content.length === 1 &&
                Buffer.from(op.content[0], "utf-8").equals(lineBytes)
              ) {
                // No-op: write original bytes
                enqueueLine(lineBytes);
                feedOutputChecksum(lineH);
              } else {
                contentChanged = true;
                for (const line of op.content) {
                  const buf = Buffer.from(line, "utf-8");
                  enqueueLine(buf);
                  feedOutputChecksum(fnv1aHashBytes(buf, 0, buf.length));
                }
              }
              replacedOriginalLines = [];
              goto_next_line = true;
            } else {
              // Multi-line replace: skip lines until endLine
              skipUntil = op.endLine;
              pendingReplace = op;
              replacedOriginalLines = [lineBytes];
              goto_next_line = true;
            }
          }
        }
        // If any op consumed this line, skip the default write
        if (goto_next_line) {
          goto_next_line = false;
          continue;
        }
      }

      // Unchanged line — raw byte copy
      enqueueLine(lineBytes);
      feedOutputChecksum(lineH);
    }

    // Flush the last pending line with or without trailing EOL
    const hasTrailingNewline = totalLines > 0; // refined below
    // Actually, determine from last line's eolBytes — but we don't have
    // it here because we're outside the loop. We need to track it.
    // (see implementation note below)

    // ... trailing newline handling ...

    // Verify checksums
    for (const acc of csAccum) {
      if (acc.ref.startLine === 0 && acc.ref.endLine === 0) {
        // Empty file sentinel
        if (totalLines !== 0) {
          ws.destroy();
          await unlink(tmpPath).catch(() => {});
          return {
            ok: false,
            error: `Checksum mismatch: expected empty file but file has ${totalLines} lines. Re-read with trueline_read.`,
          };
        }
        continue;
      }

      if (acc.ref.endLine > totalLines) {
        ws.destroy();
        await unlink(tmpPath).catch(() => {});
        return {
          ok: false,
          error: `Checksum range ${acc.ref.startLine}-${acc.ref.endLine} exceeds ` +
            `file length (${totalLines} lines). File may have been truncated.`,
        };
      }

      const expected = acc.ref.hash;
      const actual = acc.hash.toString(16).padStart(8, "0");
      if (actual !== expected) {
        ws.destroy();
        await unlink(tmpPath).catch(() => {});
        return {
          ok: false,
          error: `Checksum mismatch for lines ${acc.ref.startLine}-${acc.ref.endLine}: ` +
            `expected ${expected}, got ${actual}. ` +
            `File changed since last read. Re-read with trueline_read.`,
        };
      }
    }

    // Close write stream
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on("error", reject);
    });

    // If nothing changed, clean up and return
    if (!contentChanged) {
      await unlink(tmpPath).catch(() => {});
      const cs = outputLineCount === 0
        ? EMPTY_FILE_CHECKSUM
        : `1-${outputLineCount}:${outputHash.toString(16).padStart(8, "0")}`;
      return { ok: true, newChecksum: cs, changed: false };
    }

    // Preserve permissions + mtime check + atomic rename
    if (originalMode !== undefined) {
      await chmod(tmpPath, originalMode);
    }
    try {
      const currentMtime = (await stat(resolvedPath)).mtimeMs;
      if (currentMtime !== mtimeMs) {
        await unlink(tmpPath).catch(() => {});
        return {
          ok: false,
          error: `File was modified by another process (expected mtime ${mtimeMs}, ` +
            `got ${currentMtime}). Re-read with trueline_read.`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("File was modified")) throw err;
    }
    await rename(tmpPath, resolvedPath);

    const cs = outputLineCount === 0
      ? EMPTY_FILE_CHECKSUM
      : `1-${outputLineCount}:${outputHash.toString(16).padStart(8, "0")}`;
    return { ok: true, newChecksum: cs, changed: true };

  } catch (err) {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}
```

**Implementation notes:**

The above is a sketch — the actual implementation will be refined by the
TDD cycle. Key things the implementer must handle:

1. **`goto_next_line` pattern**: Use a boolean flag or restructure the
   loop to avoid processing a line as "unchanged" when an op already
   handled it. A cleaner approach is to use `continue` after processing
   each op.

2. **Trailing newline tracking**: Track `lastEolBytes` across the loop.
   After the loop, flush `pendingWrite` with:
   - EOL if `lastEolBytes.length > 0` (file had trailing newline)
   - No EOL if `lastEolBytes.length === 0`

3. **Insert_after at same anchor with multiple ops**: Multiple
   insert_after ops at the same line should all fire — write anchor
   once, then all inserts in order. Handle this by processing all ops
   for a line in a single iteration.

4. **Empty file handling**: If the file is empty (stream yields nothing),
   handle the `0-0:00000000` sentinel and write insert_after content
   if any ops target line 0.

**Step 4: Run test to verify it passes**

Run: `bun test tests/streaming-edit.test.ts`
Expected: PASS (basic replace tests)

**Step 5: Commit**

```bash
git add src/streaming-edit.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): add streamingEdit core engine

Single-pass byte-level streaming edit that reads raw Buffer chunks,
computes checksums on raw UTF-8 bytes, and writes unchanged regions
without string decode/encode."
```

---

## Task 5: `streamingEdit` — insert_after

**Files:**
- Modify: `src/streaming-edit.ts` (if not already complete from task 4)
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
// Add to streamingEdit describe block
test("inserts after a line", async () => {
  const f = join(testDir, "insert.txt");
  writeFileSync(f, "line 1\nline 2\nline 3\n");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2", "line 3"];
  const cs = rangeChecksum(lines, 1, 3);
  const h1 = lineHash("line 1");

  const validated = validateEdits([
    { range: `1:${h1}`, content: ["inserted"], checksum: cs, insert_after: true },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("line 1\ninserted\nline 2\nline 3\n");
});

test("multiple insert_after at same anchor preserves input order", async () => {
  const f = join(testDir, "multi-insert.txt");
  writeFileSync(f, "anchor\nnext\n");
  const { mtimeMs } = statSync(f);

  const lines = ["anchor", "next"];
  const cs = rangeChecksum(lines, 1, 2);
  const h = lineHash("anchor");

  const validated = validateEdits([
    { range: `1:${h}`, content: ["first"], checksum: cs, insert_after: true },
    { range: `1:${h}`, content: ["second"], checksum: cs, insert_after: true },
    { range: `1:${h}`, content: ["third"], checksum: cs, insert_after: true },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("anchor\nfirst\nsecond\nthird\nnext\n");
});

test("insert_after at line 0 (prepend to file)", async () => {
  const f = join(testDir, "prepend.txt");
  writeFileSync(f, "existing\n");
  const { mtimeMs } = statSync(f);

  const lines = ["existing"];
  const cs = rangeChecksum(lines, 1, 1);

  const validated = validateEdits([
    { range: "0:", content: ["prepended"], checksum: cs, insert_after: true },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("prepended\nexisting\n");
});
```

**Step 2–4: Standard TDD cycle**

Run: `bun test tests/streaming-edit.test.ts`

Add insert_after handling to `streamingEdit` if not already complete.
Key: line-0 insert_after must write content before the first source line.
Handle by checking for line-0 ops before the stream loop begins.

**Step 5: Commit**

```bash
git add src/streaming-edit.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): add insert_after support

Handles insert_after ops including multiple inserts at the same anchor
(preserving input order) and line-0 prepend."
```

---

## Task 6: `streamingEdit` — multiple edits

**Files:**
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
test("handles multiple replace edits", async () => {
  const f = join(testDir, "multi-replace.txt");
  writeFileSync(f, "line 1\nline 2\nline 3\nline 4\n");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2", "line 3", "line 4"];
  const cs = rangeChecksum(lines, 1, 4);
  const h1 = lineHash("line 1");
  const h4 = lineHash("line 4");

  const validated = validateEdits([
    { range: `1:${h1}`, content: ["A"], checksum: cs },
    { range: `4:${h4}`, content: ["D"], checksum: cs },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("A\nline 2\nline 3\nD\n");
});

test("handles replace + insert_after in same batch", async () => {
  const f = join(testDir, "mixed-ops.txt");
  writeFileSync(f, "line 1\nline 2\nline 3\n");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2", "line 3"];
  const cs = rangeChecksum(lines, 1, 3);
  const h1 = lineHash("line 1");
  const h3 = lineHash("line 3");

  const validated = validateEdits([
    { range: `1:${h1}`, content: ["A"], checksum: cs },
    { range: `3:${h3}`, content: ["inserted"], checksum: cs, insert_after: true },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("A\nline 2\nline 3\ninserted\n");
});
```

**Step 2–4: Standard TDD cycle**

These should pass if tasks 4 and 5 were implemented correctly. If not,
fix the implementation.

**Step 5: Commit**

```bash
git add tests/streaming-edit.test.ts
git commit -m "test(streaming-edit): add multi-edit and mixed-op tests"
```

---

## Task 7: `streamingEdit` — checksum and hash verification

**Files:**
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
test("rejects stale checksum", async () => {
  const f = join(testDir, "stale.txt");
  writeFileSync(f, "line 1\nline 2\nline 3\n");
  const { mtimeMs } = statSync(f);

  const validated = validateEdits([
    { range: "1:aa..1:aa", content: ["nope"], checksum: "1-3:00000000" },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("mismatch");
  }
});

test("rejects wrong line hash at boundary", async () => {
  const f = join(testDir, "bad-hash.txt");
  writeFileSync(f, "line 1\nline 2\nline 3\n");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2", "line 3"];
  const cs = rangeChecksum(lines, 1, 3);

  const validated = validateEdits([
    { range: "1:zz..1:zz", content: ["nope"], checksum: cs },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("mismatch");
  }
});

test("rejects checksum range exceeding file length", async () => {
  const f = join(testDir, "short.txt");
  writeFileSync(f, "only\n");
  const { mtimeMs } = statSync(f);

  const validated = validateEdits([
    { range: "1:aa..1:aa", content: ["x"], checksum: "1-5:abcdef01" },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("exceeds");
  }
});
```

**Step 2–4: Standard TDD cycle**

Verification logic should already be in `streamingEdit` from task 4.
These tests confirm it works. Fix if needed.

**Step 5: Commit**

```bash
git add tests/streaming-edit.test.ts
git commit -m "test(streaming-edit): add checksum and hash verification tests"
```

---

## Task 8: `streamingEdit` — edge cases

CRLF preservation, trailing newline, binary detection, empty file,
no-op detection.

**Files:**
- Modify: `tests/streaming-edit.test.ts`

**Step 1: Write the failing tests**

```typescript
test("preserves CRLF line endings in replacements", async () => {
  const f = join(testDir, "crlf.txt");
  writeFileSync(f, "line 1\r\nline 2\r\nline 3\r\n");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2", "line 3"];
  const cs = rangeChecksum(lines, 1, 3);
  const h2 = lineHash("line 2");

  const validated = validateEdits([
    { range: `2:${h2}`, content: ["replaced"], checksum: cs },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("line 1\r\nreplaced\r\nline 3\r\n");
  expect(written).not.toMatch(/(?<!\r)\n/); // no bare \n
});

test("preserves absence of trailing newline", async () => {
  const f = join(testDir, "no-trail.txt");
  writeFileSync(f, "line 1\nline 2");
  const { mtimeMs } = statSync(f);

  const lines = ["line 1", "line 2"];
  const cs = rangeChecksum(lines, 1, 2);
  const h1 = lineHash("line 1");

  const validated = validateEdits([
    { range: `1:${h1}`, content: ["replaced"], checksum: cs },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toBe("replaced\nline 2");
});

test("rejects binary file", async () => {
  const f = join(testDir, "binary.bin");
  writeFileSync(f, Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
  const { mtimeMs } = statSync(f);

  const validated = validateEdits([
    { range: "1:aa", content: ["x"], checksum: "1-1:abcdef01" },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("binary");
  }
});

test("handles empty file with insert_after", async () => {
  const f = join(testDir, "empty.txt");
  writeFileSync(f, "");
  const { mtimeMs } = statSync(f);

  const validated = validateEdits([
    { range: "0:", content: ["new content"], checksum: "0-0:00000000", insert_after: true },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
  expect(result.ok).toBe(true);

  const written = readFileSync(f, "utf-8");
  expect(written).toContain("new content");
});

test("detects no-op and skips write", async () => {
  const f = join(testDir, "noop.txt");
  writeFileSync(f, "aaa\nbbb\nccc\n");
  const { mtimeMs: before } = statSync(f);

  const lines = ["aaa", "bbb", "ccc"];
  const cs = rangeChecksum(lines, 1, 3);

  const validated = validateEdits([
    { range: `2:${lineHash("bbb")}`, content: ["bbb"], checksum: cs },
  ]);
  if (!validated.ok) return;

  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, before);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.changed).toBe(false);
  }

  const { mtimeMs: after } = statSync(f);
  expect(after).toBe(before);
});

test("detects concurrent modification via mtime", async () => {
  const f = join(testDir, "mtime.txt");
  writeFileSync(f, "line 1\nline 2\n");

  // Get mtime, then modify the file to change mtime
  const { mtimeMs: oldMtime } = statSync(f);

  // Wait a tick and rewrite to change mtime
  await new Promise(r => setTimeout(r, 50));
  writeFileSync(f, "line 1\nline 2\n"); // same content, new mtime
  const { mtimeMs: newMtime } = statSync(f);
  expect(newMtime).not.toBe(oldMtime);

  const lines = ["line 1", "line 2"];
  const cs = rangeChecksum(lines, 1, 2);
  const h1 = lineHash("line 1");

  const validated = validateEdits([
    { range: `1:${h1}`, content: ["changed"], checksum: cs },
  ]);
  if (!validated.ok) return;

  // Pass old mtime — should detect the modification
  const result = await streamingEdit(f, validated.ops, validated.checksumRefs, oldMtime);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("modified by another process");
  }
});
```

**Step 2–4: Standard TDD cycle**

Implement or fix each edge case as tests are added. CRLF handling comes
from the EOL detection + using detected EOL for replacement content.
Trailing newline comes from the pending-write pattern. Binary from the
null-byte check. Empty file from special-casing no lines.

**Step 5: Commit**

```bash
git add src/streaming-edit.ts tests/streaming-edit.test.ts
git commit -m "feat(streaming-edit): handle CRLF, trailing newline, binary, empty file, no-op

Streaming edit now correctly:
- Detects EOL from first line ending, uses it for replacement content
- Preserves trailing newline state via pending-write pattern
- Rejects binary files (null byte detection)
- Handles empty file with insert_after at line 0
- Detects no-op edits and skips write (preserves mtime)"
```

---

## Task 9: Wire `handleEdit` to streaming pipeline

Replace the in-memory pipeline in `handleEdit` with the new streaming
path. All existing `tests/tools/edit.test.ts` tests must pass unchanged.

**Files:**
- Modify: `src/tools/edit.ts`
- Test: `tests/tools/edit.test.ts` (run existing tests, no changes)
- Test: `tests/integration.test.ts` (run existing tests, no changes)

**Step 1: Run existing tests to confirm they pass (baseline)**

Run: `bun test tests/tools/edit.test.ts tests/integration.test.ts`
Expected: PASS (all existing tests)

**Step 2: Rewire `handleEdit`**

```typescript
// src/tools/edit.ts
import { EMPTY_FILE_CHECKSUM, rangeChecksum } from "../trueline.ts";
import { type ToolResult } from "./types.ts";
import { validatePath, validateEdits, type EditInput } from "./shared.ts";
import { streamingEdit } from "../streaming-edit.ts";

interface EditParams {
  file_path: string;
  edits: EditInput[];
  projectDir?: string;
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const { file_path, edits, projectDir } = params;

  const validated = await validatePath(file_path, "Edit", projectDir);
  if (!validated.ok) return validated.error;

  const { resolvedPath, mtimeMs } = validated;

  const built = validateEdits(edits);
  if (!built.ok) return built.error;

  const result = await streamingEdit(
    resolvedPath,
    built.ops,
    built.checksumRefs,
    mtimeMs,
  );

  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }

  if (!result.changed) {
    return {
      content: [{
        type: "text",
        text: `Edit produced no changes — file not written.\n\nchecksum: ${result.newChecksum}`,
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `Edit applied successfully.\n\nchecksum: ${result.newChecksum}`,
    }],
  };
}
```

**Step 3: Run existing tests**

Run: `bun test tests/tools/edit.test.ts tests/integration.test.ts`
Expected: PASS (all existing tests pass without modification)

If any test fails, debug and fix `streamingEdit`. The error messages
must match exactly — the existing tests assert on message substrings
like "mismatch", "binary", "denied", "not a regular file", etc.

**Step 4: Run full test suite**

Run: `bun test`
Expected: PASS (all tests across all files)

**Step 5: Commit**

```bash
git add src/tools/edit.ts
git commit -m "feat(streaming-edit): wire handleEdit to streaming pipeline

handleEdit now uses validatePath → validateEdits → streamingEdit
instead of prepareFile → buildOps → applyEdits → atomicWriteFile.

The file is never loaded entirely into memory. Unchanged regions are
copied as raw bytes without string decode/encode.

All existing tests pass unchanged."
```

---

## Task 10: Clean up

Remove any dead imports or functions that are no longer used after the
streaming edit rewire. `prepareFile`, `buildOps`, and `applyEdits` stay
because `handleDiff` uses them.

**Files:**
- Modify: `src/tools/edit.ts` (remove unused imports if any)
- Modify: `src/tools/shared.ts` (remove unused exports if any)

**Step 1: Check for unused exports**

Use LSP `findReferences` on `prepareFile`, `buildOps`, `applyEdits` to
confirm they're still referenced by `diff.ts`.

Check that `handleEdit` no longer imports anything it doesn't use.

**Step 2: Remove dead code if found**

Only remove things that have zero references. Don't remove things
`handleDiff` still uses.

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 4: Commit (if any changes)**

```bash
git add -A
git commit -m "chore: remove dead imports after streaming edit migration"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | `fnv1aHashBytes` | 5 unit tests |
| 2 | `streamByteLines` | 7 unit tests |
| 3 | `validateEdits` | 6 unit tests |
| 4 | `streamingEdit` — basic replace | 4 integration tests |
| 5 | `streamingEdit` — insert_after | 3 integration tests |
| 6 | `streamingEdit` — multi-edit | 2 integration tests |
| 7 | `streamingEdit` — verification | 3 integration tests |
| 8 | `streamingEdit` — edge cases | 7 integration tests |
| 9 | Wire `handleEdit` | 0 new (existing tests) |
| 10 | Clean up | 0 new |

**Total new tests:** ~37
**Existing tests that must still pass:** ~115

## Behavioral note: mixed-EOL files

The streaming approach detects EOL from the first line ending and uses
it for replacement content. Unchanged lines preserve their original raw
bytes (including their original EOL). This means a file with mixed EOLs
won't have its unchanged lines normalized to the majority — only
replacement/insert content uses the detected EOL. This is arguably less
destructive than the current behavior (which normalizes all lines to the
majority). The existing mixed-EOL tests happen to pass because the
edited line is always the one with the minority EOL style.

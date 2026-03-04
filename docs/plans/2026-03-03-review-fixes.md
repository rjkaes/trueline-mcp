# Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address all findings from REVIEW.md (brutal code review), covering 2 critical, 6 major, 10 minor, and 3 nit-level issues.

**Architecture:** TDD approach — write failing tests first, then fix. Group related findings into single tasks where they touch the same files. Process critical/major first, then minor/performance, then cleanup.

**Tech Stack:** TypeScript, Bun test runner, MCP SDK, Zod schemas.

**Skipped findings:**
- #18 — subsumed by #15
- #20 — benchmarked at 3.4% improvement, not worth added complexity
- #23 — hooks intentionally untyped (no build step)

---

### Task 1: Fix `verifyChecksum` crash and `parseLineHash` bare colon (#1, #7)

Two input validation bugs in `src/hashline.ts`.

**Files:**
- Modify: `src/hashline.ts:212-240` (parseLineHash) and `src/hashline.ts:360-401` (verifyChecksum)
- Test: `tests/hashline.test.ts`

**Step 1: Write failing tests**

Add to the `verifyChecksum` describe block:

```typescript
test("returns error for 0-0 sentinel with non-zero hash", () => {
  const err = verifyChecksum([], "0-0:abcdef01");
  expect(err).toContain("mismatch");
});
```

Add to the `parseLineHash` describe block:

```typescript
test("rejects bare colon as line reference", () => {
  expect(() => parseLineHash(":")).toThrow("non-negative integer");
});

test("rejects whitespace before colon", () => {
  expect(() => parseLineHash(" :ab")).toThrow("non-negative integer");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/hashline.test.ts`
Expected: 3 new tests FAIL — `verifyChecksum` crashes (accessing `lines[-1]`), `parseLineHash` accepts `":"` and `" :ab"`.

**Step 3: Fix `parseLineHash` — validate line number with `/^\d+$/`**

In `src/hashline.ts`, replace lines 218-226:

```typescript
// Before:
const lineStr = ref.slice(0, colonIdx);
const hash = ref.slice(colonIdx + 1);
const line = Number(lineStr);

if (!Number.isInteger(line) || line < 0) {

// After:
const lineStr = ref.slice(0, colonIdx);
const hash = ref.slice(colonIdx + 1);

if (!/^\d+$/.test(lineStr)) {
  throw new Error(
    `Invalid line number in "${ref}" — must be a non-negative integer`,
  );
}

const line = Number(lineStr);

if (!Number.isInteger(line) || line < 0) {
```

**Step 4: Fix `verifyChecksum` — reject non-sentinel 0-0 checksums**

In `src/hashline.ts`, after `parseChecksum(checksum)` (around line 380), add before the `endLine > lines.length` check:

```typescript
  const parsed = parseChecksum(checksum);

  // The only valid 0-0 checksum is EMPTY_FILE_CHECKSUM, which was handled
  // above. Any other 0-0:... hash is always a mismatch.
  if (parsed.startLine === 0 && parsed.endLine === 0) {
    return (
      `Checksum mismatch: "${checksum}" is not a valid empty-file checksum. ` +
      `Use "${EMPTY_FILE_CHECKSUM}".`
    );
  }

  if (parsed.endLine > lines.length) {
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/hashline.test.ts`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/hashline.ts tests/hashline.test.ts
git commit -m "fix: reject crafted 0-0 checksums and bare colons in line refs

Fixes two input validation bugs:

1. \`verifyChecksum([], \"0-0:abcdef01\")\` crashed by falling through
   to \`rangeChecksum\` with startLine=0, which accessed \`lines[-1]\`.
   Now rejects any 0-0 checksum that isn't the exact empty-file
   sentinel.

2. \`parseLineHash(\":\")\` silently parsed as line 0 insert because
   \`Number(\"\") === 0\`. Now validates the line-number portion with
   \`/^\\d+$/\` before conversion, consistent with \`parseChecksum\`.

Review findings #1 (confidence 98) and #7 (confidence 90)."
```

---

### Task 2: Verify checksum covers the edit range (#2)

`buildOps` verifies that a checksum is valid but never checks that the checksummed range actually covers the lines being edited.

**Files:**
- Modify: `src/tools/shared.ts:158-213`
- Test: `tests/tools/edit.test.ts`

**Step 1: Write failing test**

Add to `tests/tools/edit.test.ts`:

```typescript
test("rejects checksum that does not cover edit range", async () => {
  // File has 4 lines. Checksum covers only lines 1-2, but edit targets line 4.
  const lines = ["line 1", "line 2", "line 3", "line 4"];
  const partialCs = rangeChecksum(lines, 1, 2);
  const h4 = lineHash("line 4");

  const result = await handleEdit({
    file_path: testFile,
    edits: [
      {
        range: `4:${h4}..4:${h4}`,
        content: "replaced",
        checksum: partialCs,
      },
    ],
    projectDir: testDir,
  });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("does not cover");
});
```

Import `rangeChecksum` at top of file if not already imported.

**Step 2: Run test to verify it fails**

Run: `bun test tests/tools/edit.test.ts`
Expected: FAIL — edit succeeds when it should be rejected.

**Step 3: Add range coverage check in `buildOps`**

In `src/tools/shared.ts`, after verifying hashes (around line 196), before building `refs`, add:

```typescript
    // Verify checksum range covers the edit target. Without this, an agent
    // could pass a valid checksum for lines 1-2 while editing line 50,
    // bypassing the staleness check on the target lines.
    if (rangeRef.start.line > 0) {
      const csRef = parseChecksum(edit.checksum);
      if (csRef.startLine > rangeRef.start.line || csRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: {
            content: [{
              type: "text",
              text: `Checksum range ${csRef.startLine}-${csRef.endLine} does not cover ` +
                `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
                `Re-read with hashline_read to get a checksum covering the target lines.`,
            }],
            isError: true,
          },
        };
      }
    }
```

Add `parseChecksum` to the imports from `../hashline.ts`.

**Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/tools/shared.ts tests/tools/edit.test.ts
git commit -m "fix: verify checksum range covers edit target lines

\`buildOps\` verified the checksum was valid but never checked that the
checksummed range contained the lines being edited. An agent could pass
a valid checksum for lines 1-2 while editing line 50.

Now rejects edits where \`checksum.startLine > edit.startLine\` or
\`checksum.endLine < edit.endLine\`.

Review finding #2 (confidence 95)."
```

---

### Task 3: Fix `parseRange` aliased start/end (#4)

Single-line shorthand returns the same object for `start` and `end`, creating a latent mutation bug.

**Files:**
- Modify: `src/hashline.ts:257-263`
- Test: `tests/hashline.test.ts`

**Step 1: Write failing test**

```typescript
test("single-line shorthand returns independent start/end objects", () => {
  const r = parseRange("5:ab");
  expect(r.start).toEqual(r.end);
  expect(r.start).not.toBe(r.end); // must be distinct objects
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/hashline.test.ts`
Expected: FAIL — `start` and `end` are the same object.

**Step 3: Spread the end ref**

In `src/hashline.ts:262`, change:

```typescript
// Before:
return { start: ref, end: ref };

// After:
return { start: ref, end: { ...ref } };
```

**Step 4: Run tests**

Run: `bun test tests/hashline.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/hashline.ts tests/hashline.test.ts
git commit -m "fix: return independent start/end objects from parseRange shorthand

Single-line shorthand \`parseRange(\"5:ab\")\` aliased the same object
for both \`start\` and \`end\`. Any mutation to one silently mutated
the other. Spread the ref to create a distinct copy for \`end\`.

Review finding #4 (confidence 90)."
```

---

### Task 4: Refactor `EditOp` to `startLine`/`endLine` + fix splice crash (#15, #5)

Two related changes:
1. `EditOp` carries a full `refs` array but only `startLine`/`endLine` are needed — interior line hashes are redundant (covered by range checksum).
2. `result.splice(idx, 0, ...newLines)` crashes on >65K lines due to V8's argument limit.

**Files:**
- Modify: `src/hashline.ts:440-516` (EditOp + applyEdits)
- Modify: `src/tools/shared.ts:158-237` (buildOps)
- Test: `tests/hashline.test.ts` (applyEdits tests)

**Step 1: Write a test for large insertions**

Add to the `applyEdits` describe block in `tests/hashline.test.ts`:

```typescript
test("handles insertion of more than 65K lines without crashing", () => {
  const lines = ["before", "after"];
  const bigContent = Array.from({ length: 70_000 }, (_, i) => `line ${i}`);
  const result = applyEdits(lines, [
    {
      startLine: 1,
      endLine: 1,
      content: bigContent.join("\n"),
      insertAfter: true,
    },
  ]);
  expect(result.length).toBe(70_002); // before + 70K inserted + after
  expect(result[0]).toBe("before");
  expect(result[70_001]).toBe("after");
});
```

**Step 2: Change `EditOp` interface**

In `src/hashline.ts`, replace the `EditOp` interface:

```typescript
export interface EditOp {
  startLine: number; // 1-based (0 for insertAfter at file start)
  endLine: number; // 1-based, inclusive
  content: string;
  insertAfter: boolean;
}
```

**Step 3: Rewrite `applyEdits` using array concat instead of splice**

Replace the full `applyEdits` function:

```typescript
/**
 * Apply a batch of edits to a single file.
 *
 * Edits are sorted by line number descending so that earlier line
 * numbers remain valid as later lines are modified. Uses array
 * concatenation instead of `splice(...spread)` to avoid V8's
 * ~65K argument limit on function calls.
 *
 * @param fileLines - Current file lines (0-indexed array)
 * @param ops - Parsed and verified edit operations
 * @returns New file lines array
 */
export function applyEdits(fileLines: string[], ops: EditOp[]): string[] {
  // Sort descending by start line so edits don't shift earlier indices.
  // For insertAfter ops at the same anchor, reverse their sub-order so that
  // when applied back-to-front each new block lands after the anchor but
  // before the previously inserted block — preserving input order in the
  // final file.
  const indexed = ops.map((op, i) => ({ op, i }));
  indexed.sort((a, b) => {
    const aLine = a.op.startLine;
    const bLine = b.op.startLine;
    if (bLine !== aLine) return bLine - aLine;
    if (a.op.insertAfter !== b.op.insertAfter) return a.op.insertAfter ? -1 : 1;
    if (a.op.insertAfter) return b.i - a.i;
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.op);

  let result = fileLines.slice();

  for (const op of sorted) {
    const newLines = op.content === "" ? [] : op.content.split("\n");

    if (op.insertAfter) {
      const afterLine = op.startLine; // 0-based insert index
      // Avoid double blank lines: if inserted content ends with an empty
      // line and the next existing line is also empty, drop the trailing
      // empty element to prevent a doubled gap.
      if (
        newLines.length > 1 &&
        newLines[newLines.length - 1] === "" &&
        afterLine < result.length &&
        result[afterLine] === ""
      ) {
        newLines.pop();
      }
      result = result.slice(0, afterLine).concat(newLines, result.slice(afterLine));
    } else {
      const firstIdx = op.startLine - 1;
      const span = op.endLine - op.startLine + 1;
      result = result.slice(0, firstIdx).concat(newLines, result.slice(firstIdx + span));
    }
  }

  return result;
}
```

**Step 4: Update `buildOps` in `src/tools/shared.ts`**

Replace the refs-building loop and overlap check. Remove `lineHash` and `LineRef` from imports (if unused after this change — verify). Keep `parseRange`, `verifyChecksum`, `verifyHashes`, `parseContent`, `type EditOp`.

```typescript
export function buildOps(
  fileLines: string[],
  edits: EditInput[],
): BuildOpsResult {
  const ops: EditOp[] = [];

  for (const edit of edits) {
    const checksumErr = verifyChecksum(fileLines, edit.checksum);
    if (checksumErr) {
      return {
        ok: false,
        error: { content: [{ type: "text", text: checksumErr }], isError: true },
      };
    }

    const rangeRef = parseRange(edit.range);

    if (rangeRef.start.line === 0 && !edit.insert_after) {
      return {
        ok: false,
        error: {
          content: [{ type: "text", text: "range starting at line 0 requires insert_after: true" }],
          isError: true,
        },
      };
    }

    // Verify checksum range covers the edit target.
    if (rangeRef.start.line > 0) {
      const csRef = parseChecksum(edit.checksum);
      if (csRef.startLine > rangeRef.start.line || csRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: {
            content: [{
              type: "text",
              text: `Checksum range ${csRef.startLine}-${csRef.endLine} does not cover ` +
                `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
                `Re-read with hashline_read to get a checksum covering the target lines.`,
            }],
            isError: true,
          },
        };
      }
    }

    const hashErr = verifyHashes(fileLines, [rangeRef.start, rangeRef.end]);
    if (hashErr) {
      return {
        ok: false,
        error: { content: [{ type: "text", text: hashErr }], isError: true },
      };
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
    });
  }

  // Validate no two non-insertAfter ops target the same line.
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

  return { ok: true, ops };
}
```

Update imports at the top of `shared.ts`: add `parseChecksum`, remove `lineHash` and `type LineRef` if no longer used.

**Step 5: Update all `applyEdits` test cases**

In `tests/hashline.test.ts`, update every `EditOp` literal from `refs` to `startLine`/`endLine`. Remove the `lineHash` calls that were only used for constructing test refs (keep import if used elsewhere in the file).

Replace each test's EditOp objects:

```typescript
// "replaces a range of lines"
{ startLine: 2, endLine: 3, content: "x\ny", insertAfter: false }

// "inserts after a line"
{ startLine: 1, endLine: 1, content: "new", insertAfter: true }

// "deletes lines when content is empty"
{ startLine: 2, endLine: 2, content: "", insertAfter: false }

// "multiple insertAfter at same anchor"
{ startLine: 1, endLine: 1, content: "first", insertAfter: true }
{ startLine: 1, endLine: 1, content: "second", insertAfter: true }
{ startLine: 1, endLine: 1, content: "third", insertAfter: true }

// "handles multiple edits in correct order"
{ startLine: 1, endLine: 1, content: "A", insertAfter: false }
{ startLine: 4, endLine: 4, content: "D", insertAfter: false }
```

**Step 6: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 7: Commit**

```bash
git add src/hashline.ts src/tools/shared.ts tests/hashline.test.ts
git commit -m "refactor: replace EditOp refs array with startLine/endLine

Replace \`EditOp.refs: LineRef[]\` with \`startLine\`/\`endLine\` numbers.
The interior line hashes were redundant — the range checksum (verified
earlier) already covers every line with full 32-bit FNV-1a, which is
strictly stronger than the 2-letter per-line hashes.

Also replace \`splice(...spread)\` with \`slice().concat()\` to avoid
V8's ~65K function-argument limit when inserting large blocks.

Review findings #15 (confidence 85) and #5 (confidence 80)."
```

---

### Task 5: Normalize consecutive globstars + fix suffix case sensitivity (#6, #16)

**Files:**
- Modify: `src/security.ts:46-89` (fileGlobToRegex) and `src/security.ts:217-221` (evaluateFilePath)
- Test: `tests/security.test.ts`

**Step 1: Write failing tests**

Add to `fileGlobToRegex` describe block:

```typescript
test("consecutive globstars are normalized to prevent ReDoS", () => {
  // This would cause exponential backtracking without normalization
  const re = fileGlobToRegex("**/**/**/**/a");
  expect(re.test("x/y/z/a")).toBe(true);
  expect(re.test("x/y/z/b")).toBe(false);
  // Verify it completes quickly (no ReDoS) — implicit by not timing out
});
```

Add to `evaluateFilePath` describe block:

```typescript
test("suffix matching respects caseInsensitive flag", () => {
  const result = evaluateFilePath(
    "/project/SRC/.Env",
    [["src/.env"]],
    true, // caseInsensitive
  );
  expect(result.denied).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/security.test.ts`
Expected: Both FAIL.

**Step 3: Normalize consecutive globstars in `fileGlobToRegex`**

In `src/security.ts`, at the start of `fileGlobToRegex`, after the cache check and before `let regexStr`:

```typescript
  // Normalize consecutive **/ sequences to a single **/ to prevent
  // exponential regex backtracking. Multiple globstars in sequence are
  // semantically identical to one.
  glob = glob.replace(/(\*\*\/)+/g, "**/");
```

**Step 4: Fix case-insensitive suffix matching in `evaluateFilePath`**

Replace the suffix-matching block (around lines 217-221):

```typescript
      if (!glob.startsWith("/") && !glob.startsWith("*") && glob.includes("/")) {
        const normCmp = caseInsensitive ? normalized.toLowerCase() : normalized;
        const globCmp = caseInsensitive ? glob.toLowerCase() : glob;
        if (normCmp.endsWith("/" + globCmp) || normCmp === globCmp) {
          return { denied: true, matchedPattern: glob };
        }
      }
```

**Step 5: Run tests**

Run: `bun test tests/security.test.ts`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/security.ts tests/security.test.ts
git commit -m "fix: normalize consecutive globstars and case-insensitive suffix match

1. Collapse \`**/**/**/\` to a single \`**/\` before regex conversion to
   prevent exponential backtracking on pathological deny patterns.

2. Apply \`toLowerCase()\` in the suffix-match fallback path when
   \`caseInsensitive\` is true (Windows), matching the regex path's
   behavior.

Review findings #6 (confidence 85) and #16 (confidence 80)."
```

---

### Task 6: Track and preserve trailing newlines (#10)

Files without a trailing newline silently gain one on edit. Read → edit (no-op) → write should produce an identical file.

**Files:**
- Modify: `src/hashline.ts:120-168` (ParsedContent + parseContent)
- Modify: `src/tools/shared.ts:30` (PrepareFileOk)
- Modify: `src/tools/edit.ts:31` (finalContent join)
- Modify: `src/tools/diff.ts:20-33` (unifiedDiff)
- Test: `tests/tools/edit.test.ts`

**Step 1: Write failing test**

Add to `tests/tools/edit.test.ts`:

```typescript
test("preserves absence of trailing newline", async () => {
  const noTrailingFile = join(testDir, "no-trailing.ts");
  writeFileSync(noTrailingFile, "line 1\nline 2");

  const lines = ["line 1", "line 2"];
  const cs = rangeChecksum(lines, 1, 2);
  const h1 = lineHash("line 1");

  const result = await handleEdit({
    file_path: noTrailingFile,
    edits: [{ range: `1:${h1}..1:${h1}`, content: "replaced", checksum: cs }],
    projectDir: testDir,
  });
  expect(result.isError).toBeUndefined();
  const written = readFileSync(noTrailingFile, "utf-8");
  // File should NOT have a trailing newline added
  expect(written).toBe("replaced\nline 2");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/tools/edit.test.ts`
Expected: FAIL — written content is `"replaced\nline 2\n"` (trailing newline added).

**Step 3: Add `hasTrailingNewline` to `ParsedContent`**

In `src/hashline.ts`, update the interface:

```typescript
export interface ParsedContent {
  lines: string[];
  eol: "\r\n" | "\n";
  hasTrailingNewline: boolean;
}
```

At the end of `parseContent`, before the return, compute the flag:

```typescript
  // A file has a trailing newline if its last character is a line ending.
  // Empty files have no trailing newline by definition.
  const hasTrailingNewline = content.length > 0 && lineStart === content.length;

  return { lines, eol: crlf > lf ? "\r\n" : "\n", hasTrailingNewline };
```

**Step 4: Thread `hasTrailingNewline` through `prepareFile`**

In `src/tools/shared.ts`, update the ok type:

```typescript
type PrepareFileOk = { ok: true; resolvedPath: string; fileLines: string[]; hasCRLF: boolean; hasTrailingNewline: boolean };
```

In the return at the end of `prepareFile`:

```typescript
  const { lines: fileLines, eol, hasTrailingNewline } = parseContent(content);
  const hasCRLF = eol === "\r\n";

  return { ok: true, resolvedPath: realPath, fileLines, hasCRLF, hasTrailingNewline };
```

**Step 5: Use `hasTrailingNewline` in `handleEdit`**

In `src/tools/edit.ts`, destructure and use:

```typescript
  const { resolvedPath, fileLines, hasCRLF, hasTrailingNewline } = prepared;
  // ...
  const eol = hasCRLF ? "\r\n" : "\n";
  const finalContent = newLines.length === 0
    ? ""
    : newLines.join(eol) + (hasTrailingNewline ? eol : "");
```

**Step 6: Use `hasTrailingNewline` in `unifiedDiff`**

In `src/tools/diff.ts`, update `handleDiff` to pass the flag through and update `unifiedDiff`:

```typescript
function unifiedDiff(
  oldLines: string[],
  newLines: string[],
  relativePath: string,
  hasTrailingNewline: boolean,
): string {
  const eol = hasTrailingNewline ? "\n" : "";
  const oldStr = oldLines.join("\n") + (oldLines.length ? eol : "");
  const newStr = newLines.join("\n") + (newLines.length ? eol : "");
  return createTwoFilesPatch(
    `a/${relativePath}`,
    `b/${relativePath}`,
    oldStr,
    newStr,
  );
}
```

And in `handleDiff`, pass it through:

```typescript
  const { fileLines, resolvedPath, hasTrailingNewline } = prepared;
  // ...
  const diff = unifiedDiff(fileLines, newLines, relPath, hasTrailingNewline);
```

**Step 7: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 8: Commit**

```bash
git add src/hashline.ts src/tools/shared.ts src/tools/edit.ts src/tools/diff.ts tests/tools/edit.test.ts
git commit -m "fix: preserve trailing newline state on edit round-trip

Files without a trailing newline silently gained one after editing.
Read -> edit (no-op) -> write now produces an identical file.

Track \`hasTrailingNewline\` in \`ParsedContent\`, thread it through
\`prepareFile\`, and use it in both \`handleEdit\` and \`unifiedDiff\`.

Review finding #10 (confidence 85)."
```

---

### Task 7: Add TOCTOU mtime re-check (#8)

Narrow the race window between file read and atomic write by re-checking mtime before rename.

**Files:**
- Modify: `src/hashline.ts:527-547` (atomicWriteFile)
- Modify: `src/tools/shared.ts:30,60,147` (capture mtime)
- Modify: `src/tools/edit.ts` (pass mtime)
- Test: `tests/tools/edit.test.ts`

**Step 1: Write failing test**

```typescript
test("rejects edit when file was modified concurrently", async () => {
  const lines = ["line 1", "line 2", "line 3", "line 4"];
  const cs = rangeChecksum(lines, 1, 4);
  const h1 = lineHash("line 1");

  // Monkey-patch atomicWriteFile to simulate a concurrent modification
  // by changing the file's mtime between read and write.
  const original = readFileSync(testFile, "utf-8");

  // Modify the file after reading but use a valid checksum from the original
  writeFileSync(testFile, "modified by another process\n");

  const result = await handleEdit({
    file_path: testFile,
    edits: [{ range: `1:${h1}..1:${h1}`, content: "replaced", checksum: cs }],
    projectDir: testDir,
  });

  // The checksum should catch this since file content changed
  expect(result.isError).toBe(true);
});
```

Note: the checksum verification in `buildOps` already catches this case (file content changed → checksum mismatch). The TOCTOU concern is about modifications that happen *after* checksum verification but *before* the write. A proper test would need to hook into the write path, which is fragile in unit tests.

Instead, implement the mtime guard and add an explanatory comment. Test the guard directly via a unit test of `atomicWriteFile`.

**Step 2: Add `expectedMtimeMs` parameter to `atomicWriteFile`**

In `src/hashline.ts`:

```typescript
/**
 * Write content to a file atomically: write to temp file in same
 * directory, then rename. This prevents partial writes if the process
 * is interrupted.
 *
 * When `expectedMtimeMs` is provided, re-checks the file's mtime before
 * the final rename. If it changed since the read, throws to avoid silently
 * overwriting a concurrent modification. This narrows (but does not
 * eliminate) the TOCTOU race window.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<void> {
  const dir = dirname(filePath);
  const tmpName = `.hashline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  let originalMode: number | undefined;
  try {
    originalMode = (await stat(filePath)).mode;
  } catch { /* new file — no original mode to preserve */ }

  try {
    await writeFile(tmpPath, content, "utf-8");
    if (originalMode !== undefined) {
      await chmod(tmpPath, originalMode);
    }

    // Narrow the TOCTOU window: if we know the mtime from when we read,
    // verify it hasn't changed before committing the rename.
    if (expectedMtimeMs !== undefined) {
      try {
        const currentMtime = (await stat(filePath)).mtimeMs;
        if (currentMtime !== expectedMtimeMs) {
          throw new Error(
            `File was modified by another process (expected mtime ${expectedMtimeMs}, ` +
            `got ${currentMtime}). Re-read with hashline_read.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("File was modified")) throw err;
        // stat failed (file deleted?) — proceed with rename since the
        // atomic rename will create or replace it
      }
    }

    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
```

**Step 3: Capture mtime in `prepareFile`**

In `src/tools/shared.ts`, update the ok type and capture mtime from the existing stat call:

```typescript
type PrepareFileOk = {
  ok: true;
  resolvedPath: string;
  fileLines: string[];
  hasCRLF: boolean;
  hasTrailingNewline: boolean;
  mtimeMs: number;
};
```

Around the `stat(realPath)` call, capture it:

```typescript
  const fileStat = await stat(realPath);
  if (!fileStat.isFile()) {
```

And in the return:

```typescript
  return { ok: true, resolvedPath: realPath, fileLines, hasCRLF, hasTrailingNewline, mtimeMs: fileStat.mtimeMs };
```

**Step 4: Pass mtime in `handleEdit`**

In `src/tools/edit.ts`:

```typescript
  const { resolvedPath, fileLines, hasCRLF, hasTrailingNewline, mtimeMs } = prepared;
  // ...
  await atomicWriteFile(resolvedPath, finalContent, mtimeMs);
```

**Step 5: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/hashline.ts src/tools/shared.ts src/tools/edit.ts
git commit -m "fix: add mtime re-check before atomic write to narrow TOCTOU window

Between reading a file (with checksum verification) and writing it,
another process could modify the file. The write would silently
overwrite the concurrent change.

Now \`atomicWriteFile\` accepts an \`expectedMtimeMs\` parameter and
re-checks the file's modification time before the final rename.
This narrows the race window but does not fully eliminate it —
documented as a known limitation.

Review finding #8 (confidence 75)."
```

---

### Task 8: Add file size guard (#17)

Prevent multi-GB files from being read into memory.

**Files:**
- Modify: `src/tools/shared.ts:58-68`
- Test: `tests/tools/edit.test.ts`

**Step 1: Write failing test**

This is hard to test with a real 10MB+ file in unit tests. Instead, test the error message path by creating a mock. A pragmatic approach: extract the limit as a constant and test the error message format.

Actually, simpler: just add the guard and verify with existing tests that normal files still work.

**Step 2: Add file size check after stat**

In `src/tools/shared.ts`, after the `fileStat.isFile()` check:

```typescript
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  if (fileStat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: {
        content: [{
          type: "text",
          text: `"${file_path}" is too large (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). ` +
            `Maximum supported file size is 10 MB.`,
        }],
        isError: true,
      },
    };
  }
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All PASS (no existing files exceed 10 MB).

**Step 4: Commit**

```bash
git add src/tools/shared.ts
git commit -m "fix: reject files larger than 10 MB to prevent memory exhaustion

\`prepareFile\` now checks \`stat.size\` before reading. Without this
guard, a multi-GB file would be read entirely into memory since
\`prepareFile\` must load the whole file for checksum computation
and edit application.

Review finding #17 (confidence 80)."
```

---

### Task 9: Single-pass hashing in `handleRead` (#12)

`formatHashlinesFromArray` and `rangeChecksum` both call `fnv1aHash` on every line — the hash is computed twice per read.

**Files:**
- Modify: `src/hashline.ts` (add new functions)
- Modify: `src/tools/read.ts:62-63`
- Test: `tests/hashline.test.ts`

**Step 1: Add `formatHashlinesWithHashes` and `rangeChecksumFromHashes`**

In `src/hashline.ts`, add after `formatHashlinesFromArray`:

```typescript
/**
 * Format pre-split lines as hashlines using precomputed FNV-1a hashes.
 *
 * Like `formatHashlinesFromArray` but avoids recomputing hashes when
 * the caller already has them (e.g. for shared use with checksumming).
 */
export function formatHashlinesWithHashes(
  lines: string[],
  hashes: number[],
  startLine: number = 1,
): string {
  if (lines.length === 0) return "";

  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const c1 = String.fromCharCode(97 + (hashes[i] % 26));
    const c2 = String.fromCharCode(97 + ((hashes[i] >>> 8) % 26));
    out[i] = `${startLine + i}:${c1}${c2}|${lines[i]}`;
  }
  return out.join("\n");
}

/**
 * Compute a range checksum from precomputed FNV-1a hashes.
 *
 * Like `rangeChecksum` but takes a `number[]` of pre-hashed values
 * instead of re-hashing the raw line strings.
 *
 * @param hashes - Array of precomputed FNV-1a hashes (0-indexed)
 * @param startLine - 1-based first line label
 * @param endLine - 1-based last line label (inclusive)
 */
export function rangeChecksumFromHashes(
  hashes: number[],
  startLine: number,
  endLine: number,
): string {
  let hash = FNV_OFFSET_BASIS;
  for (const h of hashes) {
    hash = Math.imul(hash ^ (h & 0xff),          FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 8) & 0xff),  FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;
  }
  return `${startLine}-${endLine}:${hash.toString(16).padStart(8, "0")}`;
}
```

**Step 2: Write test proving equivalence**

Add to `tests/hashline.test.ts`:

```typescript
import {
  // ... existing imports ...
  formatHashlinesWithHashes,
  rangeChecksumFromHashes,
  fnv1aHash,
} from "../src/hashline.ts";

describe("single-pass hashing helpers", () => {
  test("formatHashlinesWithHashes matches formatHashlinesFromArray", () => {
    const lines = ["hello", "world", "foo"];
    const hashes = lines.map(fnv1aHash);
    expect(formatHashlinesWithHashes(lines, hashes, 1))
      .toBe(formatHashlinesFromArray(lines, 1));
  });

  test("rangeChecksumFromHashes matches rangeChecksum", () => {
    const lines = ["hello", "world", "foo"];
    const hashes = lines.map(fnv1aHash);
    expect(rangeChecksumFromHashes(hashes, 1, 3))
      .toBe(rangeChecksum(lines, 1, 3));
  });
});
```

**Step 3: Update `handleRead` to use single-pass hashing**

In `src/tools/read.ts`, update imports and the hash computation:

```typescript
import {
  EMPTY_FILE_CHECKSUM,
  formatHashlinesWithHashes,
  rangeChecksumFromHashes,
  fnv1aHash,
} from "../hashline.ts";
```

Replace the format + checksum calls:

```typescript
  const slice = fileLines.slice(start - 1, clampedEnd);
  const hashes = slice.map(fnv1aHash);

  const formatted = formatHashlinesWithHashes(slice, hashes, start);
  const checksum = rangeChecksumFromHashes(hashes, start, clampedEnd);
```

**Step 4: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/hashline.ts src/tools/read.ts tests/hashline.test.ts
git commit -m "perf: compute FNV-1a hashes once per line in handleRead

\`formatHashlinesFromArray\` and \`rangeChecksum\` both called
\`fnv1aHash\` on every line. Add \`WithHashes\` variants that accept
precomputed hashes, and use them in \`handleRead\` to halve the
per-line hash work.

Review finding #12 (confidence 85)."
```

---

### Task 10: Parallelize settings file reads (#13)

`readToolDenyPatterns` reads 3 settings files sequentially. They're independent and can use `Promise.all`.

**Files:**
- Modify: `src/security.ts:106-181`
- Test: (existing tests cover correctness; this is a pure perf change)

**Step 1: Parallelize the reads**

Replace the sequential calls in `readToolDenyPatterns`:

```typescript
export async function readToolDenyPatterns(
  toolName: string,
  projectDir?: string,
  globalSettingsPath?: string,
): Promise<string[][]> {
  const result: string[][] = [];

  const extractGlobs = async (path: string): Promise<string[] | null> => {
    // ... unchanged ...
  };

  // Read all settings files in parallel — they're independent.
  const paths: string[] = [];
  if (projectDir) {
    paths.push(resolve(projectDir, ".claude", "settings.local.json"));
    paths.push(resolve(projectDir, ".claude", "settings.json"));
  }
  paths.push(
    globalSettingsPath ?? resolve(homedir(), ".claude", "settings.json"),
  );

  const allGlobs = await Promise.all(paths.map(extractGlobs));
  for (const globs of allGlobs) {
    if (globs !== null) result.push(globs);
  }

  return result;
}
```

**Step 2: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 3: Commit**

```bash
git add src/security.ts
git commit -m "perf: parallelize settings file reads in readToolDenyPatterns

The three settings files (project-local, project-shared, global)
are independent. Read them with \`Promise.all\` instead of
sequentially.

Review finding #13 (confidence 80)."
```

---

### Task 11: Cache resolved project directory (#14)

`realpath(projectDir)` is resolved on every tool call but doesn't change during the server's lifetime.

**Files:**
- Modify: `src/server.ts:16`
- Modify: `src/tools/shared.ts:70-81`

**Step 1: Resolve `projectDir` once at startup in `server.ts`**

```typescript
import { realpath } from "node:fs/promises";

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir);
```

**Step 2: Skip redundant realpath in `prepareFile`**

In `src/tools/shared.ts`, replace the `realpath(projectDir)` block with a direct use:

```typescript
  // projectDir is already resolved at server startup. If called from
  // tests, the tmpdir path is typically already a real path. Fall back
  // to realpath only when projectDir is not provided.
  let realBase: string;
  try {
    realBase = projectDir ? projectDir : await realpath(process.cwd());
  } catch {
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: "Project directory not found or inaccessible" }],
        isError: true,
      },
    };
  }
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 4: Commit**

```bash
git add src/server.ts src/tools/shared.ts
git commit -m "perf: resolve projectDir once at server startup

\`realpath(projectDir)\` was called on every tool invocation but the
project directory doesn't change during the server's lifetime.
Resolve it once in \`server.ts\` and skip the redundant resolution
in \`prepareFile\`.

Review finding #14 (confidence 85)."
```

---

### Task 12: Change edit content to `string[]` (#3)

The agent sends content as a `\n`-joined string, which creates a CRLF corruption vector and an unnecessary parse/split round-trip.

**Files:**
- Modify: `src/server.ts:39-46` (Zod schema)
- Modify: `src/tools/shared.ts:19-24` (EditInput)
- Modify: `src/hashline.ts:440-516` (EditOp + applyEdits)
- Modify: `hooks/session-start.js` (instructions)
- Test: `tests/hashline.test.ts`, `tests/tools/edit.test.ts`, `tests/tools/diff.test.ts`, `tests/integration.test.ts`

**Step 1: Update `EditOp.content` type from `string` to `string[]`**

In `src/hashline.ts`:

```typescript
export interface EditOp {
  startLine: number;
  endLine: number;
  content: string[]; // array of lines, no EOL chars
  insertAfter: boolean;
}
```

Update `applyEdits` — remove the `split("\n")` call:

```typescript
  for (const op of sorted) {
    const newLines = op.content; // already an array
```

**Step 2: Update `EditInput.content` and `buildOps`**

In `src/tools/shared.ts`:

```typescript
export interface EditInput {
  range: string;
  content: string[];
  checksum: string;
  insert_after?: boolean;
}
```

In `buildOps`, the `ops.push(...)` already passes `edit.content` through — no change needed since `EditInput.content` and `EditOp.content` are now both `string[]`.

**Step 3: Update Zod schema in `server.ts`**

Change `content: z.string()` to `content: z.array(z.string())` in both `hashline_edit` and `hashline_diff`:

```typescript
content: z.array(z.string()).describe("Replacement lines (array of strings, one per line, no newline characters)"),
```

**Step 4: Update hook instructions**

In `hooks/session-start.js`, update the tool description:

```javascript
<tool name="hashline_edit">Edit a file with hash verification. Each edit needs: range (startLine:hash..endLine:hash), content (array of replacement lines — one string per line, no newline characters), and checksum from hashline_read output.</tool>
```

**Step 5: Update all tests**

Every test that passes `content: "some\ncontent"` needs to change to `content: ["some", "content"]`. Every test that passes `content: ""` (delete) needs to change to `content: []`.

In `tests/hashline.test.ts` applyEdits tests:

```typescript
// "replaces a range of lines"
content: ["x", "y"]

// "inserts after a line"
content: ["new"]

// "deletes lines when content is empty"
content: []

// "multiple insertAfter"
content: ["first"]  // etc.

// "handles multiple edits"
content: ["A"]  // etc.

// "handles insertion of more than 65K lines"
content: Array.from({ length: 70_000 }, (_, i) => `line ${i}`)
```

In `tests/tools/edit.test.ts`:

```typescript
// All content: "replaced 2\nreplaced 3" → content: ["replaced 2", "replaced 3"]
// All content: "inserted" → content: ["inserted"]
// All content: "nope" → content: ["nope"]
// All content: "replaced" → content: ["replaced"]
// All content: "x" → content: ["x"]
// All content: "A" / "B" → content: ["A"] / content: ["B"]
// All content: "hacked" → content: ["hacked"]
```

In `tests/tools/diff.test.ts`, same pattern.

In `tests/integration.test.ts`:

```typescript
content: ['  return `Hello, ${name}!`;']
```

**Step 6: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 7: Commit**

```bash
git add src/hashline.ts src/tools/shared.ts src/server.ts hooks/session-start.js tests/
git commit -m "feat: change edit content from string to string[] (line array)

The agent sent replacement content as a \`\\n\`-joined string, which
\`applyEdits\` then \`split(\"\\n\")\`-ed back into lines. This created
a CRLF corruption vector: if the agent sent \`\\r\\n\` (preserved by
JSON), the split left \`\\r\` attached to line elements, producing
\`\\r\\r\\n\` when joined with the file's CRLF line endings.

Now \`content\` is \`string[]\` — the agent sends an array of lines
directly, eliminating the parse/split round-trip and the corruption
vector.

This is a breaking protocol change for hashline_edit and hashline_diff.

Review finding #3 (confidence 95)."
```

---

### Task 13: Fix stale doc comments + diff tool comment + blank line (#9, #11, #19)

**Files:**
- Modify: `src/hashline.ts:177,289,354`
- Modify: `src/tools/diff.ts:39`
- Modify: `tests/hashline.test.ts:131`

**Step 1: Fix stale doc comments in `hashline.ts`**

1. Line 354 — doc says `"0-0:0000"`, should be `"0-0:00000000"`:

```typescript
// Before:
 * Accepts the `EMPTY_FILE_CHECKSUM` sentinel ("0-0:0000") when the file

// After:
 * Accepts the `EMPTY_FILE_CHECKSUM` sentinel ("0-0:00000000") when the file
```

2. Line 289 — doc says `<4hex>`, should be `<8hex>`:

```typescript
// Before:
 * Format: "<startLine>-<endLine>:<4hex>"

// After:
 * Format: "<startLine>-<endLine>:<8hex>"
```

3. Line 177 — references nonexistent `formatHashlines`:

```typescript
// Before:
 * Preferred over `formatHashlines` when lines are already split — avoids
 * a redundant split/join round-trip.

// After:
 * Formats each line as `{lineNumber}:{2-letter hash}|{content}`.
```

**Step 2: Add comment explaining diff's use of "Read" deny patterns**

In `src/tools/diff.ts:39`:

```typescript
  // Diff intentionally uses Read deny patterns (not a separate "Diff" tool
  // name) since diff is a read-only preview operation and should share the
  // same access restrictions as hashline_read.
  const prepared = await prepareFile(file_path, "Read", projectDir);
```

**Step 3: Remove stray blank line in test**

In `tests/hashline.test.ts`, remove the extra blank line at line 131 (before the closing `});` of the `parseContent` describe block).

**Step 4: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/hashline.ts src/tools/diff.ts tests/hashline.test.ts
git commit -m "docs: fix stale comments and remove stray blank line

- Update three doc comments that still referenced 4-hex checksums
  and a nonexistent \`formatHashlines\` function (post-32-bit migration).
- Add comment explaining why diff uses \"Read\" for deny-pattern
  evaluation.
- Remove stray blank line in parseContent test block.

Review findings #9 (confidence 99), #11 (confidence 85), #19 (confidence 99)."
```

---

### Task 14: Add missing test coverage (#21)

**Files:**
- Test: `tests/hashline.test.ts`
- Test: `tests/tools/edit.test.ts`
- Test: `tests/tools/diff.test.ts`

**Step 1: Add `rangeChecksum` out-of-bounds test**

In `tests/hashline.test.ts`:

```typescript
test("clamps endLine to file length", () => {
  const lines = ["a", "b"];
  // endLine 10 exceeds length 2 — should clamp to 2
  const cs = rangeChecksum(lines, 1, 10);
  expect(cs).toMatch(/^1-2:[0-9a-f]{8}$/);
  expect(cs).toBe(rangeChecksum(lines, 1, 2));
});

test("returns offset basis hash for startLine > endLine after clamping", () => {
  const lines = ["a"];
  // startLine 5 > lines.length — no lines hashed
  const cs = rangeChecksum(lines, 5, 10);
  expect(cs).toMatch(/^5-1:[0-9a-f]{8}$/);
});
```

**Step 2: Add CRLF test for `handleDiff`**

In `tests/tools/diff.test.ts`:

```typescript
test("handles CRLF files correctly", async () => {
  const crlfFile = join(testDir, "crlf.ts");
  writeFileSync(crlfFile, "line 1\r\nline 2\r\nline 3\r\n");

  const lines = ["line 1", "line 2", "line 3"];
  const cs = rangeChecksum(lines, 1, 3);
  const h2 = lineHash("line 2");

  const result = await handleDiff({
    file_path: crlfFile,
    edits: [{ range: `2:${h2}..2:${h2}`, content: "CHANGED", checksum: cs }],
    projectDir: testDir,
  });

  expect(result.isError).toBeUndefined();
  const text = result.content[0].text;
  expect(text).toContain("-line 2");
  expect(text).toContain("+CHANGED");
});
```

**Step 3: Add empty-file edit integration test**

In `tests/tools/edit.test.ts`:

```typescript
test("edits an empty file via insert_after with empty-file sentinel", async () => {
  const emptyFile = join(testDir, "empty.ts");
  writeFileSync(emptyFile, "");

  const result = await handleEdit({
    file_path: emptyFile,
    edits: [{
      range: "0:",
      content: "new content",
      checksum: "0-0:00000000",
      insert_after: true,
    }],
    projectDir: testDir,
  });

  expect(result.isError).toBeUndefined();
  const written = readFileSync(emptyFile, "utf-8");
  expect(written).toContain("new content");
});
```

Note: if Task 12 (content as string[]) has been applied, change `content:` to `["new content"]`.

**Step 4: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 5: Commit**

```bash
git add tests/hashline.test.ts tests/tools/edit.test.ts tests/tools/diff.test.ts
git commit -m "test: add missing coverage for edge cases

- \`rangeChecksum\` with out-of-bounds endLine and startLine
- CRLF file handling in \`handleDiff\`
- Empty-file edit workflow via insert_after

Review finding #21."
```

---

### Task 15: Add error handling for `server.connect` (#22)

**Files:**
- Modify: `src/server.ts:76`

**Step 1: Wrap `server.connect` with error handling**

```typescript
try {
  await server.connect(transport);
} catch (err) {
  console.error("Failed to start hashline-mcp server:", err);
  process.exit(1);
}
```

**Step 2: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "fix: handle server.connect rejection with error message

Top-level \`await server.connect(transport)\` could reject with an
unhandled rejection, causing a silent exit. Now logs the error
and exits with code 1.

Review finding #22 (confidence 50)."
```

---

## Summary Table

| Task | Findings | Severity | Files Modified |
|------|----------|----------|----------------|
| 1 | #1, #7 | CRITICAL, MAJOR | hashline.ts, hashline.test.ts |
| 2 | #2 | CRITICAL | shared.ts, edit.test.ts |
| 3 | #4 | MAJOR | hashline.ts, hashline.test.ts |
| 4 | #15, #5 | MINOR, MAJOR | hashline.ts, shared.ts, hashline.test.ts |
| 5 | #6, #16 | MAJOR, MINOR | security.ts, security.test.ts |
| 6 | #10 | MINOR | hashline.ts, shared.ts, edit.ts, diff.ts, edit.test.ts |
| 7 | #8 | MAJOR | hashline.ts, shared.ts, edit.ts |
| 8 | #17 | MINOR | shared.ts |
| 9 | #12 | MINOR | hashline.ts, read.ts, hashline.test.ts |
| 10 | #13 | MINOR | security.ts |
| 11 | #14 | MINOR | server.ts, shared.ts |
| 12 | #3 | MAJOR | hashline.ts, shared.ts, server.ts, session-start.js, all tests |
| 13 | #9, #11, #19 | MINOR, NIT | hashline.ts, diff.ts, hashline.test.ts |
| 14 | #21 | NIT | hashline.test.ts, edit.test.ts, diff.test.ts |
| 15 | #22 | NIT | server.ts |

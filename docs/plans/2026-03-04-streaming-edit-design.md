# Streaming Edit Design

Replace `handleEdit`'s in-memory pipeline with a single-pass byte-level
streaming engine that never loads the entire file into memory.

## Motivation

`handleEdit` currently calls `readFile()` to load the whole file as a
string, then `parseContent()` splits it into a lines array — two full
copies in memory before any work begins. For a 10 MB file (the current
cap), that's ~20 MB of V8 heap strings plus the lines array overhead.

The single-pass byte-level approach streams raw `Buffer` chunks from
source to temp file, only decoding lines when hash verification requires
it. Unchanged regions are copied as raw bytes with zero string
allocation.

## Scope

- `handleEdit` only. `handleDiff` stays in-memory (no write, files
  capped at 10 MB).
- Public MCP tool API unchanged (same params, same response format).

## New Modules

### `src/streaming-edit.ts`

**`fnv1aHashBytes(buf, start, end)`** — compute FNV-1a 32-bit hash
directly on a `Buffer` slice. Same algorithm as `fnv1aHash` but feeds
raw UTF-8 bytes from the buffer instead of encoding JS string codepoints
inline.

**`streamingEdit(resolvedPath, ops, checksumRefs, mtimeMs)`** — the
single-pass engine. Takes pre-validated path, pre-parsed edit ops and
checksum references, and the mtime from `validatePath`. Returns result
with new checksum or error.

## Algorithm

```
Pre-parse:
  Sort edits ascending by startLine
  Group insert_after ops at same anchor (preserve input order)
  Parse all checksum refs to know verification range

Single pass:
  Open raw read stream + write stream to temp file
  Track: byteOffset, lineNumber, checksumAccumulator,
         outputChecksumAccumulator, eolStyle, contentChanged

  For each raw chunk, scan for line endings (0x0A, 0x0D):
    lineNumber++

    If line in checksum range:
      fnv1aHashBytes on raw bytes → feed checksumAccumulator

    If line is edit boundary (start/end):
      Compute 2-letter hash from fnv1aHashBytes → verify match

    If line in replaced range:
      Don't write to output
      At range end: write replacement content with detected EOL
      Feed replacement lines into outputChecksumAccumulator
      Set contentChanged = true (unless replacement equals original)

    If line is insert_after anchor:
      Write line bytes + EOL to output
      Feed line hash into outputChecksumAccumulator
      Write insert content with detected EOL
      Feed insert lines into outputChecksumAccumulator
      Set contentChanged = true

    Otherwise (unchanged line):
      Write raw bytes directly to output (zero decode/encode)
      Feed fnv1aHashBytes result into outputChecksumAccumulator

  After stream:
    Verify checksumAccumulator against expected checksum
    If mismatch → delete temp, return error with recovery guidance
    If match + contentChanged → mtime check → atomic rename
    If match + !contentChanged → delete temp, return "no changes"
    Return outputChecksumAccumulator as new full-file checksum
```

## EOL Detection

Detect from the first line ending in raw bytes:
- `0x0D 0x0A` → CRLF
- lone `0x0A` → LF
- lone `0x0D` → LF (bare CR treated as LF, matching `parseContent`)

Used only for encoding replacement content. Unchanged regions preserve
original bytes exactly.

## Checksum Range

The checksum may cover only a subset of the file (from a partial
`trueline_read`). Lines outside the range are streamed for line counting
and byte copying but not hashed into the checksum accumulator.

## Validation Refactoring

Extract `validateEdits(edits)` from `buildOps` — the subset of
validation that doesn't need file content:
- Parse ranges and checksums
- Validate line-0 constraints
- Check checksum range covers edit target
- Detect overlapping replace ranges

File-content verification (checksum match, boundary hash match) moves
into the streaming pass.

## `handleEdit` Pipeline Change

```
Before:  prepareFile → buildOps → applyEdits → join → atomicWriteFile
After:   validatePath → validateEdits → streamingEdit
```

## No-Op Detection

Track `contentChanged` flag during the stream. If all replacement
content is byte-identical to the original, skip the rename, delete the
temp file, and return the "no changes" response.

## Full-File Checksum

Maintain an `outputChecksumAccumulator` that feeds every line written to
the temp file. For raw-copied lines, use the FNV-1a hash already
computed from raw bytes. For replacement lines, hash the strings. This
gives us the full-file checksum without re-reading the output.

## Concurrent Modification Detection

Same as today:
- Checksum verification catches content changes within the read range
- mtime re-check before atomic rename catches external modifications
- If mtime changed between validatePath and rename, abort and return
  error asking for re-read

## What Stays the Same

- `validatePath` — security checks, mtime capture
- `atomicWriteFile` — mtime-check-then-rename portion reused
- `applyEdits` — still used by `handleDiff`
- `buildOps` — still used by `handleDiff`
- Error messages and recovery guidance — identical strings
- `prepareFile` — still used by `handleDiff`

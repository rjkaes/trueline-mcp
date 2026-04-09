# Invariant Bridge: TLA+ <-> Property Tests <-> Source Code

This document traces each verified invariant across three artifacts:
the TLA+ formal specification, the fast-check property tests, and
the source code that implements the invariant.

## Traceability Matrix

| ID  | Invariant                | TLA+ (specs/EditProtocol.tla) | Property Test (tests/formal/) | Source Code |
|-----|--------------------------|-------------------------------|-------------------------------|-------------|
| I1  | Content preservation     | `ContentPreservation` invariant; `BeginEdit` checksum guard | P1 | `streaming-edit.ts` checksum validation in streaming loop |
| I2  | Edit ordering            | `BeginEdit` multi-op with `ApplyOps`; two-op quantifier in `Next` | P2 | `streaming-edit.ts:87-96` op sorting + single-pass |
| I2a | Delete isolation         | `ApplyOps` replace branch (empty `newContent`) | P2a | `streaming-edit.ts` line-copy around edit ranges |
| I2b | Insert preservation      | `ApplyOps` insert-after branch; `InsertOp` in `Next` | P2b | `streaming-edit.ts` insert-after branch |
| I3  | Ref adjustment soundness | `CompleteEdit` ref update (stubbed) | P3 | `ref-store.ts:97-143` `adjustRefsAfterEdit()` |
| I4  | Atomicity                | `Atomicity` invariant; `CrashDuringEdit` action | P4 | `streaming-edit.ts` temp-write + rename |
| I4a | Crash safety             | `CrashSafety` invariant: `tempFile = <<>>` when idle | P4 | `streaming-edit.ts` temp cleanup on error |
| I5  | Mtime guard              | `BeginEdit` mtime guard | P5 | `streaming-edit.ts` mtime check at entry |
| I6  | Edit correctness         | `EditCorrectness` invariant: `tempFile = ApplyOps(preEditContent, editOps, 1)` | P1, P2, P2a, P2b | `streaming-edit.ts` streaming loop construction |

## English Contracts

Each invariant is stated once in English. Both the TLA+ spec and the
property test reference this statement in comments.

- **I1:** If a checksum validates, the lines in the specified range are byte-identical to what was read.
- **I2:** Multiple edits in one call are applied in line-order; no edit shadows, overlaps, or shifts another.
- **I2a:** A delete removes exactly the specified lines. All other lines are preserved byte-identically.
- **I2b:** An insert-after adds new content without modifying or losing any existing lines.
- **I3:** After an edit, adjusted refs point to the same content they originally covered.
- **I4:** The file is either fully updated or untouched. No crash can leave a partial state.
- **I4a:** When idle, no temp file exists. Crash recovery always cleans up.
- **I5:** Edits are rejected when the file's mtime has changed since the read.
- **I6:** The temp file under construction is exactly what ApplyOps produces from pre-edit content and the recorded ops.

## Covered Functions

Changes to any of these functions should trigger review of formal
verification artifacts:

- `streamingEdit()` in `src/streaming-edit.ts`
- `adjustRefsAfterEdit()` in `src/ref-store.ts`
- `issueRef()` in `src/ref-store.ts`
- `resolveRef()` in `src/ref-store.ts`
- `fnv1aHash()` in `src/hash.ts`
- `foldHash()` in `src/hash.ts`

## Limitations

The conformance property test (`tests/formal/edit-protocol.property.test.ts`,
"Conformance" describe block) partially closes the model-implementation gap.
It implements the TLA+ `ApplyOps` operator in TypeScript and asserts
`streamingEdit()` produces byte-identical output for 500 random inputs
across all 6 op combinations. This is not a full refinement proof, but
provides high confidence that the implementation matches the model.

The TLA+ spec abstracts checksums as injective (the subsequence itself).
The real implementation uses FNV-1a, which has a non-zero collision
probability. This gap is accepted; it is not verifiable with bounded
model checking.

Ref adjustment (I3) is stubbed in the TLA+ spec (`refs' = refs` in
`CompleteEdit`). The real `adjustRefsAfterEdit()` logic is only covered
by P3 property tests, not by TLC. This is the largest remaining gap.

### What is NOT modeled

- 3+ ops per call (2-op covers the recursive case)
- File encoding (UTF-16, BOM, mixed line endings)
- Concurrent edits (single-threaded architecture)
- OS-level rename atomicity (POSIX guarantee)
- Node.js stream backpressure
- Ref LRU eviction

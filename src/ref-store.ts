// =============================================================================
// Ref store: short opaque tokens that replace checksums in the LLM-facing API.
//
// A ref like "R1" maps to { filePath, startLine, endLine, hash } internally.
// The LLM copies "R1" instead of "ne.1-im.157:d3b4c152" — trivial to copy,
// impossible to fabricate meaningfully (the server resolves it).
//
// Refs expire when the lines they cover change (detected at edit time via the
// same hash verification that checksums used), or via LRU eviction when the
// store exceeds MAX_REFS.
// =============================================================================

import type { ChecksumRef } from "./parse.ts";

export interface RefEntry {
  filePath: string;
  startLine: number;
  endLine: number;
  hash: string; // 8-char hex hash of the covered lines
}

const MAX_REFS = 500;
const store = new Map<string, RefEntry>();
let nextId = 1;

/**
 * Evict oldest refs (by insertion order) when the store exceeds MAX_REFS.
 */
function evictIfNeeded(): void {
  if (store.size <= MAX_REFS) return;
  const excess = store.size - MAX_REFS;
  let count = 0;
  for (const key of store.keys()) {
    if (count >= excess) break;
    store.delete(key);
    count++;
  }
}

/**
 * Issue a new ref for a file range. Returns the ref ID (e.g. "R1").
 */
export function issueRef(filePath: string, startLine: number, endLine: number, hash: string): string {
  const id = `R${nextId++}`;
  store.set(id, { filePath, startLine, endLine, hash });
  evictIfNeeded();
  return id;
}

/**
 * Resolve a ref ID to its entry. Throws if the ref doesn't exist.
 * Touches the entry for LRU ordering (moves to end of Map).
 */
export function resolveRef(ref: string): RefEntry {
  const entry = store.get(ref);
  if (!entry) {
    throw new Error(
      `Unknown ref "${ref}" — this ref was never issued or has expired. ` +
        "Use a ref from a recent trueline_read or trueline_search output.",
    );
  }
  // Move to end for LRU freshness
  store.delete(ref);
  store.set(ref, entry);
  return entry;
}

/**
 * Check whether a ref exists in the store.
 */
export function hasRef(refId: string): boolean {
  return store.has(refId);
}

/**
 * Convert a RefEntry to the internal ChecksumRef used by the streaming edit engine.
 */
export function refToChecksumRef(entry: RefEntry): ChecksumRef {
  return { startLine: entry.startLine, endLine: entry.endLine, hash: entry.hash };
}

export interface EditRegion {
  startLine: number;
  endLine: number;
  insertAfter: boolean;
  newLineCount: number;
}

/**
 * Adjust surviving refs after a successful edit. Refs overlapping edited
 * regions are deleted. Refs after edited regions have their line numbers
 * shifted by the cumulative delta. Refs before edited regions are unchanged.
 *
 * This preserves refs for untouched regions so the LLM doesn't need to
 * re-read distant parts of the file after a localized edit.
 */
export function adjustRefsAfterEdit(filePath: string, regions: EditRegion[]): void {
  const sorted = [...regions].sort((a, b) => a.startLine - b.startLine);

  for (const [id, entry] of store) {
    if (entry.filePath !== filePath) continue;

    let overlap = false;
    let shift = 0;

    for (const region of sorted) {
      if (region.insertAfter) {
        // Insert-after at anchor L: lines after L shift by newLineCount.
        // A ref spanning the anchor (startLine <= L < endLine) is invalidated
        // because new lines are injected inside the ref's range.
        const anchor = region.startLine;
        if (entry.startLine <= anchor && entry.endLine > anchor) {
          overlap = true;
          break;
        }
        if (entry.startLine > anchor) {
          shift += region.newLineCount;
        }
      } else {
        // Replace lines [editStart, editEnd] with newLineCount lines.
        const editStart = region.startLine;
        const editEnd = region.endLine;
        const oldCount = editEnd - editStart + 1;
        const delta = region.newLineCount - oldCount;

        if (entry.startLine <= editEnd && entry.endLine >= editStart) {
          overlap = true;
          break;
        }
        if (entry.startLine > editEnd) {
          shift += delta;
        }
      }
    }

    if (overlap) {
      store.delete(id);
    } else if (shift !== 0) {
      entry.startLine += shift;
      entry.endLine += shift;
    }
  }
}

/**
 * Remove all refs for a given file path.
 */
export function invalidateRefsForFile(filePath: string): void {
  for (const [id, entry] of store) {
    if (entry.filePath === filePath) {
      store.delete(id);
    }
  }
}

/** Reset the store (for testing). */
export function resetRefStore(): void {
  store.clear();
  nextId = 1;
}

/** Get the current store size (for testing/diagnostics). */
export function refStoreSize(): number {
  return store.size;
}

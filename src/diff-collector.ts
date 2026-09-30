// ==============================================================================
// DiffCollector — builds unified diff output incrementally during streaming.
//
// The streaming edit engine calls context() / delete() / insert() as it
// processes each line.  After streaming completes, format() produces a
// standard unified diff string without ever holding both file versions in
// memory.
// ==============================================================================

type DiffEntry = { type: "ctx" | "del" | "ins"; text: string };

// A replaced range arrives here as every original line deleted followed by
// every replacement line inserted: the streaming engine reports what it wrote
// and never holds both file versions in memory to compare them.  Unified diff
// as git and GNU diff produce it only marks lines that actually differ, since
// a shortest edit script never pays a delete plus an insert for a line it can
// match for free.  So each change block is realigned at format time instead of
// making every caller pre-diff its own edits.

// Above this many LCS table cells, fall back to prefix/suffix trimming alone.
// 250k cells is a 1 MB Int32Array; blocks that large are machine-generated
// rewrites where a minimal script buys little.
const MAX_ALIGN_CELLS = 250_000;

// Lines of unchanged context shown around each hunk in the unified diff.
const CONTEXT_LINES = 3;

const LINE_PREFIX: Record<DiffEntry["type"], string> = { ctx: " ", del: "-", ins: "+" };

const NO_FINAL_NEWLINE = "\n\\ No newline at end of file";

/** Rewrite every run of del/ins entries as a minimal edit script. */
function realign(entries: DiffEntry[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    if (entries[i].type === "ctx") {
      out.push(entries[i]);
      i++;
      continue;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < entries.length && entries[i].type !== "ctx") {
      (entries[i].type === "del" ? oldLines : newLines).push(entries[i].text);
      i++;
    }
    // push(...spread) passes every element as an argument and overflows the stack on huge blocks.
    for (const entry of alignBlock(oldLines, newLines)) out.push(entry);
  }
  return out;
}

/** Split into common prefix, common suffix, and the differing middle. */
export function trimCommonEnds(
  oldLines: string[],
  newLines: string[],
): { prefix: string[]; suffix: string[]; oldMid: string[]; newMid: string[] } {
  const shorter = Math.min(oldLines.length, newLines.length);

  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    prefix: oldLines.slice(0, prefix),
    suffix: oldLines.slice(oldLines.length - suffix),
    oldMid: oldLines.slice(prefix, oldLines.length - suffix),
    newMid: newLines.slice(prefix, newLines.length - suffix),
  };
}

/**
 * Minimal ctx/del/ins script for a change block's middle via LCS.
 * Returns null when oldMid × newMid would exceed maxCells; the caller
 * decides its own fallback for a block too large to align.
 */
export function lcsMiddle(oldMid: string[], newMid: string[], maxCells: number): DiffEntry[] | null {
  if (oldMid.length * newMid.length > maxCells) return null;
  return lcsScript(oldMid, newMid);
}

/** Diff one change block: common prefix and suffix as context, LCS for the middle. */
function alignBlock(oldLines: string[], newLines: string[]): DiffEntry[] {
  const { prefix, suffix, oldMid, newMid } = trimCommonEnds(oldLines, newLines);

  const middle =
    lcsMiddle(oldMid, newMid, MAX_ALIGN_CELLS) ??
    ([
      ...oldMid.map((text) => ({ type: "del", text }) as const),
      ...newMid.map((text) => ({ type: "ins", text }) as const),
    ] satisfies DiffEntry[]);

  return [
    ...prefix.map((text) => ({ type: "ctx", text }) as const),
    ...middle,
    ...suffix.map((text) => ({ type: "ctx", text }) as const),
  ];
}

/** Minimal del/ins script for two blocks, matching identical lines via LCS. */
function lcsScript(oldMid: string[], newMid: string[]): DiffEntry[] {
  const n = oldMid.length;
  const m = newMid.length;
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        oldMid[i] === newMid[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out: DiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      out.push({ type: "ctx", text: oldMid[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      // Ties go to the deletion so a changed line reads "-old" then "+new".
      out.push({ type: "del", text: oldMid[i] });
      i++;
    } else {
      out.push({ type: "ins", text: newMid[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: oldMid[i++] });
  while (j < m) out.push({ type: "ins", text: newMid[j++] });
  return out;
}

export class DiffCollector {
  private entries: DiffEntry[] = [];
  private oldLacksFinalNewline = false;
  private newLacksFinalNewline = false;

  context(text: string): void {
    this.entries.push({ type: "ctx", text });
  }

  delete(text: string): void {
    this.entries.push({ type: "del", text });
  }

  insert(text: string): void {
    this.entries.push({ type: "ins", text });
  }

  setMissingFinalNewline(oldSide: boolean, newSide: boolean): void {
    this.oldLacksFinalNewline = oldSide;
    this.newLacksFinalNewline = newSide;
  }

  /**
   * False when the deletions and insertions cancel out (a line deleted, then the same
   * text inserted back). Same answer as an empty format(), without the alignment work.
   */
  hasChanges(): boolean {
    const oldSide = this.entries.filter((e) => e.type !== "ins");
    const newSide = this.entries.filter((e) => e.type !== "del");
    return oldSide.length !== newSide.length || oldSide.some((e, i) => e.text !== newSide[i].text);
  }

  /**
   * Format collected entries as a unified diff string.
   * Returns an empty string when there are no changes.
   */
  format(oldPath: string, newPath: string): string {
    if (this.entries.length === 0) return "";

    // diff counts a line's newline as part of it: a last line without one carries
    // the marker, so it no longer matches the same text followed by a newline.
    const oldLast = this.entries.findLastIndex((e) => e.type !== "ins");
    const newLast = this.entries.findLastIndex((e) => e.type !== "del");
    const marked: DiffEntry[] = [];
    this.entries.forEach(({ type, text }, i) => {
      const oldText = i === oldLast && this.oldLacksFinalNewline ? `${text}${NO_FINAL_NEWLINE}` : text;
      const newText = i === newLast && this.newLacksFinalNewline ? `${text}${NO_FINAL_NEWLINE}` : text;
      if (type === "del") marked.push({ type, text: oldText });
      else if (type === "ins") marked.push({ type, text: newText });
      else if (oldText === newText) marked.push({ type, text: oldText });
      else marked.push({ type: "del", text: oldText }, { type: "ins", text: newText });
    });
    const entries = realign(marked);

    // Find indices of all change (non-context) entries
    const changeIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== "ctx") changeIndices.push(i);
    }
    if (changeIndices.length === 0) return "";

    // Group changes, merging when the context gap between groups ≤ 2*CONTEXT_LINES
    const groups: Array<[number, number]> = [];
    let gStart = changeIndices[0];
    let gEnd = changeIndices[0];

    for (let ci = 1; ci < changeIndices.length; ci++) {
      const gap = changeIndices[ci] - gEnd - 1;
      if (gap <= 2 * CONTEXT_LINES) {
        gEnd = changeIndices[ci];
      } else {
        groups.push([gStart, gEnd]);
        gStart = changeIndices[ci];
        gEnd = changeIndices[ci];
      }
    }
    groups.push([gStart, gEnd]);

    // Build hunks
    const parts: string[] = [`--- ${oldPath}`, `+++ ${newPath}`];

    for (const [gs, ge] of groups) {
      const hStart = Math.max(0, gs - CONTEXT_LINES);
      const hEnd = Math.min(entries.length - 1, ge + CONTEXT_LINES);

      // Compute 1-based line numbers at hStart by counting preceding entries
      let oldLine = 1;
      let newLine = 1;
      for (let i = 0; i < hStart; i++) {
        if (entries[i].type !== "ins") oldLine++;
        if (entries[i].type !== "del") newLine++;
      }

      let oldCount = 0;
      let newCount = 0;
      const lines: string[] = [];

      for (let i = hStart; i <= hEnd; i++) {
        const e = entries[i];
        lines.push(LINE_PREFIX[e.type] + e.text);
        if (e.type !== "ins") oldCount++;
        if (e.type !== "del") newCount++;
      }

      // An empty side is anchored at the line before the hunk, as GNU diff prints it (-0,0 for an empty file).
      const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
      const newStart = newCount === 0 ? newLine - 1 : newLine;
      const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
      const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
      parts.push(`@@ -${oldRange} +${newRange} @@`);
      for (const line of lines) parts.push(line);
    }

    return `${parts.join("\n")}\n`;
  }
}

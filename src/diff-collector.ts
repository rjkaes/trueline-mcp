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
    out.push(...alignBlock(oldLines, newLines));
  }
  return out;
}

/** Diff one change block: common prefix and suffix as context, LCS for the middle. */
function alignBlock(oldLines: string[], newLines: string[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const shorter = Math.min(oldLines.length, newLines.length);

  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) {
    out.push({ type: "ctx", text: oldLines[prefix] });
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  if (oldMid.length > 0 && newMid.length > 0 && oldMid.length * newMid.length <= MAX_ALIGN_CELLS) {
    out.push(...lcsScript(oldMid, newMid));
  } else {
    for (const text of oldMid) out.push({ type: "del", text });
    for (const text of newMid) out.push({ type: "ins", text });
  }

  for (let k = oldLines.length - suffix; k < oldLines.length; k++) {
    out.push({ type: "ctx", text: oldLines[k] });
  }
  return out;
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

  context(text: string): void {
    this.entries.push({ type: "ctx", text });
  }

  delete(text: string): void {
    this.entries.push({ type: "del", text });
  }

  insert(text: string): void {
    this.entries.push({ type: "ins", text });
  }

  /**
   * Format collected entries as a unified diff string.
   * Returns an empty string when there are no changes.
   */
  format(oldPath: string, newPath: string, contextLines = 3): string {
    if (this.entries.length === 0) return "";
    const entries = realign(this.entries);

    // Find indices of all change (non-context) entries
    const changeIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type !== "ctx") changeIndices.push(i);
    }
    if (changeIndices.length === 0) return "";

    // Group changes, merging when the context gap between groups ≤ 2*contextLines
    const groups: Array<[number, number]> = [];
    let gStart = changeIndices[0];
    let gEnd = changeIndices[0];

    for (let ci = 1; ci < changeIndices.length; ci++) {
      const gap = changeIndices[ci] - gEnd - 1;
      if (gap <= 2 * contextLines) {
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
      const hStart = Math.max(0, gs - contextLines);
      const hEnd = Math.min(entries.length - 1, ge + contextLines);

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
        switch (e.type) {
          case "ctx":
            lines.push(` ${e.text}`);
            oldCount++;
            newCount++;
            break;
          case "del":
            lines.push(`-${e.text}`);
            oldCount++;
            break;
          case "ins":
            lines.push(`+${e.text}`);
            newCount++;
            break;
        }
      }

      const oldRange = oldCount === 1 ? `${oldLine}` : `${oldLine},${oldCount}`;
      const newRange = newCount === 1 ? `${newLine}` : `${newLine},${newCount}`;
      parts.push(`@@ -${oldRange} +${newRange} @@`);
      parts.push(...lines);
    }

    return `${parts.join("\n")}\n`;
  }
}

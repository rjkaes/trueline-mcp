// handleEdit formats the diff after streamingEdit has already renamed the new
// file into place, so a throw here reports "Internal error" for an edit that
// landed.  Spreading a huge array into push() overflows the call stack (Node
// at ~200k entries, Bun at ~1M), which a large replace can reach.

import { describe, expect, test } from "bun:test";
import { DiffCollector } from "../src/diff-collector.ts";

describe("DiffCollector.format on very large diffs", () => {
  test("formats one huge replaced block (realign path)", () => {
    const linesPerSide = 600_000;
    const collector = new DiffCollector();
    for (let i = 0; i < linesPerSide; i++) collector.delete("removed line");
    for (let i = 0; i < linesPerSide; i++) collector.insert("added line");

    const diff = collector.format("a/generated.ts", "b/generated.ts");

    expect(
      diff.startsWith(`--- a/generated.ts\n+++ b/generated.ts\n@@ -1,${linesPerSide} +1,${linesPerSide} @@\n`),
    ).toBe(true);
    expect(diff.endsWith("+added line\n")).toBe(true);
  });

  test("formats one huge hunk of small change blocks (hunk path)", () => {
    const groups = 400_000;
    const collector = new DiffCollector();
    for (let i = 0; i < groups; i++) {
      collector.delete("removed line");
      collector.insert("added line");
      collector.context("kept line");
    }

    const diff = collector.format("a/generated.ts", "b/generated.ts");

    expect(diff.startsWith(`--- a/generated.ts\n+++ b/generated.ts\n@@ -1,${groups * 2} +1,${groups * 2} @@\n`)).toBe(
      true,
    );
    expect(diff.endsWith(" kept line\n")).toBe(true);
  });
});

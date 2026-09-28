/**
 * AST outline extraction.
 *
 * Given source code and a language config, produces a compact outline
 * of the file's structure — declarations, classes, functions, etc.
 */
import type { LanguageConfig } from "./languages.ts";
import { createParser } from "./parser.ts";

/** Minimal interface for tree-sitter SyntaxNode (web-tree-sitter 0.24.x lacks proper types). */
interface SyntaxNode {
  type: string;
  isNamed: boolean;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  childCount: number;
}

export interface OutlineEntry {
  /** 1-based start line */
  startLine: number;
  /** 1-based end line */
  endLine: number;
  /** Indentation depth (0 = top-level, 1 = class member, etc.) */
  depth: number;
  /** The AST node type (e.g. "function_declaration") */
  nodeType: string;
  /** First line of source for this node, trimmed */
  text: string;
}

/** Extract outline entries from source code. */
export async function extractOutline(
  source: string,
  config: LanguageConfig,
  maxDepth = Infinity,
): Promise<OutlineEntry[]> {
  const parser = await createParser(config.grammar);
  const tree = parser.parse(source);
  const lines = source.split("\n");
  const entries: OutlineEntry[] = [];

  /**
   * Extract a compact signature for the node.
   *
   * For single-line declarations, returns the trimmed first line (current behavior).
   * For multi-line declarations (e.g. functions with wrapped parameters), reconstructs
   * the signature by joining lines up through the closing paren and return type,
   * collapsing whitespace into single spaces. Truncates at 200 chars.
   */
  function extractSignature(node: SyntaxNode): string {
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;
    const fl = lines[startRow]?.trimEnd() ?? "";

    // Single-line or short node — return as-is (preserving current behavior)
    if (startRow === endRow || fl.includes("{")) {
      return fl.length > 200 ? `${fl.slice(0, 197)}...` : fl;
    }

    // Multi-line: join lines from startRow until we find the opening brace or
    // reach the end of the node, whichever comes first.
    const parts: string[] = [fl.trimEnd()];
    for (let row = startRow + 1; row <= Math.min(endRow, startRow + 20); row++) {
      const line = (lines[row] ?? "").trimEnd();
      parts.push(line.trim());
      if (line.includes("{")) break;
    }

    // Join and collapse internal whitespace, clean up signature formatting
    let sig = parts
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/,\s*\)/g, ")")
      .replace(/\s*\{\s*$/, "");
    if (sig.length > 200) sig = `${sig.slice(0, 197)}...`;
    return sig;
  }

  // Track skipped nodes to emit a collapsed summary
  let skipStart = -1;
  let skipEnd = -1;
  let skipCount = 0;
  let skipType = "";

  function flushSkipped(): void {
    if (skipCount === 0) return;
    const label = skipCount === 1 ? `1 ${skipType}` : `${skipCount} ${skipType}s`;
    entries.push({
      startLine: skipStart,
      endLine: skipEnd,
      depth: 0,
      nodeType: "_skipped",
      text: `(${label})`,
    });
    skipStart = -1;
    skipEnd = -1;
    skipCount = 0;
    skipType = "";
  }

  function trackSkipped(node: SyntaxNode): void {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    // Infer a human-readable label from the node type
    const label = node.type
      .replace(/_/g, " ")
      .replace(/ statement$/, "")
      .replace(/ declaration$/, "");

    if (skipCount === 0 || label === skipType) {
      // Start or extend the current skip group
      if (skipCount === 0) {
        skipStart = nodeStart;
        skipType = label;
      }
      skipEnd = nodeEnd;
      skipCount++;
    } else {
      // Different skip type — flush and start new group
      flushSkipped();
      skipStart = nodeStart;
      skipEnd = nodeEnd;
      skipCount = 1;
      skipType = label;
    }
  }

  function visit(node: SyntaxNode, depth: number, isRootChild: boolean): void {
    // Track skipped root children for collapsed summary
    if (isRootChild && config.skip?.has(node.type)) {
      trackSkipped(node);
      return;
    }
    if (config.skip?.has(node.type)) return;

    const isOutline = config.outline.has(node.type);
    const isTopOnly = config.topLevelOnly?.has(node.type) ?? false;

    // topLevelOnly nodes are only captured as direct children of root
    if (isTopOnly && !isRootChild) return;

    if (isOutline || (isTopOnly && isRootChild)) {
      // Flush any pending skipped nodes before this entry
      if (isRootChild) flushSkipped();

      entries.push({
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        depth,
        nodeType: node.type,
        text: extractSignature(node),
      });

      // For recurse types (e.g. class_body), visit their children
      // to extract members at depth+1
      if (depth + 1 <= maxDepth) {
        for (const child of node.children) {
          if (!child.isNamed) continue;
          if (config.recurse?.has(child.type)) {
            for (const member of child.children) {
              if (!member.isNamed) continue;
              visit(member, depth + 1, false);
            }
          }
        }
      }
      return;
    }
  }

  for (const child of tree.rootNode.children) {
    visit(child, 0, true);
  }
  flushSkipped();

  return entries;
}

/** Format outline entries as a compact string. */
export function formatOutline(entries: OutlineEntry[], totalLines: number): string {
  const parts: string[] = [];

  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    parts.push(`${indent}${entry.startLine}-${entry.endLine}: ${entry.text}`);
  }

  parts.push("");
  parts.push(`(${entries.length} symbols, ${totalLines} source lines)`);

  return parts.join("\n");
}

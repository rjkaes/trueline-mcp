/**
 * AST outline extraction.
 *
 * Given source code and a language config, produces a compact outline
 * of the file's structure — declarations, classes, functions, etc.
 */
import type { LanguageConfig } from "./languages.ts";
import { createParser } from "./parser.ts";
import type { Node as SyntaxNode } from "web-tree-sitter";

// web-tree-sitter 0.25 types child slots as nullable.
const childrenOf = (node: SyntaxNode): SyntaxNode[] => node.children.filter((c): c is SyntaxNode => c !== null);

// A `{` inside a string literal is not a body brace: `@GetMapping("/orders/{id}")`.
const hasBodyBrace = (line: string): boolean => line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "").includes("{");

/** The node holding a declaration's body, looking through export, decorator and `const f = ...` wrappers. */
function findBody(node: SyntaxNode): SyntaxNode | undefined {
  let target: SyntaxNode | null = node;
  while (target) {
    const body = target.childForFieldName("body") ?? childrenOf(target).find((c) => c.type === "do_block");
    if (body) return body;
    target =
      target.childForFieldName("definition") ?? // Python decorated_definition
      target.childForFieldName("declaration") ??
      target.childForFieldName("value") ??
      childrenOf(target).find((c) => c.type === "variable_declarator") ??
      // C++ template_declaration: the declaration follows the parameter list, unlabelled.
      (target.type === "template_declaration"
        ? childrenOf(target).find((c) => c.isNamed && !["template_parameter_list", "requires_clause"].includes(c.type))
        : undefined) ??
      null;
  }
  return undefined;
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
  /** Signature up to the body node, untruncated and without comments. Absent when the node has no body node. */
  head?: string;
  /** Where the body node starts (1-based line, 0-based column). Absent when the node has no body node. */
  bodyStart?: { line: number; column: number };
}

/** Extract outline entries from source code. */
export async function extractOutline(
  source: string,
  config: LanguageConfig,
  maxDepth = Infinity,
): Promise<OutlineEntry[]> {
  const parser = await createParser(config.grammar);
  const tree = parser.parse(source);
  // web-tree-sitter 0.24 has no finalizers: parsers and trees stay in the
  // WASM heap until deleted, and a full heap aborts every later parse.
  // A tree does not reference its parser, so the parser can go now.
  parser.delete();
  if (!tree) throw new Error(`tree-sitter returned no tree for ${config.grammar}`);
  const lines = source.split("\n");
  const entries: OutlineEntry[] = [];

  /** 1-based last line of a node. Kotlin's import_list ends at column 0 of the next line, past trailing blank lines. */
  function lastLine(node: SyntaxNode): number {
    let row = node.endPosition.row;
    if (node.endPosition.column === 0 && row > node.startPosition.row) {
      row--;
      while (row > node.startPosition.row && !lines[row]?.trim()) row--;
    }
    return row + 1;
  }

  /** Dart signatures end before their body, a `function_body` sibling of the signature or of its `method_signature` wrapper. */
  function trailingBody(node: SyntaxNode): SyntaxNode | undefined {
    const next = node.nextSibling ?? node.parent?.nextSibling;
    return next?.type === "function_body" ? next : undefined;
  }

  /**
   * Extract a compact signature for the node.
   *
   * For single-line declarations, returns the trimmed first line (current behavior).
   * For multi-line declarations (e.g. functions with wrapped parameters), reconstructs
   * the signature by joining lines up through the closing paren and return type,
   * collapsing whitespace into single spaces. Truncates at 200 chars.
   */
  function extractSignature(node: SyntaxNode): Pick<OutlineEntry, "text" | "head" | "bodyStart"> {
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;
    const firstLine = lines[startRow] ?? "";
    const fl = firstLine.trim();

    const body = findBody(node);
    const bodyStart = body && { line: body.startPosition.row + 1, column: body.startPosition.column };
    // Without a body node, a brace on the first line is taken as the body's.
    const bodyOnFirstLine = body ? body.startPosition.row === startRow : hasBodyBrace(fl);

    // Join and collapse internal whitespace, clean up signature formatting
    const collapse = (parts: string[]): string =>
      parts
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/,\s*\)/g, ")")
        .replace(/\s*\{\s*$/, "");

    // Single-line or short node — return as-is (preserving current behavior)
    if (startRow === endRow || bodyOnFirstLine) {
      const text = fl.length > 200 ? `${fl.slice(0, 197)}...` : fl;
      // From the node's own column: a member can share its line with the class.
      const head = body && collapse([firstLine.slice(node.startPosition.column, body.startPosition.column)]).trim();
      return { text, head, bodyStart };
    }

    // Multi-line: join lines from startRow until we find the opening brace or
    // reach the end of the node, whichever comes first. A body also ends the join:
    // Python and Ruby have no brace, and their body starts on the line after the
    // signature. Elixir's `do` block starts on the signature's last line.
    let lastRow = Math.min(endRow, startRow + 20);
    // The head is not capped at 20 rows: a wrapped signature is compared whole.
    let headLast: number | undefined;
    if (body) {
      const bodyRow = body.startPosition.row;
      const sharesRow = (lines[bodyRow] ?? "").slice(0, body.startPosition.column).trim() !== "";
      headLast = sharesRow ? bodyRow : bodyRow - 1;
      lastRow = Math.min(lastRow, headLast);
    } else {
      // Neither Ruby's closing `end` nor the specs of Go's grouped `type ( ... )` belong to the signature.
      const closer = node.lastChild;
      if (
        closer?.type === "end" &&
        (lines[closer.startPosition.row] ?? "").slice(0, closer.startPosition.column).trim() === ""
      ) {
        lastRow = Math.min(lastRow, closer.startPosition.row - 1);
      }
      const groupOpen = closer?.type === ")" ? childrenOf(node).find((c) => c.type === "(") : undefined;
      if (groupOpen) lastRow = Math.min(lastRow, groupOpen.startPosition.row);
    }
    const commentsUntil = Math.max(lastRow, headLast ?? 0);
    // A comment in the signature would make editing it read as a signature change.
    const comments: SyntaxNode[] = [];
    const collectComments = (parent: SyntaxNode): void => {
      for (const child of childrenOf(parent)) {
        if (child.startPosition.row > commentsUntil) break;
        if (child.type.includes("comment")) comments.push(child);
        else collectComments(child);
      }
    };
    collectComments(node);
    // Past a body-less signature's last line, a trailing comment is a sibling, not a child.
    for (let next = node.nextSibling; next && next.startPosition.row === endRow; next = next.nextSibling) {
      if (next.type.includes("comment")) comments.push(next);
    }
    const codeOnRow = (row: number, end?: number): string => {
      let line = (lines[row] ?? "").slice(0, end);
      // Right to left, so earlier columns stay valid.
      for (const comment of [...comments].reverse()) {
        if (comment.startPosition.row > row || comment.endPosition.row < row) continue;
        const from = comment.startPosition.row === row ? comment.startPosition.column : 0;
        const to = comment.endPosition.row === row ? comment.endPosition.column : line.length;
        line = line.slice(0, from) + line.slice(to);
      }
      return line.trimEnd();
    };
    const parts: string[] = [codeOnRow(startRow)];
    for (let row = startRow + 1; row <= lastRow; row++) {
      const line = codeOnRow(row);
      parts.push(line.trim());
      if (!body && hasBodyBrace(line)) break;
    }

    let head: string | undefined;
    if (body && headLast !== undefined) {
      const headParts: string[] = [];
      for (let row = startRow; row <= headLast; row++) {
        const line = codeOnRow(row, row === body.startPosition.row ? body.startPosition.column : undefined);
        headParts.push(row === startRow ? line.slice(node.startPosition.column) : line.trim());
      }
      head = collapse(headParts).trim();
    }

    let sig = collapse(parts).trim();
    if (sig.length > 200) sig = `${sig.slice(0, 197)}...`;
    return { text: sig, head, bodyStart };
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
    const nodeEnd = lastLine(node);
    // Infer a human-readable label from the node type
    const label = node.type
      .replace(/_/g, " ")
      .replace(/ statement$/, "")
      .replace(/ declaration$/, "");

    if (skipCount > 0 && label !== skipType) flushSkipped();
    if (skipCount === 0) {
      skipStart = nodeStart;
      skipType = label;
    }
    skipEnd = nodeEnd;
    skipCount++;
  }

  function visit(node: SyntaxNode, depth: number, isRootChild: boolean): void {
    // Track skipped root children for collapsed summary
    if (isRootChild && config.skip?.has(node.type)) {
      trackSkipped(node);
      return;
    }
    if (config.skip?.has(node.type)) return;

    if (config.transparent?.has(node.type)) {
      for (const child of childrenOf(node)) {
        if (child.isNamed) visit(child, depth, isRootChild);
      }
      return;
    }

    if (config.outline.has(node.type) && (config.include?.(node) ?? true)) {
      // Flush any pending skipped nodes before this entry
      if (isRootChild) flushSkipped();

      entries.push({
        startLine: node.startPosition.row + 1,
        endLine: lastLine(trailingBody(node) ?? node),
        depth,
        nodeType: node.type,
        ...extractSignature(node),
      });

      // For recurse types (e.g. class_body), visit their children to extract
      // members at depth+1. Wrapper nodes (TS/JS `export_statement`, Python
      // `decorated_definition`) hold the real declaration one level deeper than
      // the outline node itself, so a recurse target may be a grandchild.
      if (depth + 1 <= maxDepth) {
        for (const child of childrenOf(node)) {
          if (!child.isNamed) continue;
          const recurseTargets = config.recurse?.has(child.type)
            ? [child]
            : childrenOf(child).filter((c) => c.isNamed && config.recurse?.has(c.type));
          for (const target of recurseTargets) {
            if (config.canRecurse && target.parent && !config.canRecurse(target.parent)) continue;
            for (const member of childrenOf(target)) {
              if (!member.isNamed) continue;
              visit(member, depth + 1, false);
            }
          }
        }
      }
      return;
    }
  }

  try {
    for (const child of childrenOf(tree.rootNode)) {
      visit(child, 0, true);
    }
  } finally {
    tree.delete();
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

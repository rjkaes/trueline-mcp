import { getLanguageConfig } from "./outline/languages.ts";
import { extractOutline } from "./outline/extract.ts";
import { fnv1aHash, foldHash, FNV_OFFSET_BASIS } from "./hash.ts";

// ==============================================================================
// Types
// ==============================================================================

export interface SymbolInfo {
  name: string;
  signature: string;
  bodyHash: number;
  nodeType: string;
  /** Full body text for inline mini-diffs of small changes */
  bodyText?: string;
}

export interface SymbolDiff {
  added: SymbolInfo[];
  removed: SymbolInfo[];
  renamed: Array<{ oldName: string; newName: string; signature: string }>;
  signatureChanged: Array<{ name: string; oldSig: string; newSig: string }>;
  logicChanged: Array<{ name: string; signature: string; oldBody?: string; newBody?: string }>;
}

// ==============================================================================
// Whitespace Normalization
// ==============================================================================

export function normalizeBody(text: string, mode: "collapse" | "preserve-indent" = "collapse"): string {
  const lines = text.split("\n");
  if (mode === "preserve-indent") {
    return lines.map((l) => l.replace(/\s+$/, "").replace(/(\S)\s{2,}(\S)/g, "$1 $2")).join("\n");
  }
  // collapse mode
  return lines.map((l) => l.trim().replace(/\s+/g, " ")).join("\n");
}

// ==============================================================================
// Symbol Extraction
// ==============================================================================

/** Hash a normalized body string using FNV-1a with folding. */
function hashBody(text: string): number {
  let acc = FNV_OFFSET_BASIS;
  for (const line of text.split("\n")) {
    acc = foldHash(acc, fnv1aHash(line));
  }
  return acc;
}

/**
 * Extract symbols from source code for a given file extension.
 * Returns [] for unsupported extensions.
 */
export async function extractSymbols(source: string, ext: string): Promise<SymbolInfo[]> {
  const config = getLanguageConfig(ext.startsWith(".") ? ext : `.${ext}`);
  if (!config) return [];

  const entries = await extractOutline(source, config);
  const lines = source.split("\n");
  const wsMode = config.whitespaceMode ?? "collapse";

  return entries
    .filter((e) => e.nodeType !== "_skipped")
    .map((entry) => {
      const bodyLines = lines.slice(entry.startLine - 1, entry.endLine);
      const bodyText = bodyLines.join("\n");
      // Hash body excluding the signature line so renames don't change the hash.
      // For single-line nodes, innerBody is empty; rename detection won't apply.
      const innerLines = bodyLines.length > 1 ? bodyLines.slice(1) : bodyLines;
      const normalized = normalizeBody(innerLines.join("\n"), wsMode);
      const name = extractName(entry.text, entry.nodeType);

      return {
        name,
        signature: entry.text,
        bodyHash: hashBody(normalized),
        nodeType: entry.nodeType,
        bodyText,
      };
    });
}

/** Extract a human-readable name from a signature line. */
function extractName(sig: string, _nodeType: string): string {
  const match = sig.match(
    /(?:function|class|interface|type|enum|const|let|var|def|fn|func|fun|pub\s+fn|async\s+function)\s+(\w+)/,
  );
  if (match) return match[1];
  // Method-like: name(
  const methodMatch = sig.match(/^\s*(?:(?:public|private|protected|static|async|export|abstract)\s+)*(\w+)\s*[(<]/);
  if (methodMatch) return methodMatch[1];
  // Fallback: first word-like token
  const fallback = sig.match(/(\w+)/);
  return fallback ? fallback[1] : sig.slice(0, 40);
}

// ==============================================================================
// Symbol Diffing
// ==============================================================================

export function diffSymbols(oldSyms: SymbolInfo[], newSyms: SymbolInfo[]): SymbolDiff {
  const result: SymbolDiff = {
    added: [],
    removed: [],
    renamed: [],
    signatureChanged: [],
    logicChanged: [],
  };

  const oldByName = new Map(oldSyms.map((s) => [s.name, s]));
  const newByName = new Map(newSyms.map((s) => [s.name, s]));

  const matched: Array<{ old: SymbolInfo; new: SymbolInfo }> = [];
  const unmatchedOld: SymbolInfo[] = [];
  const unmatchedNew: SymbolInfo[] = [];

  for (const old of oldSyms) {
    const n = newByName.get(old.name);
    if (n) {
      matched.push({ old, new: n });
    } else {
      unmatchedOld.push(old);
    }
  }

  for (const n of newSyms) {
    if (!oldByName.has(n.name)) {
      unmatchedNew.push(n);
    }
  }

  // Rename detection: unmatched old + unmatched new with same body hash
  const oldByHash = new Map<number, SymbolInfo[]>();
  for (const o of unmatchedOld) {
    const list = oldByHash.get(o.bodyHash) ?? [];
    list.push(o);
    oldByHash.set(o.bodyHash, list);
  }

  const renamedOldNames = new Set<string>();
  const renamedNewNames = new Set<string>();

  for (const n of unmatchedNew) {
    const candidates = oldByHash.get(n.bodyHash);
    if (candidates && candidates.length > 0) {
      const o = candidates.shift()!;
      result.renamed.push({ oldName: o.name, newName: n.name, signature: n.signature });
      renamedOldNames.add(o.name);
      renamedNewNames.add(n.name);
    }
  }

  for (const o of unmatchedOld) {
    if (!renamedOldNames.has(o.name)) result.removed.push(o);
  }
  for (const n of unmatchedNew) {
    if (!renamedNewNames.has(n.name)) result.added.push(n);
  }

  // Categorize matched symbols
  for (const { old: o, new: n } of matched) {
    if (o.signature !== n.signature && o.bodyHash !== n.bodyHash) {
      result.signatureChanged.push({ name: o.name, oldSig: o.signature, newSig: n.signature });
      result.logicChanged.push({ name: o.name, signature: n.signature, oldBody: o.bodyText, newBody: n.bodyText });
    } else if (o.signature !== n.signature) {
      result.signatureChanged.push({ name: o.name, oldSig: o.signature, newSig: n.signature });
    } else if (o.bodyHash !== n.bodyHash) {
      result.logicChanged.push({ name: o.name, signature: n.signature, oldBody: o.bodyText, newBody: n.bodyText });
    }
  }

  return result;
}

import { getLanguageConfig } from "./outline/languages.ts";
import { extractOutline } from "./outline/extract.ts";
import { fnv1aHash } from "./hash.ts";

// ==============================================================================
// Types
// ==============================================================================

interface SymbolInfo {
  name: string;
  signature: string;
  bodyHash: number;
  /** Full body text for inline mini-diffs of small changes */
  bodyText?: string;
}

export interface SymbolDiff {
  added: SymbolInfo[];
  removed: SymbolInfo[];
  renamed: Array<{ oldName: string; newName: string }>;
  signatureChanged: Array<{ name: string; oldSig: string; newSig: string }>;
  logicChanged: Array<{ name: string; oldBody?: string; newBody?: string }>;
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

/**
 * Extract symbols from source code for a given file extension.
 * Returns [] for unsupported extensions.
 */
export async function extractSymbols(source: string, ext: string): Promise<SymbolInfo[]> {
  const config = getLanguageConfig(ext);
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
      const name = extractName(entry.text);

      return {
        name,
        signature: entry.text,
        bodyHash: fnv1aHash(normalized),
        bodyText,
      };
    });
}

/** Extract a human-readable name from a signature line. */
function extractName(sig: string): string {
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

  const unmatchedOld: SymbolInfo[] = [];
  const unmatchedNew: SymbolInfo[] = [];

  for (const o of oldSyms) {
    const n = newByName.get(o.name);
    if (!n) {
      unmatchedOld.push(o);
      continue;
    }
    // Categorize matched symbols
    if (o.signature !== n.signature) {
      result.signatureChanged.push({ name: o.name, oldSig: o.signature, newSig: n.signature });
    }
    if (o.bodyHash !== n.bodyHash) {
      result.logicChanged.push({ name: o.name, oldBody: o.bodyText, newBody: n.bodyText });
    }
  }

  for (const n of newSyms) {
    if (!oldByName.has(n.name)) {
      unmatchedNew.push(n);
    }
  }

  // Rename detection: unmatched old + unmatched new with same body hash
  const oldByHash = Map.groupBy(unmatchedOld, (o) => o.bodyHash);
  // By identity, not name: names collide across class scopes and overloads.
  const renamedOld = new Set<SymbolInfo>();

  for (const n of unmatchedNew) {
    const o = oldByHash.get(n.bodyHash)?.shift();
    if (o) {
      result.renamed.push({ oldName: o.name, newName: n.name });
      renamedOld.add(o);
    } else {
      result.added.push(n);
    }
  }

  for (const o of unmatchedOld) {
    if (!renamedOld.has(o)) result.removed.push(o);
  }

  return result;
}

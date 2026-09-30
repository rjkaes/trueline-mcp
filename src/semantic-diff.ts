import { getLanguageConfig } from "./outline/languages.ts";
import { extractOutline } from "./outline/extract.ts";
import { fnv1aHash } from "./hash.ts";

// ==============================================================================
// Types
// ==============================================================================

interface SymbolInfo {
  name: string;
  /** Enclosing symbol names, dot-joined: same-named members of different classes stay distinct */
  scope?: string;
  signature: string;
  /** Hash of the untruncated first line; `signature` is cut at 200 chars */
  headHash?: number;
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
  // Blank lines carry no meaning: adding one must not read as a logic change.
  if (mode === "preserve-indent") {
    return lines
      .map((l) => l.replace(/\s+$/, "").replace(/(\S)\s{2,}(\S)/g, "$1 $2"))
      .filter(Boolean)
      .join("\n");
  }
  // collapse mode
  return lines
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
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

  // Entries arrive in document order, so `depth` indexes the chain of enclosing symbols.
  const parents: string[] = [];

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
      parents.length = entry.depth;
      const scope = parents.join(".");
      parents.push(name);

      return {
        name,
        scope,
        signature: entry.text,
        headHash: fnv1aHash(normalizeBody(lines[entry.startLine - 1])),
        bodyHash: fnv1aHash(normalized),
        bodyText,
      };
    });
}

/** Extract a human-readable name from a signature line. */
function extractName(sig: string): string {
  // Go method: qualify by receiver type so `A.Run` and `B.Run` stay distinct.
  const goMethod = sig.match(/^\s*func\s*\((?:[^)]*[\s*])?(\w+)(?:\[[^\]]*\])?\)\s*(\w+)/);
  if (goMethod) return `${goMethod[1]}.${goMethod[2]}`;
  // Rust impl: keep the whole target so `impl Foo` and `impl Show for Foo` differ.
  const impl = sig.match(/^\s*(?:unsafe\s+)?impl(?=[\s<])\s*(.+?)\s*(?:\{|\bwhere\b|$)/);
  if (impl) return `impl ${impl[1]}`;
  const match = sig.match(
    /\b(?:function|class|interface|type|enum|struct|trait|mod|namespace|object|protocol|extension|module|const|let|var|val|def|defp|defmacro|defmacrop|defmodule|defprotocol|defimpl|fn|func|fun|pub\s+fn|async\s+function)\s+(\w+)/,
  );
  if (match) return match[1];
  const bare = sig.replace(/@\w+(?:\([^)]*\))?\s*/g, "");
  // Method-like: the identifier before the first `(`, past modifiers and return types.
  const methodMatch = bare.match(/([\w$:~]+)\s*(?:<[^>]*>)?\s*\(/);
  // A `=` before the name makes it a call in an initializer (`items = new ArrayList<>()`): a field.
  if (methodMatch && !bare.slice(0, methodMatch.index).includes("=")) return methodMatch[1];
  // Field or property: the last identifier before its initializer, type annotation, or accessor block.
  // Modifiers (`private`, `public static`) come first, so they are never the last word.
  const field = bare.split(/[=;:{]/, 1)[0].match(/([\w$]+)\s*(?:\[[^\]]*\]\s*)*$/);
  if (field) return field[1];
  // Fallback: first word-like token
  const fallback = bare.match(/(\w+)/);
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

  const identity = (s: SymbolInfo) => (s.scope ? `${s.scope}.${s.name}` : s.name);
  const sameSignature = (a: SymbolInfo, b: SymbolInfo) =>
    a.headHash === b.headHash && normalizeBody(a.signature) === normalizeBody(b.signature);

  const pairs = new Map<SymbolInfo, SymbolInfo>();
  const paired = new Set<SymbolInfo>();
  const pairBy = (key: (s: SymbolInfo) => string, eligible: (s: SymbolInfo) => boolean) => {
    const candidates = Map.groupBy(newSyms.filter(eligible), key);
    for (const exact of [true, false]) {
      for (const o of oldSyms) {
        if (pairs.has(o) || !eligible(o)) continue;
        const n = candidates.get(key(o))?.find((c) => !paired.has(c) && (!exact || sameSignature(o, c)));
        if (!n) continue;
        pairs.set(o, n);
        paired.add(n);
      }
    }
  };
  // Same-named symbols (overloads, get/set pairs) pair by identical signature first, then in order.
  pairBy(identity, () => true);
  // Renaming a container (`class Foo` -> `Bar`, `impl Foo` -> `impl<T> Foo<T>`) changes every member's scope, so
  // members of a container with no counterpart pair by name alone. Members of surviving containers do not:
  // a method moved between two classes stays reported.
  const pairedIdentities = new Set([...pairs.keys()].map(identity));
  pairBy(
    (s) => s.name,
    (s) => !!s.scope && !pairedIdentities.has(s.scope),
  );

  const unmatchedOld: SymbolInfo[] = [];
  for (const o of oldSyms) {
    const n = pairs.get(o);
    if (!n) {
      unmatchedOld.push(o);
      continue;
    }
    // Categorize matched symbols
    if (!sameSignature(o, n)) {
      result.signatureChanged.push({ name: identity(o), oldSig: o.signature, newSig: n.signature });
    }
    if (o.bodyHash !== n.bodyHash) {
      result.logicChanged.push({ name: identity(o), oldBody: o.bodyText, newBody: n.bodyText });
    }
  }
  const unmatchedNew = newSyms.filter((n) => !paired.has(n));

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

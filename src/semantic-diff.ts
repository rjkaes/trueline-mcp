import { getLanguageConfig } from "./outline/languages.ts";
import { extractOutline } from "./outline/extract.ts";
import type { OutlineEntry } from "./outline/extract.ts";
import { fnv1aHash } from "./hash.ts";

/** Bodyless nodes and empty `{}` bodies all hash alike: nothing to pair a rename on, nothing to read as logic. */
const EMPTY_BODY_HASH = fnv1aHash("");

// ==============================================================================
// Types
// ==============================================================================

interface SymbolInfo {
  name: string;
  /** Enclosing symbol names, dot-joined: same-named members of different classes stay distinct */
  scope?: string;
  signature: string;
  /** Signature up to the body, untruncated; `signature` is cut at 200 chars */
  head?: string;
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
      .map((l) => l.replace(/\s+$/, "").replace(/(?<=\S)\s{2,}(?=\S)/g, " "))
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
 * Guess where a node's signature ends, for nodes the outline found no body node for: at the first `{`
 * outside parentheses, else where the parentheses close (a wrapped C prototype or Kotlin signature). A `{`
 * inside open parentheses is a block argument, as in `describe("x", () => {`: the first line is the
 * signature and the rest is the body. A one-line decorator or attribute (a line starting with `@` or `[`)
 * continues the signature.
 */
function splitSignature(text: string): { head: string; body: string } {
  const lines = text.split("\n");
  const cutAfter = (row: number) => ({
    head: lines.slice(0, row + 1).join("\n"),
    body: lines.slice(row + 1).join("\n"),
  });
  let depth = 0;
  for (const [row, line] of lines.entries()) {
    for (let col = 0; col < line.length; col++) {
      if (line[col] === "(") depth++;
      else if (line[col] === ")") depth--;
      else if (line[col] === "{") {
        if (depth > 0) return cutAfter(0);
        return {
          head: [...lines.slice(0, row), line.slice(0, col)].join("\n"),
          body: [line.slice(col + 1), ...lines.slice(row + 1)].join("\n"),
        };
      }
    }
    if (depth <= 0 && !/^\s*[@[]/.test(line)) return cutAfter(row);
  }
  return { head: text, body: "" };
}

/** Signature and body of an entry: split at the body node when the outline has one, else guessed from the text. */
function splitEntry(entry: OutlineEntry, lines: string[]): { head: string; body: string } {
  const { head, bodyStart } = entry;
  if (head === undefined || bodyStart === undefined) {
    return splitSignature(lines.slice(entry.startLine - 1, entry.endLine).join("\n"));
  }
  const firstRow = (lines[bodyStart.line - 1] ?? "").slice(bodyStart.column);
  return { head, body: [firstRow, ...lines.slice(bodyStart.line, entry.endLine)].join("\n") };
}

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
  const constIsModifier = CONST_IS_MODIFIER.has(config.grammar);

  // Entries arrive in document order, so `depth` indexes the chain of enclosing symbols.
  const parents: string[] = [];

  return entries
    .filter((e) => e.nodeType !== "_skipped")
    .map((entry) => {
      const bodyText = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
      const { head, body } = splitEntry(entry, lines);
      // Hash the body past the signature so renames don't change the hash. A node with no body, or an
      // empty one (`{}`), hashes as empty: rename detection skips it, and a signature edit is not logic.
      const normalized = /[^\s{}]/.test(body) ? normalizeBody(body, wsMode) : "";
      // The entry's text is cut at 200 chars, which a long decorator can push the name past.
      const nameSource = entry.head ?? entry.text;
      const name = extractName(constIsModifier ? nameSource.replace(/\bconst\b/g, "") : nameSource);
      parents.length = entry.depth;
      const scope = parents.join(".");
      parents.push(name);

      return {
        name,
        scope,
        signature: entry.text,
        head,
        bodyHash: fnv1aHash(normalized),
        bodyText,
      };
    });
}

// `const` qualifies a type in C and C++ (`const char *f()`): the word after it is never the name.
const CONST_IS_MODIFIER = new Set(["c", "cpp"]);

// Declaration keywords stack (`enum class`, `pub const fn`, `class func`): the name follows the last.
// Ruby's `def self.find` is named `find`; Kotlin allows backticked names with spaces.
const DECLARED_NAME =
  /\b(?:(?:function|class|interface|type|enum|struct|trait|mod|namespace|object|protocol|extension|module|const|let|var|val|def|defp|defmacro|defmacrop|defmodule|defprotocol|defimpl|fn|func|fun|pub\s+fn|async\s+function)\s+)+(?:self\.)?(\w+|`[^`]+`)/g;

/** Extract a human-readable name from a signature line. */
function extractName(sig: string): string {
  // Go method: qualify by receiver type so `A.Run` and `B.Run` stay distinct.
  const goMethod = sig.match(/^\s*func\s*\((?:[^)]*[\s*])?(\w+)(?:\[[^\]]*\])?\)\s*(\w+)/);
  if (goMethod) return `${goMethod[1]}.${goMethod[2]}`;
  // Rust impl: keep the whole target so `impl Foo` and `impl Show for Foo` differ.
  const impl = sig.match(/^\s*(?:unsafe\s+)?impl(?=[\s<])\s*(.+?)\s*(?:\{|\bwhere\b|$)/);
  if (impl) return `impl ${impl[1]}`;
  // A keyword inside parentheses is a parameter's qualifier (`int f(const char *s)`), not a declaration.
  for (const match of sig.matchAll(DECLARED_NAME)) {
    const before = sig.slice(0, match.index);
    if (before.split("(").length <= before.split(")").length) return match[1].replaceAll("`", "");
  }
  const bare = sig.replace(/@\w+(?:\([^)]*\))?\s*/g, "");
  // C++ operators: `operator==` and `operator()` are names, not calls of `operator`.
  const op = bare.match(
    /((?:[\w$~]+::)*)(?<![\w$])operator(?![\w$])\s*(\(\s*\)|\[\s*\]|[^\s\w()[\]]+|\w[\w:]*)(?=\s*\()/,
  );
  if (op) return `${op[1]}operator${/^\w/.test(op[2]) ? " " : ""}${op[2].replace(/\s+/g, "")}`;
  // Function-pointer declarator (`void (*cb)(int)`): the name sits in the first parentheses, past a `*`, and
  // those parentheses are followed by the pointer's own parameter list (a call's `(*args)` is not).
  const fnPtr = bare.match(/^[^(=]*\(\s*\*+\s*([\w$]+)(?:\[[^\]]*\]|\([^()]*\))*\s*\)\s*\(/);
  if (fnPtr) return fnPtr[1];
  // Method-like: the identifier before the first `(`, past modifiers and return types. It may be optional (`m?(`).
  const methodMatch = bare.match(/((?:[\w$~]+::)*[\w$~]+)\??\s*(?:<[^>]*>)?\s*\(/);
  // A `=` before the name makes it a call in an initializer (`items = new ArrayList<>()`): a field.
  if (methodMatch && !bare.slice(0, methodMatch.index).includes("=")) return methodMatch[1];
  // Field or property: the last identifier before its initializer, type annotation, or accessor block.
  // Modifiers (`private`, `public static`) come first, so they are never the last word.
  // A quoted key (`"content-type": string`) or an optional member (`host?: string`) is still the name.
  const field = bare.split(/[=;:{]/, 1)[0].match(/(?:([\w$]+)|["']([^"']+)["'])[?!]?\s*(?:\[[^\]]*\]\s*)*$/);
  if (field) return field[1] ?? field[2];
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
  const rawHead = (s: SymbolInfo) => s.head ?? splitSignature(s.signature).head;
  const sameSignature = (a: SymbolInfo, b: SymbolInfo) => normalizeBody(rawHead(a)) === normalizeBody(rawHead(b));
  // A rename changes the name; any other difference in the signature is a separate edit to report.
  // The name may have gained a space the source lacks (`impl <T> Foo<T>` for `impl<T> Foo<T>`).
  const signatureSansName = (s: SymbolInfo) => {
    const bare = s.name
      .slice(s.name.lastIndexOf(".") + 1)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    return normalizeBody(rawHead(s).replace(new RegExp(`(?<![\\w$])${bare}(?![\\w$])`), ""));
  };

  const pairs = new Map<SymbolInfo, SymbolInfo>();
  const paired = new Set<SymbolInfo>();
  const pairBy = (key: (s: SymbolInfo) => string, eligible: (s: SymbolInfo) => boolean) => {
    const candidates = Map.groupBy(newSyms.filter(eligible), key);
    // Identical symbols pair first: a duplicate inserted above an unchanged one must not take its partner.
    const tiers: Array<(a: SymbolInfo, b: SymbolInfo) => boolean> = [
      (a, b) => sameSignature(a, b) && a.bodyHash === b.bodyHash,
      sameSignature,
      () => true,
    ];
    for (const accepts of tiers) {
      for (const o of oldSyms) {
        if (pairs.has(o) || !eligible(o)) continue;
        const n = candidates.get(key(o))?.find((c) => !paired.has(c) && accepts(o, c));
        if (!n) continue;
        pairs.set(o, n);
        paired.add(n);
      }
    }
  };
  // Same-named symbols (overloads, get/set pairs) pair when identical first, then by signature, then in order.
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
  const hasBody = (s: SymbolInfo) => s.bodyHash !== EMPTY_BODY_HASH;
  const oldByHash = Map.groupBy(unmatchedOld.filter(hasBody), (o) => o.bodyHash);
  // By identity, not name: names collide across class scopes and overloads.
  const renamedOld = new Set<SymbolInfo>();

  for (const n of unmatchedNew) {
    const o = hasBody(n) ? oldByHash.get(n.bodyHash)?.shift() : undefined;
    if (o) {
      // Bare names read `run` → `run` for a method moved between classes: scope them when the scope changed.
      result.renamed.push(
        o.scope === n.scope ? { oldName: o.name, newName: n.name } : { oldName: identity(o), newName: identity(n) },
      );
      if (signatureSansName(o) !== signatureSansName(n)) {
        result.signatureChanged.push({ name: identity(o), oldSig: o.signature, newSig: n.signature });
      }
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

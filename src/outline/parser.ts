/**
 * Tree-sitter parser management.
 *
 * Lazily initializes web-tree-sitter and caches loaded language grammars.
 * WASM files are resolved from the tree-sitter-wasms package.
 */
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

let initialized = false;
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter 0.24.x has no usable type exports
const languageCache = new Map<string, any>();

/**
 * Resolve the path to tree-sitter.wasm at runtime.
 *
 * bun build --target=node hardcodes the WASM path from the build environment
 * (e.g. /home/runner/work/…) into the bundle. We override with locateFile so
 * the path is resolved from the actual node_modules at runtime.
 */
function treeSitterWasmPath(): string {
  const entry = require.resolve("web-tree-sitter/package.json");
  return resolve(dirname(entry), "tree-sitter.wasm");
}

/** Ensure web-tree-sitter WASM runtime is initialized (idempotent). */
async function ensureInit(): Promise<void> {
  if (initialized) return;
  // Guard against WASM loading that hangs (e.g. missing .wasm files).
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("tree-sitter WASM init timed out after 10 s")), 10_000),
  );
  await Promise.race([Parser.init({ locateFile: () => treeSitterWasmPath() }), timeout]);
  initialized = true;
}

/** Resolve the path to a grammar's .wasm file via require.resolve. */
function grammarPath(grammar: string): string {
  // require.resolve finds the package from wherever node_modules lives,
  // whether running from src/ or dist/
  const wasmsEntry = require.resolve("tree-sitter-wasms/package.json");
  return resolve(dirname(wasmsEntry), "out", `tree-sitter-${grammar}.wasm`);
}

/** Create a parser configured for a given grammar. */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter 0.24.x has no usable type exports
export async function createParser(grammar: string): Promise<any> {
  await ensureInit();
  const parser = new Parser();
  // Load each grammar once
  let lang = languageCache.get(grammar);
  if (!lang) {
    lang = await Parser.Language.load(grammarPath(grammar));
    languageCache.set(grammar, lang);
  }
  parser.setLanguage(lang);
  return parser;
}

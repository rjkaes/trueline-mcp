/**
 * Tree-sitter parser management.
 *
 * Lazily initializes web-tree-sitter and caches loaded language grammars.
 * WASM files are resolved from the tree-sitter-wasms package.
 */
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

let initialization: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

/**
 * Resolve the path to tree-sitter.wasm at runtime.
 *
 * bun build --target=node hardcodes the WASM path from the build environment
 * (e.g. /home/runner/work/…) into the bundle. We override with locateFile so
 * the path is resolved from the actual node_modules at runtime.
 */
function treeSitterWasmPath(): string {
  // 0.25+ does not export ./package.json, so resolve the main entry instead.
  return resolve(dirname(require.resolve("web-tree-sitter")), "tree-sitter.wasm");
}

/** Ensure web-tree-sitter WASM runtime is initialized (idempotent). */
function ensureInit(): Promise<void> {
  // Concurrent first callers must share one init: each Parser.init() builds its own
  // WASM module, and a Language loaded into one module is invalid in another.
  if (!initialization) {
    initialization = initRuntime();
    // Evict failures so a later call retries.
    initialization.catch(() => {
      initialization = undefined;
    });
  }
  return initialization;
}

async function initRuntime(): Promise<void> {
  // Guard against WASM loading that hangs (e.g. missing .wasm files).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tree-sitter WASM init timed out after 10 s")), 10_000);
  });
  try {
    await Promise.race([Parser.init({ locateFile: () => treeSitterWasmPath() }), timeout]);
  } finally {
    // A pending timer keeps the event loop alive; CLI runs lingered 10 s.
    clearTimeout(timer);
  }
}

/** Resolve the path to a grammar's .wasm file via require.resolve. */
function grammarPath(grammar: string): string {
  // require.resolve finds the package from wherever node_modules lives,
  // whether running from src/ or dist/
  const wasmsEntry = require.resolve("tree-sitter-wasms/package.json");
  return resolve(dirname(wasmsEntry), "out", `tree-sitter-${grammar}.wasm`);
}

/** Create a parser configured for a given grammar. */
export async function createParser(grammar: string): Promise<Parser> {
  await ensureInit();
  // Cache the in-flight load: every Language.load instantiates a grammar copy that
  // is never freed, so concurrent first callers must share one.
  let load = languageCache.get(grammar);
  if (!load) {
    load = Language.load(grammarPath(grammar));
    languageCache.set(grammar, load);
    // Evict failures so a later call retries.
    load.catch(() => languageCache.delete(grammar));
  }
  const lang = await load;
  // After the await: a rejected load would otherwise leak this parser.
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

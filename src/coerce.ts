// Parameter aliases: common alternative names → canonical schema names.
// Only alias-map when the canonical key was NOT explicitly provided,
// so an agent that sends both `paths` and `file_paths` keeps the canonical one.
const PARAM_ALIASES: Record<string, string> = {
  // file_paths is canonical everywhere; singular forms are aliases
  file_path: "file_paths",
  path: "file_paths",
  filePath: "file_paths",
  file: "file_paths",
  paths: "file_paths",
  filePaths: "file_paths",
  files: "file_paths",

  // compare_against (trueline_changes)
  ref: "compare_against",
  base: "compare_against",
  branch: "compare_against",
  git_ref: "compare_against",
  gitRef: "compare_against",
  compareAgainst: "compare_against",

  // pattern (trueline_search)
  query: "pattern",
  search: "pattern",

  // context_lines (trueline_search)
  context: "context_lines",
  contextLines: "context_lines",

  // max_matches (trueline_search)
  limit: "max_matches",
  maxMatches: "max_matches",
  max_results: "max_matches",
  maxResults: "max_matches",

  // case_insensitive (trueline_search)
  caseInsensitive: "case_insensitive",
  ignoreCase: "case_insensitive",
  ignore_case: "case_insensitive",

  // dry_run (trueline_edit)
  dryRun: "dry_run",
  "dry-run": "dry_run",

  // range → ranges (trueline_read); singular form maps to plural
  range: "ranges",
};

// Known integer-valued parameters that agents sometimes stringify.
const NUMERIC_KEYS = ["depth", "context_lines", "max_matches"];

/**
 * Normalize a checksum string: strip whitespace, remove `#` prefix on the
 * hex portion (e.g. `"10-25:#F7E2ABCD"` → `"10-25:f7e2abcd"`), and
 * lowercase hex digits.
 */
function normalizeChecksumStr(s: string): string {
  return s.replace(/\s+/g, "").replace(/:#/, ":").toLowerCase();
}

/**
 * Preprocess MCP tool parameters to be more permissive about what agents send:
 *
 * 1. **Alias mapping** — `paths` → `file_paths`, `path` → `file_path`, etc.
 * 2. **Stringified JSON** — `"[1,2]"` → `[1,2]` (arrays and objects)
 * 3. **Stringified booleans** — `"true"` → `true`, `"false"` → `false`
 *
 * Runs as a `z.preprocess` step before Zod validation.
 */
export function coerceParams(val: unknown): unknown {
  if (typeof val !== "object" || val === null) return val;
  const raw = val as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const canonicalKey = PARAM_ALIASES[key] ?? key;

    // Don't overwrite a canonical key that was explicitly provided
    if (canonicalKey !== key && canonicalKey in raw) continue;

    // Coerce stringified JSON arrays/objects
    if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
      try {
        result[canonicalKey] = JSON.parse(value);
        continue;
      } catch {
        // not valid JSON, fall through
      }
    }

    // Coerce stringified booleans (including yes/no and 1/0).
    // Skip 1/0 coercion for known numeric keys so context_lines: 1
    // doesn't become true.
    const isNumericKey = NUMERIC_KEYS.includes(canonicalKey);
    if (value === "true" || value === "yes" || (!isNumericKey && value === 1)) {
      result[canonicalKey] = true;
      continue;
    }
    if (value === "false" || value === "no" || (!isNumericKey && value === 0)) {
      result[canonicalKey] = false;
      continue;
    }

    result[canonicalKey] = value;
  }

  // Normalize file_paths: bare string → single-element array
  if (typeof result.file_paths === "string") {
    result.file_paths = [result.file_paths];
  }

  // Normalize ranges: bare string → single-element array, numbers → strings,
  // per-file object → flat array of values (LLMs sometimes send
  // {"src/foo.ts": "10-20"} instead of ["10-20"]).
  if (typeof result.ranges === "string") {
    result.ranges = [result.ranges];
  } else if (typeof result.ranges === "number") {
    result.ranges = [String(result.ranges)];
  } else if (typeof result.ranges === "object" && result.ranges !== null && !Array.isArray(result.ranges)) {
    result.ranges = Object.values(result.ranges as Record<string, unknown>).flat();
  }
  if (Array.isArray(result.ranges)) {
    result.ranges = (result.ranges as unknown[]).map((r) => {
      if (typeof r === "number") return String(r);
      if (typeof r === "string") return r.replace(/\s+/g, "");
      return r;
    });
  }

  // Normalize checksums: bare string → single-element array, then strip
  // whitespace, remove # prefix on hex, and lowercase.
  if (typeof result.checksums === "string") {
    result.checksums = [result.checksums];
  }
  if (Array.isArray(result.checksums)) {
    result.checksums = (result.checksums as unknown[]).map((c) =>
      typeof c === "string" ? normalizeChecksumStr(c) : c,
    );
  }

  // Normalize edits: bare object → single-element array
  if (typeof result.edits === "object" && result.edits !== null && !Array.isArray(result.edits)) {
    result.edits = [result.edits];
  }

  // Coerce stringified integers for known numeric fields
  for (const numKey of NUMERIC_KEYS) {
    if (numKey in result && typeof result[numKey] === "string") {
      const parsed = Number(result[numKey]);
      if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
        result[numKey] = parsed;
      }
    }
  }

  // Push top-level checksum into edits that are missing one.
  // Models sometimes pass {checksum: "...", edits: [{range, content}]}
  // instead of {edits: [{range, content, checksum: "..."}]}.
  if (typeof result.checksum === "string" && Array.isArray(result.edits)) {
    for (const edit of result.edits) {
      if (typeof edit === "object" && edit !== null && !("checksum" in edit)) {
        (edit as Record<string, unknown>).checksum = result.checksum;
      }
    }
    delete result.checksum;
  }

  // Coerce edit sub-objects: normalize checksums, ranges, and content.
  if (Array.isArray(result.edits)) {
    for (const edit of result.edits) {
      if (typeof edit === "object" && edit !== null) {
        const e = edit as Record<string, unknown>;

        // Detect built-in Edit tool shape (old_string/new_string instead of
        // range/checksum/content). Can't recover, but give a helpful error.
        if (("old_string" in e || "new_string" in e) && !("range" in e)) {
          throw new Error(
            "Edit uses old_string/new_string format (from the built-in Edit tool). " +
              "trueline_edit requires {range, checksum, content}. " +
              "Use trueline_search to find the target lines, then pass the range and checksum from its output.",
          );
        }

        // content: null/undefined → "" (delete lines)
        if (e.content === null || e.content === undefined) {
          e.content = "";
        }
        // content: array → newline-joined string
        if (Array.isArray(e.content)) {
          e.content = (e.content as unknown[]).map(String).join("\n");
        }
        // Normalize checksum: strip whitespace, remove # prefix, lowercase hex
        if (typeof e.checksum === "string") {
          e.checksum = normalizeChecksumStr(e.checksum);
        }
        // Strip whitespace from range
        if (typeof e.range === "string") {
          e.range = (e.range as string).replace(/\s+/g, "");
        }
      }
    }
  }

  return result;
}

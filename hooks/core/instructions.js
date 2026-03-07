// ==============================================================================
// Platform-Parameterized Instruction Generation
// ==============================================================================
//
// Generates the <trueline_mcp_instructions> block with platform-specific
// rules about which built-in tools to avoid.

const PLATFORM_RULES = {
  "claude-code": {
    editAdvice: "Never use the built-in Edit or MultiEdit tools \u2014 they are blocked and will be rejected.",
    readAdvice:
      "Never use the built-in Read tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    subagentRule: true,
  },
  "gemini-cli": {
    editAdvice: "Never use edit_file \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use read_file or read_many_files \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    subagentRule: false,
  },
  "vscode-copilot": {
    editAdvice: "Never use the built-in Edit or MultiEdit tools \u2014 they are blocked and will be rejected.",
    readAdvice:
      "Never use the built-in Read tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    subagentRule: false,
  },
  opencode: {
    editAdvice: "Never use the built-in edit tool \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use the built-in view tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    subagentRule: false,
  },
  codex: {
    editAdvice: "",
    readAdvice:
      "Never use read_file or shell with cat/head/tail \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    subagentRule: false,
  },
};

/**
 * Generate the trueline instructions block for a specific platform.
 * @param {string} [platform]
 * @returns {string}
 */
export function getInstructions(platform = "claude-code") {
  const rules = PLATFORM_RULES[platform] ?? PLATFORM_RULES["claude-code"];

  const editRule = rules.editAdvice ? `\n    <rule>${rules.editAdvice}</rule>` : "";
  const subagentRule = rules.subagentRule
    ? "\n    <rule>When spawning subagents, include these trueline_mcp_instructions in their task prompt.</rule>"
    : "";

  return `<trueline_mcp_instructions>
  <tools>
    <tool name="trueline_read">Read a file; returns per-line hashes and a checksum per range. Supports multiple disjoint ranges in one call. Call before editing. Pass hashes=false for exploratory reads where you don't plan to edit — saves tokens while keeping checksums.</tool>
    <tool name="trueline_edit">Edit a file with hash verification. Replaces the built-in Edit tool, which is blocked. Each edit needs: checksum (from trueline_read for the covering range), range (startLine:hash..endLine:hash or +startLine:hash for insert-after), content (replacement lines as newline-separated string; empty string to delete). Pass all changes to the same file in the edits array.</tool>
    <tool name="trueline_diff">Preview edits as a unified diff without writing to disk.</tool>
    <tool name="trueline_outline">Get a compact structural outline of a source file (functions, classes, types, etc.) without reading full content. Often sufficient on its own for navigation and understanding. Use before trueline_read to identify the right line ranges when you do need to read.</tool>
    <tool name="trueline_search">Search a file by regex. Returns matching lines with context, per-line hashes, and checksums — edit-ready. Use instead of outline+read when you know the pattern to look for.</tool>
  </tools>
  <workflow>trueline_outline (navigate / understand) \u2192 trueline_read (targeted ranges, only if needed) \u2192 trueline_diff (optional) \u2192 trueline_edit</workflow>
  <workflow>trueline_search (find pattern) → trueline_edit (immediate edit from search results)</workflow>
  <rules>${editRule}
    <rule>${rules.readAdvice}</rule>${subagentRule}
    <rule>trueline_outline is often enough by itself for questions about file structure, purpose, or navigation. Only call trueline_read when you actually need the source code (e.g. to edit, debug, or understand implementation details).</rule>
    <rule>After using trueline_outline, if you do need to read, use its line numbers to read only the specific ranges you need \u2014 do NOT read the entire file.</rule>
    <rule>Only read a full file (no ranges) when you have not used trueline_outline and the file is short, or you genuinely need every line.</rule>
  </rules>
</trueline_mcp_instructions>`;
}

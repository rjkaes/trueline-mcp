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
    writeAdvice:
      "Use the built-in Write tool to create new files. " +
      "To edit files afterward, use trueline_search \u2192 trueline_edit.",
  },
  "gemini-cli": {
    editAdvice: "Never use edit_file \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use read_file or read_many_files \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use write_file to create new files. " + "To edit files afterward, use trueline_search \u2192 trueline_edit.",
  },
  "vscode-copilot": {
    editAdvice: "Never use the built-in Edit or MultiEdit tools \u2014 they are blocked and will be rejected.",
    readAdvice:
      "Never use the built-in Read tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use the built-in Write tool to create new files. " +
      "To edit files afterward, use trueline_search \u2192 trueline_edit.",
  },
  opencode: {
    editAdvice: "Never use the built-in edit tool \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use the built-in view tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use the built-in write tool to create new files. " +
      "To edit files afterward, use trueline_search \u2192 trueline_edit.",
  },
  codex: {
    editAdvice: "",
    readAdvice:
      "Never use read_file or shell with cat/head/tail \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use shell redirection to create new files. " +
      "To edit files afterward, use trueline_search \u2192 trueline_edit.",
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

  return `<trueline_mcp_instructions>
  <tools>
    <tool name="trueline_read">Read files. Pass hashes=false for exploratory reads. Call before editing.</tool>
    <tool name="trueline_edit">Hash-verified edits. Needs checksum from trueline_read or trueline_search.</tool>
    <tool name="trueline_diff">Preview edits as unified diff without writing.</tool>
    <tool name="trueline_outline">Structural outline — often enough on its own. Use to find line ranges before targeted reads.</tool>
    <tool name="trueline_search">Regex search with hashes — edit-ready results. Preferred over Grep for single-file searches.</tool>
    <tool name="trueline_verify">Check if held checksums are still valid. Cheaper than re-reading.</tool>
  </tools>
  <workflow>trueline_outline → trueline_read (targeted ranges) → trueline_diff (optional) → trueline_edit</workflow>
  <workflow>trueline_search → trueline_edit (no re-read needed)</workflow>
  <workflow>trueline_verify → trueline_read (only if stale) → trueline_edit</workflow>
  <rules>${editRule}
    <rule>${rules.readAdvice}</rule>
    <rule>${rules.writeAdvice}</rule>
    <rule>Prefer trueline_outline first. Only call trueline_read for specific ranges you need (to edit, debug, or understand details). Read whole files only when short and you haven't used outline.</rule>
    <rule>When you already know the text to change, use trueline_search → trueline_edit (skips the read). This is the fastest edit path. Each match group gets its own checksum — use it directly with trueline_edit.</rule>
    <rule>When you need to find a pattern across many files, use Grep to identify the files, then use trueline_search on individual files you need to edit.</rule>
  </rules>
</trueline_mcp_instructions>`;
}

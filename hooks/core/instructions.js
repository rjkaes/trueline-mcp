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
      "To edit them afterward, use trueline_read or trueline_search to get checksums first.",
    atRefAdvice:
      "If file content was injected by an @ reference, never call Read or trueline_read just to view it again. " +
      "Only call trueline_read or trueline_search when you need checksums for editing.",
    grepAdvice: "use Grep to identify the files",
  },
  "gemini-cli": {
    editAdvice: "Never use edit_file \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use read_file or read_many_files \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use write_file to create new files. " +
      "To edit them afterward, use trueline_read or trueline_search to get checksums first.",
    grepAdvice: "use run_shell_command with grep/rg to identify the files",
  },
  "vscode-copilot": {
    editAdvice: "Never use the built-in Edit or MultiEdit tools \u2014 they are blocked and will be rejected.",
    readAdvice:
      "Never use the built-in Read tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use the built-in Write tool to create new files. " +
      "To edit them afterward, use trueline_read or trueline_search to get checksums first.",
    atRefAdvice:
      "If file content was injected by an @ reference, never call Read or trueline_read just to view it again. " +
      "Only call trueline_read or trueline_search when you need checksums for editing.",
    grepAdvice: "use Grep to identify the files",
  },
  opencode: {
    editAdvice: "Never use the built-in edit tool \u2014 use trueline_edit instead.",
    readAdvice:
      "Never use the built-in view tool \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use the built-in write tool to create new files. " +
      "To edit them afterward, use trueline_read or trueline_search to get checksums first.",
    grepAdvice: "use bash with grep/rg to identify the files",
  },
  codex: {
    editAdvice: "",
    readAdvice:
      "Never use read_file or shell with cat/head/tail \u2014 use trueline_read instead. " +
      "trueline_read returns per-line hashes and checksums needed for trueline_edit.",
    writeAdvice:
      "Use shell redirection to create new files. " +
      "To edit them afterward, use trueline_read or trueline_search to get checksums first.",
    grepAdvice: "use shell with grep/rg to identify the files",
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
  const atRefRule = rules.atRefAdvice ? `\n    <rule>${rules.atRefAdvice}</rule>` : "";

  return `<trueline_mcp_instructions>
  <tools>
    <tool name="trueline_read">Read files. Pass hashes=false when you only need to understand code, not edit it.</tool>
    <tool name="trueline_edit">Hash-verified edits. Needs checksum from trueline_read or trueline_search. Pass dry_run=true to preview as unified diff.</tool>
    <tool name="trueline_diff">Semantic AST-based diff vs a git ref. Pass all files in one call via file_paths; use ["*"] for all changed files.</tool>
    <tool name="trueline_outline">Structural outline of one or more files. Often enough on its own. Use to find line ranges before targeted reads.</tool>
    <tool name="trueline_search">Literal string search with hashes \u2014 returns edit-ready results. Set regex=true for regex. Use for single-file searches when you plan to edit the matches.</tool>
    <tool name="trueline_verify">Check if held checksums are still valid. Cheaper than re-reading.</tool>
  </tools>
  <workflow>trueline_outline → trueline_read (targeted ranges) → trueline_edit (use dry_run=true to preview)</workflow>
  <workflow>trueline_search → trueline_edit (no re-read needed)</workflow>
  <workflow>trueline_verify → trueline_read (re-read only stale ranges) → trueline_edit</workflow>
  <workflow>trueline_diff → review structural changes vs git state</workflow>
  <rules>${editRule}
    <rule>${rules.readAdvice}</rule>
    <rule>${rules.writeAdvice}</rule>
    <rule>Prefer trueline_outline first. Only call trueline_read for specific ranges you need (to edit, debug, or understand details). Read whole files only when short and you haven't used outline.</rule>
    <rule>When you already know the text to change, use trueline_search → trueline_edit (skips the read). This is the fastest edit path. Each match group gets its own checksum — use it directly with trueline_edit.</rule>
    <rule>When you need to find a pattern across many files, ${rules.grepAdvice}, then use trueline_search on individual files you need to edit.</rule>
    <rule>Batch multiple edits to the same file into one trueline_edit call. Each edit carries its own checksum \u2014 they don't need to share one.</rule>${atRefRule}
  </rules>
</trueline_mcp_instructions>`;
}

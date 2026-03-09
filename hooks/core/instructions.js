// ==============================================================================
// Platform-Parameterized Instruction Generation
// ==============================================================================
//
// Generates the <trueline_mcp_instructions> block with platform-specific
// tool routing guidance based on file size.

const PLATFORM_TOOLS = {
  "claude-code": {
    readTool: "Read",
    editTool: "Edit",
    writeTool: "Write",
    grepAdvice: "use Grep to identify the files",
    atRefAdvice:
      "If file content was injected by an @ reference, never call Read or trueline_read just to view it again. " +
      "Only call trueline_read or trueline_search when you need checksums for editing.",
  },
  "gemini-cli": {
    readTool: "read_file",
    editTool: "edit_file",
    writeTool: "write_file",
    grepAdvice: "use run_shell_command with grep/rg to identify the files",
  },
  "vscode-copilot": {
    readTool: "Read",
    editTool: "Edit",
    writeTool: "Write",
    grepAdvice: "use Grep to identify the files",
    atRefAdvice:
      "If file content was injected by an @ reference, never call Read or trueline_read just to view it again. " +
      "Only call trueline_read or trueline_search when you need checksums for editing.",
  },
  opencode: {
    readTool: "view",
    editTool: "edit",
    writeTool: "write",
    grepAdvice: "use bash with grep/rg to identify the files",
  },
  codex: {
    readTool: "read_file / shell cat",
    editTool: "shell sed/awk",
    writeTool: "shell redirection",
    grepAdvice: "use shell with grep/rg to identify the files",
  },
};

/**
 * Generate the trueline instructions block for a specific platform.
 * @param {string} [platform]
 * @returns {string}
 */
export function getInstructions(platform = "claude-code") {
  const p = PLATFORM_TOOLS[platform] ?? PLATFORM_TOOLS["claude-code"];

  const atRefTip = p.atRefAdvice ? `\n    <tip>${p.atRefAdvice}</tip>` : "";

  // Platforms with deferred/lazy tool loading benefit from a batch-load hint.
  const deferredHint =
    platform === "claude-code" || platform === "vscode-copilot"
      ? `\n  <deferred_loading>When trueline tools are deferred, load all in one ToolSearch call: +trueline read edit</deferred_loading>`
      : "";

  return `<trueline_mcp_instructions>
  <tools>
    <tool name="trueline_outline">Structural outline of one or more files. Returns functions, classes, and declarations with line ranges. Always cheaper than reading the full file.</tool>
    <tool name="trueline_diff">Semantic AST-based diff vs a git ref. Pass all files in one call via file_paths; use ["*"] for all changed files. No built-in equivalent.</tool>
    <tool name="trueline_read">Read files with checksums. Returns line content with range checksums for editing.</tool>
    <tool name="trueline_edit">Checksum-verified edits. Needs checksum from trueline_read or trueline_search. Pass dry_run=true to preview as unified diff.</tool>
    <tool name="trueline_search">Literal string search \u2014 returns edit-ready results with checksums. Set regex=true for regex. Use for single-file searches when you plan to edit the matches.</tool>
    <tool name="trueline_verify">Check if held checksums are still valid. Cheaper than re-reading.</tool>
  </tools>
  <exploration>
    <rule>To understand a file's structure, use trueline_outline instead of ${p.readTool}. Outline returns ~10-20 lines for a typical file vs hundreds from a full read.</rule>
    <rule>To review changes, use trueline_diff. It provides a semantic summary of structural changes (added/removed/renamed symbols, signature changes) that no built-in tool can produce.</rule>
    <rule>Only use ${p.readTool} for files you need to see in full (short configs, READMEs, files under ~50 lines).</rule>
  </exploration>
  <editing>
    <path name="surgical" default="true">When you know the target (a function name, variable, string): use trueline_search to find lines with checksums, then trueline_edit. This is the fastest path and guarantees edits land on the right content.</path>
    <path name="exploratory">When you need context first: trueline_outline \u2192 trueline_read (targeted ranges) to understand, then trueline_search or trueline_read \u2192 trueline_edit.</path>
    <path name="small-edit">For files under ~200 lines or trivial one-line changes: ${p.readTool} and ${p.editTool} are fine. The MCP round-trip overhead outweighs hash verification savings on small files.</path>
  </editing>
  <workflow>trueline_outline \u2192 understand structure (any file, any size)</workflow>
  <workflow>trueline_search \u2192 trueline_edit (fastest edit path, no read needed)</workflow>
  <workflow>trueline_outline \u2192 trueline_read (targeted ranges) \u2192 trueline_edit (exploratory path)</workflow>
  <workflow>trueline_verify \u2192 trueline_read (re-read only stale ranges) \u2192 trueline_edit</workflow>
  <workflow>trueline_diff \u2192 review structural changes vs git state</workflow>${deferredHint}

  <tips>
    <tip>Use ${p.writeTool} to create new files. To edit them afterward, use trueline_read or trueline_search to get checksums first.</tip>
    <tip>When you need to find a pattern across many files, ${p.grepAdvice}, then use trueline_search on individual files you need to edit.</tip>
    <tip>Batch multiple edits to the same file into one trueline_edit call. Each edit needs the checksum whose line range covers that edit's target lines — don't reuse a checksum from one region for an edit in a different region.</tip>${atRefTip}
  </tips>
</trueline_mcp_instructions>`;
}

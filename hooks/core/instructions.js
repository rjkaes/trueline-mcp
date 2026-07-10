// ==============================================================================
// Platform-Parameterized Instruction Generation
// ==============================================================================
//
// Generates the trueline MCP instructions block (dense markdown) injected at
// SessionStart/SubagentStart. Targets ~250 tokens vs the old XML block (~900).

const PLATFORM_TOOLS = {
  "claude-code": {
    readTool: "Read",
    editTool: "Edit",
    writeTool: "Write",
    grepAdvice: "use Grep to identify the files",
    atRefAdvice:
      "If file content was injected by an @ reference, never call Read or trueline_read just to view it again. " +
      "Only call trueline_read or trueline_search when you need refs for editing.",
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
      "Only call trueline_read or trueline_search when you need refs for editing.",
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

  const atRefTip = p.atRefAdvice ? `\n- ${p.atRefAdvice}` : "";

  // Platforms with deferred/lazy tool loading benefit from a batch-load hint.
  const deferredHint =
    platform === "claude-code" || platform === "vscode-copilot"
      ? `\n- Deferred tools: load all in one ToolSearch call: \`+trueline read edit\``
      : "";

  return `### trueline MCP

**Explore**
- Structure: trueline_outline before reading any file (returns ~10-20 lines vs hundreds)
- Changes: trueline_changes for semantic structural diff vs git
- ${p.readTool}: only for files <50 lines or when full content needed for editing
- Targeted read: trueline_read with \`path:start-end\` range syntax

**Edit (fastest path: trueline_search -> trueline_edit, no read needed)**
- Know the target? trueline_search to get refs -> trueline_edit immediately
- Need context? trueline_outline -> trueline_read (targeted ranges) -> trueline_edit
- Small files or trivial changes: trueline_read -> trueline_edit (skip search; the read returns refs)
- trueline_verify before re-reading — only re-read stale ranges
- All trueline MCP tools require an absolute file_path (relative resolves against a stale project root in worktrees; CLI still accepts relative)

**Refs**
- Refs are verbatim from trueline_read/trueline_search output — never fabricate
- A wide ref (e.g. lines 1-157) is valid for editing any sub-range within it
- Range format: \`ab10-cd11\` (2-letter hash prefix + line number, both ends required)
- Insert without replacing: \`action: "insert_after"\` — default replaces and deletes
- \`context_lines\` param returns hashLine context around edits for chaining

**Example (search-then-edit)**
\`\`\`
trueline_search -> "->ab10 old line one / cd11 old line two / ref: ab10-cd11/efghij"
trueline_edit: range="ab10-cd11", ref="ab10-cd11/efghij", content="new line one\nnew line two"
\`\`\`

**Multi-file**: ${p.grepAdvice}, then pass all file_paths to one trueline_search call

**Error recovery**: If trueline_read fails with "H.reduce is not a function", run \`trueline read FILE\` or \`trueline read FILE:START-END\` in Bash — refs from CLI output are valid in trueline_edit MCP calls${atRefTip}${deferredHint}`;
}

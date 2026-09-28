// Extensions supported by trueline_outline (tree-sitter grammars + custom parsers for md/xml).
// Single source of truth: imported by both src/outline/languages.ts and hooks/core/routing.js.
export const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
export const XML_EXTENSIONS = new Set([
  ".xml",
  ".xsl",
  ".xslt",
  ".xhtml",
  ".svg",
  ".pom",
  ".csproj",
  ".props",
  ".targets",
  ".fxml",
  ".xaml",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".rb",
  ".php",
  ".kt",
  ".kts",
  ".swift",
  ".scala",
  ".sc",
  ".ex",
  ".exs",
  ".lua",
  ".dart",
  ".zig",
  ".sh",
  ".bash",
]);

export const OUTLINEABLE_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...XML_EXTENSIONS]);

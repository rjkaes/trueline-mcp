// Extensions supported by trueline_outline (tree-sitter grammars + custom parsers for md/xml).
// Plain JS so hooks/core/routing.js can import it outside the TS build; src/tools/outline.ts imports it too.
// CODE_EXTENSIONS repeats the LANGUAGES keys in languages.ts, which hooks can't import;
// tests/hooks/routing.test.ts fails if a LANGUAGES key is missing here.
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

/**
 * Per-language configuration for AST outline extraction.
 *
 * Each language defines:
 * - `grammar`: the tree-sitter-wasms grammar filename (without .wasm)
 * - `outline`: top-level node types to include in the outline
 * - `skip`: node types to always exclude (e.g. imports)
 * - `recurse`: node types whose named children should be inlined
 *   (e.g. class bodies, impl blocks)
 */

export interface LanguageConfig {
  grammar: string;
  /** Top-level node types to include */
  outline: Set<string>;
  /** Node types to skip entirely */
  skip: Set<string>;
  /** Node types whose children should be recursed into (one level) */
  recurse: Set<string>;
  /** Node types only included when they are direct children of the root */
  topLevelOnly?: Set<string>;
  /** Whitespace normalization for semantic diffing body hashes.
   *  "collapse" (default): collapse whitespace runs to single space, trim lines.
   *  "preserve-indent": normalize trailing whitespace only, preserve leading indentation. */
  whitespaceMode?: "collapse" | "preserve-indent";
}

const typescript: LanguageConfig = {
  grammar: "typescript",
  outline: new Set([
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
    "method_definition",
    "public_field_definition",
  ]),
  skip: new Set(["import_statement"]),
  recurse: new Set(["class_body"]),
  topLevelOnly: new Set(["expression_statement"]),
};

const tsx: LanguageConfig = {
  ...typescript,
  grammar: "tsx",
};

const javascript: LanguageConfig = {
  grammar: "javascript",
  outline: new Set([
    "function_declaration",
    "class_declaration",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
    "expression_statement",
    "method_definition",
    "field_definition",
  ]),
  skip: new Set(["import_statement"]),
  recurse: new Set(["class_body"]),
};

const python: LanguageConfig = {
  grammar: "python",
  outline: new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
    "expression_statement", // top-level assignments
  ]),
  skip: new Set(["import_statement", "import_from_statement"]),
  recurse: new Set(["block"]),
  whitespaceMode: "preserve-indent",
};

const go: LanguageConfig = {
  grammar: "go",
  outline: new Set([
    "function_declaration",
    "method_declaration",
    "type_declaration",
    "const_declaration",
    "var_declaration",
  ]),
  skip: new Set(["package_clause", "import_declaration"]),
  recurse: new Set([]),
};

const rust: LanguageConfig = {
  grammar: "rust",
  outline: new Set([
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "const_item",
    "static_item",
    "mod_item",
    "type_item",
    "macro_definition",
  ]),
  skip: new Set(["use_declaration"]),
  recurse: new Set(["declaration_list"]),
};

const java: LanguageConfig = {
  grammar: "java",
  outline: new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "field_declaration",
  ]),
  skip: new Set(["package_declaration", "import_declaration"]),
  recurse: new Set(["class_body"]),
};

const ruby: LanguageConfig = {
  grammar: "ruby",
  outline: new Set([
    "method",
    "class",
    "module",
    "assignment",
    "call", // require, require_relative at top level
  ]),
  skip: new Set([]),
  recurse: new Set(["body_statement"]),
};

const cpp: LanguageConfig = {
  grammar: "cpp",
  outline: new Set([
    "function_definition",
    "class_specifier",
    "struct_specifier",
    "enum_specifier",
    "namespace_definition",
    "declaration",
    "template_declaration",
  ]),
  skip: new Set(["preproc_include"]),
  recurse: new Set(["declaration_list", "field_declaration_list"]),
};

const c: LanguageConfig = {
  grammar: "c",
  outline: new Set(["function_definition", "struct_specifier", "enum_specifier", "declaration", "type_definition"]),
  skip: new Set(["preproc_include"]),
  recurse: new Set([]),
};

const csharp: LanguageConfig = {
  grammar: "c_sharp",
  outline: new Set([
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "property_declaration",
    "namespace_declaration",
  ]),
  skip: new Set(["using_directive"]),
  recurse: new Set(["declaration_list"]),
};

const kotlin: LanguageConfig = {
  grammar: "kotlin",
  outline: new Set(["function_declaration", "class_declaration", "object_declaration", "property_declaration"]),
  skip: new Set(["import_list", "package_header"]),
  recurse: new Set(["class_body"]),
};

const swift: LanguageConfig = {
  grammar: "swift",
  outline: new Set([
    "function_declaration",
    "class_declaration",
    "struct_declaration",
    "enum_declaration",
    "protocol_declaration",
    "extension_declaration",
    "property_declaration",
  ]),
  skip: new Set(["import_declaration"]),
  recurse: new Set(["class_body"]),
};

const php: LanguageConfig = {
  grammar: "php",
  outline: new Set([
    "function_definition",
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "method_declaration",
    "property_declaration",
  ]),
  skip: new Set(["namespace_use_declaration"]),
  recurse: new Set(["declaration_list"]),
};

const scala: LanguageConfig = {
  grammar: "scala",
  outline: new Set([
    "function_definition",
    "class_definition",
    "object_definition",
    "trait_definition",
    "val_definition",
    "var_definition",
    "type_definition",
  ]),
  skip: new Set(["import_declaration"]),
  recurse: new Set(["template_body"]),
};

const elixir: LanguageConfig = {
  grammar: "elixir",
  outline: new Set(["call"]), // def, defp, defmodule are all calls in elixir's grammar
  skip: new Set([]),
  recurse: new Set([]),
};

const lua: LanguageConfig = {
  grammar: "lua",
  outline: new Set([
    "function_declaration",
    "local_function",
    "variable_declaration",
    "local_variable_declaration",
    "assignment_statement",
  ]),
  skip: new Set([]),
  recurse: new Set([]),
};

const dart: LanguageConfig = {
  grammar: "dart",
  outline: new Set([
    "function_signature",
    "class_definition",
    "enum_declaration",
    "mixin_declaration",
    "extension_declaration",
    "type_alias",
  ]),
  skip: new Set(["import_or_export"]),
  recurse: new Set(["class_body"]),
};

const zig: LanguageConfig = {
  grammar: "zig",
  outline: new Set(["TopLevelDecl", "VarDecl", "FnProto"]),
  skip: new Set([]),
  recurse: new Set([]),
};

const bash: LanguageConfig = {
  grammar: "bash",
  outline: new Set(["function_definition", "variable_assignment"]),
  skip: new Set([]),
  recurse: new Set([]),
};

// Extension → language config mapping
const LANGUAGES: Record<string, LanguageConfig> = {
  // TypeScript / JavaScript
  ".ts": typescript,
  ".tsx": tsx,
  ".js": javascript,
  ".jsx": javascript,
  ".mjs": javascript,
  ".cjs": javascript,
  // Python
  ".py": python,
  ".pyi": python,
  // Go
  ".go": go,
  // Rust
  ".rs": rust,
  // Java
  ".java": java,
  // C / C++
  ".c": c,
  ".h": c,
  ".cpp": cpp,
  ".cc": cpp,
  ".cxx": cpp,
  ".hpp": cpp,
  ".hh": cpp,
  // C#
  ".cs": csharp,
  // Ruby
  ".rb": ruby,
  // PHP
  ".php": php,
  // Kotlin
  ".kt": kotlin,
  ".kts": kotlin,
  // Swift
  ".swift": swift,
  // Scala
  ".scala": scala,
  ".sc": scala,
  // Elixir
  ".ex": elixir,
  ".exs": elixir,
  // Lua
  ".lua": lua,
  // Dart
  ".dart": dart,
  // Zig
  ".zig": zig,
  // Bash
  ".sh": bash,
  ".bash": bash,
  // Config / data (no outline, but parseable)
  // ".json": json,
  // ".yaml": yaml,
  // ".toml": toml,
};

// Re-export for consumers that only need the extension set (e.g. hooks).
export { OUTLINEABLE_EXTENSIONS } from "./supported-extensions.js";

export function getLanguageConfig(ext: string): LanguageConfig | undefined {
  return LANGUAGES[ext];
}

export function supportedExtensions(): string[] {
  return Object.keys(LANGUAGES);
}

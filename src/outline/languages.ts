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

import type { Node as SyntaxNode } from "web-tree-sitter";

export interface LanguageConfig {
  grammar: string;
  /** Top-level node types to include */
  outline: Set<string>;
  /** Node types to skip entirely */
  skip?: Set<string>;
  /** Node types whose children should be recursed into (one level) */
  recurse?: Set<string>;
  /** Whether to list the members of a recurse target, given the node that owns it.
   *  For languages where function bodies and class bodies share a node type. */
  canRecurse?: (owner: SyntaxNode) => boolean;
  /** Node types whose children are visited at the same depth, without an entry of their own. */
  transparent?: Set<string>;
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
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
    "expression_statement",
    "method_definition",
    "abstract_method_signature",
    "public_field_definition",
  ]),
  skip: new Set(["import_statement"]),
  recurse: new Set(["class_body"]),
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
  canRecurse: (owner) => owner.type === "class_definition",
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
};

const rust: LanguageConfig = {
  grammar: "rust",
  outline: new Set([
    "function_item",
    "function_signature_item",
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
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "field_declaration",
    "constant_declaration",
  ]),
  skip: new Set(["package_declaration", "import_declaration"]),
  recurse: new Set(["class_body", "interface_body"]),
};

const ruby: LanguageConfig = {
  grammar: "ruby",
  outline: new Set([
    "method",
    "singleton_method",
    "class",
    "module",
    "assignment",
    "call", // require, require_relative at top level
  ]),
  recurse: new Set(["body_statement"]),
  canRecurse: (owner) => owner.type === "class" || owner.type === "module",
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
  // Include guards and conditional compilation wrap most of a header.
  transparent: new Set(["preproc_ifdef", "preproc_if", "preproc_else", "preproc_elif"]),
};

const c: LanguageConfig = {
  grammar: "c",
  outline: new Set(["function_definition", "struct_specifier", "enum_specifier", "declaration", "type_definition"]),
  skip: new Set(["preproc_include"]),
  transparent: new Set(["preproc_ifdef", "preproc_if", "preproc_else", "preproc_elif"]),
};

const csharp: LanguageConfig = {
  grammar: "c_sharp",
  outline: new Set([
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "record_declaration",
    "record_struct_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "property_declaration",
    "namespace_declaration",
  ]),
  skip: new Set(["using_directive"]),
  recurse: new Set(["declaration_list"]),
  // `namespace X;` has no body node: its members are its direct children.
  transparent: new Set(["file_scoped_namespace_declaration"]),
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
  recurse: new Set(["do_block"]),
  // A def's do_block holds its body, not symbols.
  canRecurse: (owner) => /^def(module|protocol|impl)$/.test(owner.childForFieldName("target")?.text ?? ""),
};

const lua: LanguageConfig = {
  grammar: "lua",
  outline: new Set([
    "function_definition_statement",
    "local_function_definition_statement",
    "local_variable_declaration",
    "variable_assignment",
  ]),
};

const dart: LanguageConfig = {
  grammar: "dart",
  outline: new Set([
    "function_signature",
    "getter_signature",
    "setter_signature",
    "constructor_signature",
    "factory_constructor_signature",
    "class_definition",
    "enum_declaration",
    "mixin_declaration",
    "extension_declaration",
    "extension_type_declaration",
    "type_alias",
  ]),
  skip: new Set(["import_or_export"]),
  // A member's signature sits inside a `declaration` or `method_signature` wrapper; its body is a sibling.
  transparent: new Set(["declaration", "method_signature"]),
  recurse: new Set(["class_body", "extension_body"]),
};

const zig: LanguageConfig = {
  grammar: "zig",
  outline: new Set(["function_declaration", "variable_declaration"]),
};

const bash: LanguageConfig = {
  grammar: "bash",
  outline: new Set(["function_definition", "variable_assignment"]),
};

// Extension → language config mapping
export const LANGUAGES: Record<string, LanguageConfig> = {
  // TypeScript / JavaScript
  ".ts": typescript,
  ".mts": typescript,
  ".cts": typescript,
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
};

export function getLanguageConfig(ext: string): LanguageConfig | undefined {
  return LANGUAGES[ext];
}

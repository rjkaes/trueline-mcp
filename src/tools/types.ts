/** Return type for all tool handlers, compatible with the MCP SDK's CallToolResult. */
export interface ToolResult {
  // Index signature required by MCP SDK's CallToolResult type
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

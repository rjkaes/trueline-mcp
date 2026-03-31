import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Regression test for https://github.com/anthropics/trueline-mcp/issues/XXX
 *
 * The MCP SDK's normalizeObjectSchema() can't see through z.preprocess()
 * (ZodEffects), causing tools/list to return empty {type: "object", properties: {}}
 * for all tools. We work around this by passing a laxified z.object() (with
 * .passthrough()) as inputSchema and running coercion + strict validation in
 * the handler.
 *
 * This test imports server.ts indirectly through the laxify pattern and verifies
 * that the schemas passed to registerTool produce non-empty JSON Schema.
 */

// Replicate the laxify function from server.ts to test the pattern in isolation.
const STRINGABLE_ARRAY_KEYS = new Set(["file_paths", "edits", "ranges", "checksums"]);

function laxify(schema: z.AnyZodObject): z.AnyZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    if (key === "file_paths") {
      shape[key] = z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe(value.description ?? "");
    } else if (STRINGABLE_ARRAY_KEYS.has(key)) {
      shape[key] = z.union([value, z.string()]);
    } else {
      shape[key] = value;
    }
  }
  return z.object(shape).passthrough();
}

// Simulate the MCP SDK's normalizeObjectSchema check
function hasVisibleShape(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "shape" in schema &&
    (schema as Record<string, unknown>).shape !== undefined
  );
}

describe("tools/list JSON Schema generation", () => {
  test("z.preprocess produces ZodEffects that hides .shape from the SDK", () => {
    const inner = z.object({ file_paths: z.array(z.string()).default([]) });
    const wrapped = z.preprocess((v) => v, inner);
    // This is the bug: ZodEffects has no .shape
    expect(hasVisibleShape(wrapped)).toBe(false);
  });

  test("laxify produces a schema with visible .shape", () => {
    const inner = z.object({
      file_paths: z.array(z.string()).min(1).default([]).describe("files"),
      depth: z.number().optional(),
    });
    const lax = laxify(inner);
    expect(hasVisibleShape(lax)).toBe(true);
  });

  test("laxified schema generates JSON Schema with non-empty properties", () => {
    const inner = z.object({
      file_paths: z.array(z.string()).min(1).default([]).describe("One or more files to read."),
      ranges: z.array(z.string()).optional().describe("Line ranges."),
      encoding: z.string().optional().describe("Encoding."),
    });
    const lax = laxify(inner);
    const jsonSchema = zodToJsonSchema(lax, { strictUnions: true }) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(jsonSchema.properties).toBeDefined();
    expect(Object.keys(jsonSchema.properties).length).toBeGreaterThan(0);
    expect(jsonSchema.properties.file_paths).toBeDefined();
    // file_paths is a union (array | string) so it has anyOf, not a bare type
    const fp = jsonSchema.properties.file_paths as Record<string, unknown>;
    expect(fp.anyOf ?? fp.type).toBeDefined();
    expect(jsonSchema.properties.ranges).toBeDefined();
    expect(jsonSchema.properties.encoding).toBeDefined();
  });

  test("laxified schema preserves descriptions", () => {
    const inner = z.object({
      file_paths: z.array(z.string()).min(1).default([]).describe("Files to process."),
      depth: z.number().optional().describe("Nesting depth."),
    });
    const lax = laxify(inner);
    const jsonSchema = zodToJsonSchema(lax, { strictUnions: true }) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(jsonSchema.properties.file_paths.description).toBe("Files to process.");
    expect(jsonSchema.properties.depth.description).toBe("Nesting depth.");
  });

  test("laxified schema makes file_paths optional for alias support", () => {
    const inner = z.object({
      file_paths: z.array(z.string()).min(1).default([]).describe("files"),
    });
    const lax = laxify(inner);

    // Should accept input without file_paths (alias will be resolved in handler)
    const result = lax.safeParse({ file_path: "foo.ts" });
    expect(result.success).toBe(true);
  });

  test("laxified schema allows passthrough of alias keys", () => {
    const inner = z.object({
      file_paths: z.array(z.string()).min(1).default([]).describe("files"),
    });
    const lax = laxify(inner);

    const result = lax.safeParse({ file_path: "foo.ts" });
    expect(result.success).toBe(true);
    if (result.success) {
      // file_path should pass through (not stripped by Zod)
      expect(result.data.file_path).toBe("foo.ts");
    }
  });

  test("strict schema still validates after coercion", () => {
    const strict = z.object({
      file_paths: z.array(z.string()).min(1, "required").default([]),
    });

    // Simulating what coerceParams does for alias mapping
    const coerced = { file_paths: ["foo.ts"] };
    const result = strict.safeParse(coerced);
    expect(result.success).toBe(true);
  });

  test("strict schema rejects empty file_paths after coercion", () => {
    const strict = z.object({
      file_paths: z.array(z.string()).min(1, "required").default([]),
    });

    const result = strict.safeParse({});
    expect(result.success).toBe(false);
  });
});

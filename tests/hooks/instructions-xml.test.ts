import { describe, expect, test } from "bun:test";
import { DOMParser } from "@xmldom/xmldom";
import { getInstructions } from "../../hooks/core/instructions.js";

// ==============================================================================
// XML Well-Formedness Tests
// ==============================================================================
//
// Validates that getInstructions() produces well-formed XML for every platform.
// This catches issues like missing closing tags (e.g. the </rules> bug in ede434b).

const PLATFORMS = ["claude-code", "gemini-cli", "vscode-copilot", "opencode", "codex"] as const;

function parseXml(xml: string): { errors: string[] } {
  const errors: string[] = [];
  const parser = new DOMParser({
    errorHandler: {
      error: (msg: string) => errors.push(msg),
      fatalError: (msg: string) => errors.push(msg),
    },
  });
  parser.parseFromString(xml, "text/xml");
  return { errors };
}

describe("instructions XML well-formedness", () => {
  for (const platform of PLATFORMS) {
    test(`${platform}: parses as valid XML`, () => {
      const xml = getInstructions(platform);
      const { errors } = parseXml(xml);
      expect(errors).toEqual([]);
    });
  }

  test("unknown platform falls back without XML errors", () => {
    const xml = getInstructions("unknown-platform");
    const { errors } = parseXml(xml);
    expect(errors).toEqual([]);
  });
});

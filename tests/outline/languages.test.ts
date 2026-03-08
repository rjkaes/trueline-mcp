import { describe, expect, test } from "bun:test";
import { getLanguageConfig } from "../../src/outline/languages.ts";

describe("LanguageConfig whitespace mode", () => {
  test("python uses preserve-indent", () => {
    const config = getLanguageConfig(".py");
    expect(config?.whitespaceMode).toBe("preserve-indent");
  });

  test("typescript uses collapse (default)", () => {
    const config = getLanguageConfig(".ts");
    expect(config?.whitespaceMode ?? "collapse").toBe("collapse");
  });
});

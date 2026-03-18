import { describe, it, expect } from "vitest";
import { extractPlaceholders, validatePlaceholders } from "../placeholder.js";

describe("extractPlaceholders", () => {
  it("extracts {{variable}} placeholders", () => {
    expect(
      extractPlaceholders("Hello {{name}}, you have {{count}} items")
    ).toEqual(["{{name}}", "{{count}}"]);
  });

  it("extracts {0} style placeholders", () => {
    expect(extractPlaceholders("Hello {0}, welcome to {1}")).toEqual([
      "{0}",
      "{1}",
    ]);
  });

  it("extracts %s and %d", () => {
    expect(extractPlaceholders("Hello %s, you have %d items")).toEqual([
      "%s",
      "%d",
    ]);
  });

  it("returns empty for no placeholders", () => {
    expect(extractPlaceholders("Hello world")).toEqual([]);
  });
});

describe("validatePlaceholders", () => {
  it("returns no warnings when all placeholders preserved", () => {
    expect(
      validatePlaceholders("Hello {{name}}", "Hej {{name}}", "greeting")
    ).toEqual([]);
  });

  it("returns warning when placeholder missing", () => {
    const warnings = validatePlaceholders("Hello {{name}}", "Hej", "greeting");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("{{name}}");
    expect(warnings[0]).toContain("greeting");
  });

  it("returns warning for each missing placeholder", () => {
    const warnings = validatePlaceholders(
      "{{a}} and {{b}}",
      "translated",
      "key"
    );
    expect(warnings).toHaveLength(2);
  });
});

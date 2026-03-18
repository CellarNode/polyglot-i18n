import { describe, it, expect } from "vitest";
import { buildPrompt, parseGeminiResponse } from "../../providers/gemini.js";

describe("buildPrompt", () => {
  it("includes target language", () => {
    const prompt = buildPrompt(
      [{ key: "save", value: "Save" }],
      "sv",
      undefined
    );
    expect(prompt).toContain("Swedish");
    expect(prompt).toContain("sv");
  });

  it("includes JSON content", () => {
    const prompt = buildPrompt(
      [{ key: "save", value: "Save" }],
      "fr",
      undefined
    );
    expect(prompt).toContain('"save"');
    expect(prompt).toContain('"Save"');
  });

  it("includes context when provided", () => {
    const prompt = buildPrompt(
      [{ key: "save", value: "Save" }],
      "de",
      "Beverage industry"
    );
    expect(prompt).toContain("Beverage industry");
  });
});

describe("parseGeminiResponse", () => {
  it("parses valid JSON response", () => {
    const response = '{"save": "Spara", "cancel": "Avbryt"}';
    const entries = parseGeminiResponse(response, [
      { key: "save", value: "Save" },
      { key: "cancel", value: "Cancel" },
    ]);
    expect(entries).toEqual([
      { key: "save", value: "Spara" },
      { key: "cancel", value: "Avbryt" },
    ]);
  });

  it("strips markdown fences from response", () => {
    const response = '```json\n{"save": "Spara"}\n```';
    const entries = parseGeminiResponse(response, [
      { key: "save", value: "Save" },
    ]);
    expect(entries[0].value).toBe("Spara");
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseGeminiResponse("not json", [{ key: "save", value: "Save" }])
    ).toThrow();
  });
});

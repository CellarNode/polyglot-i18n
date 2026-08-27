import { describe, it, expect } from "vitest";
import { buildPrompt, parseGeminiResponse } from "../../providers/gemini.js";
import type { TranslationEntry } from "../../providers/types.js";

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

const RU_PLURAL_ENTRY: TranslationEntry = {
  key: "item_other",
  value: "{{count}} items",
  plural: {
    base: "item",
    sourceForms: { one: "{{count}} item", other: "{{count}} items" },
    targetCategories: ["one", "few", "many", "other"],
  },
};

describe("plural expansion (CEL-1267)", () => {
  it("asks for every category the target language needs", () => {
    const prompt = buildPrompt([RU_PLURAL_ENTRY], "ru");

    // Both English forms are shown...
    expect(prompt).toContain('"item_one"');
    expect(prompt).toContain('"item_other"');
    // ...and the categories English lacks are explicitly requested.
    expect(prompt).toContain("Plural forms required");
    expect(prompt).toContain("item_one, item_few, item_many, item_other");
  });

  it("adds no plural section when the target needs no extra categories", () => {
    const prompt = buildPrompt(
      [
        {
          key: "item_other",
          value: "{{count}} items",
          plural: {
            base: "item",
            sourceForms: { one: "{{count}} item", other: "{{count}} items" },
            targetCategories: ["one", "other"],
          },
        },
      ],
      "sv"
    );
    expect(prompt).not.toContain("Plural forms required");
  });

  it("accepts the expanded key set the model returns", () => {
    const response = JSON.stringify({
      item_one: "{{count}} товар",
      item_few: "{{count}} товара",
      item_many: "{{count}} товаров",
      item_other: "{{count}} товара",
    });

    expect(parseGeminiResponse(response, [RU_PLURAL_ENTRY])).toEqual([
      { key: "item_one", value: "{{count}} товар" },
      { key: "item_few", value: "{{count}} товара" },
      { key: "item_many", value: "{{count}} товаров" },
      { key: "item_other", value: "{{count}} товара" },
    ]);
  });

  it("falls back to the translated _other form for a category the model skipped", () => {
    const response = JSON.stringify({
      item_one: "{{count}} товар",
      item_other: "{{count}} товара",
    });

    const parsed = parseGeminiResponse(response, [RU_PLURAL_ENTRY]);
    expect(parsed.map((e) => e.key)).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    // Never leaks English when the model produced a usable target form.
    expect(parsed[1].value).toBe("{{count}} товара");
    expect(parsed[2].value).toBe("{{count}} товара");
  });

  it("still returns one entry per key for non-plural entries", () => {
    expect(
      parseGeminiResponse('{"save": "Сохранить"}', [
        { key: "save", value: "Save" },
      ])
    ).toEqual([{ key: "save", value: "Сохранить" }]);
  });
});

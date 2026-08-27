import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  parseGeminiResponse,
  SYSTEM_PROMPT,
} from "../../providers/gemini.js";
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

  it("adds no plural block to a request without plural groups", () => {
    const prompt = buildPrompt([{ key: "save", value: "Save" }], "ru");
    expect(prompt).not.toContain("Plural rules for this request");
  });
});

describe("parseGeminiResponse", () => {
  it("parses valid JSON response", () => {
    const response = '{"save": "Spara", "cancel": "Avbryt"}';
    const { entries } = parseGeminiResponse(response, [
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
    const { entries } = parseGeminiResponse(response, [
      { key: "save", value: "Save" },
    ]);
    expect(entries[0].value).toBe("Spara");
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseGeminiResponse("not json", [{ key: "save", value: "Save" }])
    ).toThrow();
  });

  it("reads a nested response instead of falling back to English", () => {
    // The request uses flat dotted keys; a model that nests them used to make
    // every key resolve to `undefined` and get backfilled with English.
    const response = '{"card": {"beverage": "产品"}}';
    const { entries, unresolved } = parseGeminiResponse(response, [
      { key: "card.beverage", value: "Product" },
    ]);
    expect(entries).toEqual([{ key: "card.beverage", value: "产品" }]);
    expect(unresolved.size).toBe(0);
  });

  it("never substitutes the English source for a key the model dropped", () => {
    const { entries, unresolved } = parseGeminiResponse('{"save": "Spara"}', [
      { key: "save", value: "Save" },
      { key: "cancel", value: "Cancel" },
    ]);
    expect(entries).toEqual([{ key: "save", value: "Spara" }]);
    expect([...unresolved]).toEqual(["cancel"]);
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

  it("adds no 'Plural forms required' section when the target needs no extra categories", () => {
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

    const { entries, filledFromOther } = parseGeminiResponse(response, [
      RU_PLURAL_ENTRY,
    ]);
    expect(entries).toEqual([
      { key: "item_one", value: "{{count}} товар" },
      { key: "item_few", value: "{{count}} товара" },
      { key: "item_many", value: "{{count}} товаров" },
      { key: "item_other", value: "{{count}} товара" },
    ]);
    expect(filledFromOther.size).toBe(0);
  });

  it("fills a skipped category from the translated _other form and records it", () => {
    const response = JSON.stringify({
      item_one: "{{count}} товар",
      item_other: "{{count}} товара",
    });

    const { entries, filledFromOther } = parseGeminiResponse(response, [
      RU_PLURAL_ENTRY,
    ]);
    expect(entries.map((e) => e.key)).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    // Never leaks English when the model produced a usable target form...
    expect(entries[1].value).toBe("{{count}} товара");
    expect(entries[2].value).toBe("{{count}} товара");
    // ...but the copy is recorded so the guard can see the categories were
    // not actually differentiated (CEL-1539).
    expect([...filledFromOther].sort()).toEqual(["item_few", "item_many"]);
  });

  it("leaves a category unresolved when the model returned no _other either", () => {
    const { entries, unresolved } = parseGeminiResponse(
      JSON.stringify({ item_one: "{{count}} товар" }),
      [RU_PLURAL_ENTRY]
    );
    expect(entries).toEqual([{ key: "item_one", value: "{{count}} товар" }]);
    expect([...unresolved].sort()).toEqual([
      "item_few",
      "item_many",
      "item_other",
    ]);
  });

  it("still returns one entry per key for non-plural entries", () => {
    expect(
      parseGeminiResponse('{"save": "Сохранить"}', [
        { key: "save", value: "Save" },
      ]).entries
    ).toEqual([{ key: "save", value: "Сохранить" }]);
  });

  /**
   * CEL-1542, P3.
   *
   * `detectLeaks` dedups per key: a category already reported by `checkValue`
   * or by `filledFromOther` is not reported a second time by the uniform-plural
   * check. That dedup is cache-safe only because `_other` can never appear in
   * `filledFromOther` — if it could, the `accept` disposition it carries would
   * suppress the `prefer-previous` uniform suspect on that one key, and the
   * group would be half-cached. The invariant lives here, in the only code that
   * writes the set, so pin it here.
   */
  describe("filledFromOther never contains the _other key itself", () => {
    it("does not backfill _other from itself when the model omitted it", () => {
      const { filledFromOther, unresolved } = parseGeminiResponse(
        JSON.stringify({ item_one: "{{count}} товар" }),
        [RU_PLURAL_ENTRY]
      );
      expect(filledFromOther.has("item_other")).toBe(false);
      // It is unresolved instead, so the guard fails it rather than papering
      // over it.
      expect(unresolved.has("item_other")).toBe(true);
    });

    it("does not record _other when the model DID return it", () => {
      const { filledFromOther } = parseGeminiResponse(
        JSON.stringify({
          item_one: "{{count}} товар",
          item_other: "{{count}} товара",
        }),
        [RU_PLURAL_ENTRY]
      );
      // The other two categories are recorded — so the set is not simply empty.
      expect([...filledFromOther].sort()).toEqual(["item_few", "item_many"]);
      expect(filledFromOther.has("item_other")).toBe(false);
    });

    it("records nothing at all when _other is unusable", () => {
      const { filledFromOther } = parseGeminiResponse(
        JSON.stringify({ item_one: "{{count}} товар", item_other: "   " }),
        [RU_PLURAL_ENTRY]
      );
      expect([...filledFromOther]).toEqual([]);
    });
  });
});

describe("prompt hardening against English leaks (CEL-1539)", () => {
  it("tells the model that every value must be fully in the target language", () => {
    expect(SYSTEM_PROMPT).toContain(
      "EVERY value you return must be written entirely in the target language"
    );
    expect(SYSTEM_PROMPT).toContain(
      'Ordinary nouns like "product", "option" or "listing" are never'
    );
    expect(SYSTEM_PROMPT).toContain("key is a defect; there is no fallback");
    expect(SYSTEM_PROMPT).toContain(
      "Plural categories must DIFFER wherever the target language's grammar differs"
    );
    expect(SYSTEM_PROMPT).toContain("never expanded into nested objects");
  });

  it("repeats both requirements in the grouped-plural block", () => {
    const prompt = buildPrompt([RU_PLURAL_ENTRY], "ru", "Beverage industry");

    expect(prompt).toContain(
      "Plural rules for this request (Russian, categories: one, few, many, other)"
    );
    expect(prompt).toContain("Translate EVERY plural value fully into Russian");
    expect(prompt).toContain(
      'Copying an English word such as "product", "option" or "listing" into any value is a defect'
    );
    expect(prompt).toContain(
      "Repeat identical text across categories ONLY when Russian genuinely uses one form for them"
    );
    expect(prompt).toContain("A missing key is not backfilled — it is dropped");
    // Context passthrough is unchanged.
    expect(prompt).toContain("Context: Beverage industry");
  });

  it("hardens the zh path too, where the union adds a category zh lacks", () => {
    const prompt = buildPrompt(
      [
        {
          key: "card.beverage_other",
          value: "Products",
          plural: {
            base: "card.beverage",
            sourceForms: { one: "Product", other: "Products" },
            targetCategories: ["one", "other"],
          },
        },
      ],
      "zh"
    );
    // No extra categories are needed, so the old prompt said nothing at all —
    // which is the path that leaked "Product" into 13 zh keys.
    expect(prompt).not.toContain("Plural forms required");
    expect(prompt).toContain(
      "Plural rules for this request (Chinese (Simplified), categories: one, other)"
    );
  });

  it("matches the recorded system prompt", () => {
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });

  it("matches the recorded grouped-plural prompt", () => {
    expect(buildPrompt([RU_PLURAL_ENTRY], "ru", "Beverage industry")).toMatchSnapshot();
  });
});

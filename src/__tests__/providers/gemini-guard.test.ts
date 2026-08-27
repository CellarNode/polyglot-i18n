import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Direct tests for the production guard wiring in `GeminiProvider.translate`
 * (CEL-1539 review, P1).
 *
 * The first cut of this PR tested `detectLeaks`, `buildCorrectiveInstruction`
 * and `markFailed` in isolation but never constructed the provider — deleting
 * the entire guard block from `translate()` left the suite green while the
 * 0.3.0 leak shipped again. Every test in this file drives the real
 * `GeminiProvider` against a mocked `@google/genai`, so removing the
 * `detectLeaks` call, the corrective retry or the disposition handling turns
 * the suite red.
 */

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { GeminiProvider } = await import("../../providers/gemini.js");
const { translateNamespace } = await import("../../translate.js");
import type { TranslationEntry } from "../../providers/types.js";

/** Queues raw model responses, one per `generateContent` call. */
function respondWith(...responses: string[]): void {
  generateContent.mockReset();
  for (const text of responses) {
    generateContent.mockResolvedValueOnce({ text });
  }
  generateContent.mockResolvedValue({ text: responses[responses.length - 1] });
}

const provider = () => new GeminiProvider("test-key");

const ZH_BEVERAGE: TranslationEntry = {
  key: "card.beverage_other",
  value: "Products",
  plural: {
    base: "card.beverage",
    sourceForms: { one: "Product", other: "Products" },
    targetCategories: ["one", "other"],
  },
};

const RU_ITEM: TranslationEntry = {
  key: "item_other",
  value: "{{count}} products",
  plural: {
    base: "item",
    sourceForms: { one: "{{count}} product", other: "{{count}} products" },
    targetCategories: ["one", "few", "many", "other"],
  },
};

const byKey = (entries: TranslationEntry[]) =>
  Object.fromEntries(entries.map((e) => [e.key, e]));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GeminiProvider.translate — clean output", () => {
  it("returns the first pass untouched and makes exactly one API call", async () => {
    respondWith(
      JSON.stringify({ "card.beverage_one": "产品", "card.beverage_other": "产品" })
    );

    const result = await provider().translate([ZH_BEVERAGE], "zh");

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { key: "card.beverage_one", value: "产品" },
      { key: "card.beverage_other", value: "产品" },
    ]);
    expect(result.every((e) => e.failed === undefined)).toBe(true);
    expect(result.every((e) => e.degraded === undefined)).toBe(true);
  });
});

describe("GeminiProvider.translate — corrective retry", () => {
  it("retries a leaking chunk and returns the corrected values", async () => {
    respondWith(
      JSON.stringify({
        "card.beverage_one": "Product 产品",
        "card.beverage_other": "产品",
      }),
      JSON.stringify({ "card.beverage_one": "产品", "card.beverage_other": "产品" })
    );

    const result = await provider().translate([ZH_BEVERAGE], "zh");

    expect(generateContent).toHaveBeenCalledTimes(2);
    // The correction names the offending key and its problem.
    const corrective = generateContent.mock.calls[1][0].contents as string;
    expect(corrective).toContain("Your previous answer was rejected");
    expect(corrective).toContain("card.beverage_one");
    expect(byKey(result)["card.beverage_one"]).toEqual({
      key: "card.beverage_one",
      value: "产品",
    });
    expect(result.every((e) => e.failed === undefined)).toBe(true);
  });

  it("marks a key that is still leaking after the retry as failed", async () => {
    const leaking = JSON.stringify({
      "card.beverage_one": "Product 产品",
      "card.beverage_other": "产品",
    });
    respondWith(leaking, leaking);

    const result = await provider().translate([ZH_BEVERAGE], "zh");

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(byKey(result)["card.beverage_one"].failed).toMatchObject({
      reason: "source-echo",
    });
    expect(byKey(result)["card.beverage_other"].failed).toBeUndefined();
  });

  it("never spends a retry on a warn-only chunk", async () => {
    // ru genuinely uses `many`, and the model returned no form for it, so the
    // parser copies `_other`. Usable — a second API call could only lose keys.
    respondWith(
      JSON.stringify({
        item_one: "{{count}} товар",
        item_few: "{{count}} товара",
        item_other: "{{count}} товаров",
      })
    );

    const result = await provider().translate([RU_ITEM], "ru");

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.map((e) => e.key)).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    expect(result.every((e) => e.failed === undefined)).toBe(true);
  });

  it("merges the retry per key instead of replacing the chunk", async () => {
    respondWith(
      JSON.stringify({
        save: "保存",
        "card.beverage_one": "Product 产品",
        "card.beverage_other": "产品",
      }),
      // The retry fixed the leak but dropped a key that was already correct.
      JSON.stringify({
        "card.beverage_one": "产品",
        "card.beverage_other": "产品",
      })
    );

    const result = await provider().translate(
      [{ key: "save", value: "Save" }, ZH_BEVERAGE],
      "zh"
    );

    const map = byKey(result);
    expect(map["card.beverage_one"].value).toBe("产品");
    // Wholesale replacement lost `save` and turned a good value into a failure.
    expect(map.save).toEqual({ key: "save", value: "保存" });
  });

  it("keeps the first pass when the retry returns garbage", async () => {
    respondWith(
      JSON.stringify({
        save: "保存",
        "card.beverage_one": "Product 产品",
        "card.beverage_other": "产品",
      }),
      "I'm sorry, I can't help with that."
    );

    // A throw here would escape into the chunk-failure path, which knows
    // nothing about the suspects and writes English.
    const result = await provider().translate(
      [{ key: "save", value: "Save" }, ZH_BEVERAGE],
      "zh"
    );

    const map = byKey(result);
    expect(map.save).toEqual({ key: "save", value: "保存" });
    expect(map["card.beverage_one"].failed).toMatchObject({
      reason: "source-echo",
    });
  });
});

describe("GeminiProvider.translate — byte-identical values", () => {
  it("degrades rather than fails a value that is the English source", async () => {
    const identical = JSON.stringify({
      "card.beverage_one": "Product",
      "card.beverage_other": "产品",
    });
    respondWith(identical, identical);

    const result = await provider().translate([ZH_BEVERAGE], "zh");

    expect(generateContent).toHaveBeenCalledTimes(2);
    const entry = byKey(result)["card.beverage_one"];
    // Writable, so `translateNamespace` can prefer the previous translation —
    // and a legitimate identical value never exits the CLI non-zero.
    expect(entry.failed).toBeUndefined();
    expect(entry.degraded).toMatchObject({ reason: "identical-to-source" });
    expect(entry.value).toBe("Product");
  });

  it("warns about a brand-only identical value without re-rolling the chunk", async () => {
    respondWith(JSON.stringify({ retailer: "Systembolaget" }));

    const result = await provider().translate(
      [{ key: "retailer", value: "Systembolaget" }],
      "zh"
    );

    // A single Titlecase word at a sentence start carries no proper-noun
    // signal, so the guard cannot know this is a retailer rather than English.
    // It says so instead of guessing — but it is a `warn`, so it costs no
    // second API call, and `prefer-previous`, so it never fails the CLI.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        key: "retailer",
        value: "Systembolaget",
        degraded: {
          reason: "identical-to-source",
          detail: "value is the English source verbatim",
        },
      },
    ]);
    expect(result[0].failed).toBeUndefined();
  });
});

/**
 * The whole chain, end to end: `GeminiProvider` → `detectLeaks` →
 * `applySuspects` → `translateNamespace` → the cache it writes back.
 *
 * This is the assertion the round-2 guard could not make. A byte-identical
 * value whose words are outside `TRANSLATABLE_WORDS` was written to the locale
 * file AND cached, so the next run skipped it forever (review round 3, P1a).
 */
describe("byte-identical output reaches the cache decision", () => {
  it("writes a byte-identical correct value, warns, and does NOT cache it", async () => {
    respondWith(JSON.stringify({ "brand.retailer": "Systembolaget" }));

    const result = await translateNamespace({
      sourceFlat: { "brand.retailer": "Systembolaget" },
      targetFlat: {},
      cacheEntries: {},
      provider: provider(),
      targetLang: "zh",
      force: false,
    });

    // Correct value, kept.
    expect(result.output["brand.retailer"]).toBe("Systembolaget");
    // Never a failure — the CLI exits non-zero on `failed > 0`.
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    // Not silent.
    expect(result.warnings.join("\n")).toContain("identical-to-source");
    // Not cached: the next run asks again instead of skipping it forever.
    expect("brand.retailer" in result.newCacheEntries).toBe(false);
  });

  it("does the same for English the vocabulary list cannot see", async () => {
    respondWith(JSON.stringify({ "nav.overview": "Producer dashboard" }));

    const result = await translateNamespace({
      sourceFlat: { "nav.overview": "Producer dashboard" },
      targetFlat: {},
      cacheEntries: {},
      provider: provider(),
      targetLang: "zh",
      force: false,
    });

    expect(result.failed).toBe(0);
    expect(result.warnings.join("\n")).toContain("identical-to-source");
    expect("nav.overview" in result.newCacheEntries).toBe(false);
  });

  it("keeps the previous translation over the identical value when there is one", async () => {
    respondWith(JSON.stringify({ "nav.overview": "Producer dashboard" }));

    const result = await translateNamespace({
      sourceFlat: { "nav.overview": "Producer dashboard" },
      targetFlat: { "nav.overview": "生产商仪表板" },
      cacheEntries: {},
      provider: provider(),
      targetLang: "zh",
      force: true,
    });

    expect(result.output["nav.overview"]).toBe("生产商仪表板");
    expect(result.failed).toBe(0);
    expect("nav.overview" in result.newCacheEntries).toBe(false);
  });
});

describe("GeminiProvider.translate — missing and uniform values", () => {
  it("fails a key the model never returned instead of writing English", async () => {
    const partial = JSON.stringify({ save: "保存" });
    respondWith(partial, partial);

    const result = await provider().translate(
      [
        { key: "save", value: "Save" },
        { key: "cancel", value: "Cancel" },
      ],
      "zh"
    );

    const map = byKey(result);
    expect(map.save).toEqual({ key: "save", value: "保存" });
    expect(map.cancel.failed).toMatchObject({ reason: "no-target-form" });
  });

  it("degrades — never fails — a ru plural group that came back byte-identical", async () => {
    const uniform = JSON.stringify({
      item_one: "{{count}} товара",
      item_few: "{{count}} товара",
      item_many: "{{count}} товара",
      item_other: "{{count}} товара",
    });
    respondWith(uniform, uniform);

    const result = await provider().translate([RU_ITEM], "ru");

    // Still worth the one corrective retry — "differentiate the categories" is
    // an instruction the model can act on.
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(4);
    expect(result.every((e) => e.failed === undefined)).toBe(true);
    expect(
      result.every((e) => e.degraded?.reason === "uniform-plural")
    ).toBe(true);
  });

  it("keeps a uniform ru group out of the cache without failing the run", async () => {
    // "{{count}} мл" is correct Russian for all four categories — unit
    // abbreviations do not inflect — so no retry can produce anything else.
    // Blocking it exited the CLI non-zero on every run, forever.
    const uniform = JSON.stringify({
      "volume.ml_one": "{{count}} мл",
      "volume.ml_few": "{{count}} мл",
      "volume.ml_many": "{{count}} мл",
      "volume.ml_other": "{{count}} мл",
    });
    respondWith(uniform, uniform);

    const result = await translateNamespace({
      sourceFlat: { "volume.ml_other": "{{count}} ml" },
      targetFlat: {},
      cacheEntries: {},
      provider: provider(),
      targetLang: "ru",
      force: false,
    });

    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.output["volume.ml_many"]).toBe("{{count}} мл");
    expect(result.warnings.join("\n")).toContain("uniform-plural");
    expect(Object.keys(result.newCacheEntries)).toEqual([]);
  });
});

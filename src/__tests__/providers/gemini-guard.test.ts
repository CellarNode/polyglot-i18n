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

  it("leaves a brand-only identical value completely alone", async () => {
    respondWith(JSON.stringify({ retailer: "Systembolaget" }));

    const result = await provider().translate(
      [{ key: "retailer", value: "Systembolaget" }],
      "zh"
    );

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ key: "retailer", value: "Systembolaget" }]);
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

  it("fails a ru plural group whose categories came back byte-identical", async () => {
    const uniform = JSON.stringify({
      item_one: "{{count}} товара",
      item_few: "{{count}} товара",
      item_many: "{{count}} товара",
      item_other: "{{count}} товара",
    });
    respondWith(uniform, uniform);

    const result = await provider().translate([RU_ITEM], "ru");

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(4);
    expect(
      result.every((e) => e.failed?.reason === "uniform-plural")
    ).toBe(true);
  });
});

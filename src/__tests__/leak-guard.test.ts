import { describe, it, expect } from "vitest";
import {
  detectLeaks,
  findSourceEchoTokens,
  usesNonLatinScript,
} from "../leak-guard.js";
import type { TranslationEntry } from "../providers/types.js";

/**
 * Fixtures reproduce the shapes observed in production run 33088731240
 * (CEL-1539): raw English spliced into non-Latin locales, and Russian plural
 * groups whose categories came back byte-identical.
 */

const ZH_BEVERAGE: TranslationEntry = {
  key: "card.beverage_other",
  value: "Products",
  plural: {
    base: "card.beverage",
    sourceForms: { one: "Product", other: "Products" },
    // zh has only `other`; `one` survives from the English source (union).
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

function entries(map: Record<string, string>): TranslationEntry[] {
  return Object.entries(map).map(([key, value]) => ({ key, value }));
}

describe("usesNonLatinScript", () => {
  it("recognises the non-Latin targets in the CellarNode locale set", () => {
    expect(usesNonLatinScript("zh")).toBe(true);
    expect(usesNonLatinScript("ru")).toBe(true);
    expect(usesNonLatinScript("zh-Hant")).toBe(true);
  });

  it("leaves Latin-script targets out of the echo check", () => {
    for (const lang of ["fr", "de", "it", "es", "sv", "en"]) {
      expect(usesNonLatinScript(lang)).toBe(false);
    }
  });
});

describe("findSourceEchoTokens", () => {
  it("catches an English noun spliced into a Chinese value", () => {
    expect(findSourceEchoTokens("Products", "Product")).toEqual(["Product"]);
  });

  it("catches a leak mid-sentence, matching across the plural stem", () => {
    expect(
      findSourceEchoTokens("{{count}} products found", "找到 {{count}} product")
    ).toEqual(["product"]);
  });

  it("ignores placeholders, HTML and URLs", () => {
    expect(
      findSourceEchoTokens(
        '{{count}} items — <a href="https://cellarnode.com/help">help</a>',
        '{{count}} 项 — <a href="https://cellarnode.com/help">帮助</a>'
      )
    ).toEqual([]);
  });

  it("ignores brand names and acronyms, which are meant to survive", () => {
    expect(
      findSourceEchoTokens("Upload a PDF to CellarNode", "上传 PDF 到 CellarNode")
    ).toEqual([]);
    expect(findSourceEchoTokens("Scan the QR code", "扫描 QR 码")).toEqual([]);
  });

  it("does not treat a Titlecase common noun as a brand", () => {
    expect(findSourceEchoTokens("Product options", "Product 选项")).toContain(
      "Product"
    );
  });

  it("ignores English words that are not in the source", () => {
    expect(findSourceEchoTokens("Save", "保存 ok")).toEqual([]);
  });
});

describe("detectLeaks — English leak (CEL-1539)", () => {
  it("flags the zh 'Product' echo that regressed card.beverage", () => {
    const suspects = detectLeaks(
      [ZH_BEVERAGE],
      entries({
        "card.beverage_one": "Product",
        "card.beverage_other": "产品",
      }),
      "zh"
    );

    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({
      key: "card.beverage_one",
      reason: "source-echo",
      severity: "fail",
    });
    expect(suspects[0].detail).toContain('"Product"');
  });

  it("accepts a fully translated zh group", () => {
    expect(
      detectLeaks(
        [ZH_BEVERAGE],
        entries({
          "card.beverage_one": "产品",
          "card.beverage_other": "产品",
        }),
        "zh"
      )
    ).toEqual([]);
  });

  it("flags a key the model never returned instead of writing English", () => {
    const suspects = detectLeaks(
      [ZH_BEVERAGE],
      entries({ "card.beverage_other": "产品" }),
      "zh"
    );

    expect(suspects).toEqual([
      expect.objectContaining({
        key: "card.beverage_one",
        reason: "no-target-form",
        severity: "fail",
      }),
    ]);
  });

  it("flags an empty value the same way", () => {
    const suspects = detectLeaks(
      entries({ save: "Save" }),
      entries({ save: "   " }),
      "ru"
    );
    expect(suspects[0].reason).toBe("no-target-form");
  });

  it("flags a leak on a plain non-plural key too", () => {
    const suspects = detectLeaks(
      entries({ "filter.listing": "Listing filter" }),
      entries({ "filter.listing": "listing 筛选器" }),
      "zh"
    );
    expect(suspects[0]).toMatchObject({
      key: "filter.listing",
      reason: "source-echo",
    });
  });

  it("does not run the echo check on Latin-script targets", () => {
    // Documented scope limit: "product" is indistinguishable from a French
    // loanword, so the prompt — not the guard — protects fr/de/it/es/sv.
    expect(
      detectLeaks(
        entries({ "filter.listing": "Listing filter" }),
        entries({ "filter.listing": "Filtre de listing" }),
        "fr"
      )
    ).toEqual([]);
  });
});

describe("detectLeaks — plural under-differentiation (CEL-1539)", () => {
  it("flags a ru group whose four categories are byte-identical", () => {
    const suspects = detectLeaks(
      [RU_ITEM],
      entries({
        item_one: "{{count}} товара",
        item_few: "{{count}} товара",
        item_many: "{{count}} товара",
        item_other: "{{count}} товара",
      }),
      "ru"
    );

    expect(suspects.map((s) => s.key)).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    expect(suspects.every((s) => s.reason === "uniform-plural")).toBe(true);
    expect(suspects.every((s) => s.severity === "fail")).toBe(true);
  });

  it("accepts a ru group that differentiates its categories", () => {
    expect(
      detectLeaks(
        [RU_ITEM],
        entries({
          item_one: "{{count}} товар",
          item_few: "{{count}} товара",
          item_many: "{{count}} товаров",
          item_other: "{{count}} товара",
        }),
        "ru"
      )
    ).toEqual([]);
  });

  it("does not flag identical categories when English does not differentiate", () => {
    const uninflected: TranslationEntry = {
      key: "items_other",
      value: "Items",
      plural: {
        base: "items",
        sourceForms: { one: "Items", other: "Items" },
        targetCategories: ["one", "few", "many", "other"],
      },
    };

    expect(
      detectLeaks(
        [uninflected],
        entries({
          items_one: "Позиции",
          items_few: "Позиции",
          items_many: "Позиции",
          items_other: "Позиции",
        }),
        "ru"
      )
    ).toEqual([]);
  });

  it("does not flag identical categories in a two-category language", () => {
    const svItem: TranslationEntry = {
      ...RU_ITEM,
      plural: { ...RU_ITEM.plural!, targetCategories: ["one", "other"] },
    };

    expect(
      detectLeaks(
        [svItem],
        entries({
          item_one: "{{count}} varor",
          item_other: "{{count}} varor",
        }),
        "sv"
      )
    ).toEqual([]);
  });

  it("warns — but does not fail — when a needed category was copied from _other", () => {
    const suspects = detectLeaks(
      [RU_ITEM],
      entries({
        item_one: "{{count}} товар",
        item_few: "{{count}} товара",
        item_many: "{{count}} товара",
        item_other: "{{count}} товара",
      }),
      "ru",
      new Set(["item_many"])
    );

    expect(suspects).toEqual([
      expect.objectContaining({
        key: "item_many",
        reason: "undifferentiated-category",
        severity: "warn",
      }),
    ]);
  });

  it("ignores a copy into a category the language does not use itself", () => {
    // zh has no `one` of its own — filling it from `_other` is correct.
    expect(
      detectLeaks(
        [ZH_BEVERAGE],
        entries({
          "card.beverage_one": "产品",
          "card.beverage_other": "产品",
        }),
        "zh",
        new Set(["card.beverage_one"])
      )
    ).toEqual([]);
  });
});

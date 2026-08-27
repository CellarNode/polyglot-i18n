import { describe, it, expect } from "vitest";
import {
  detectLeaks,
  findSourceEchoTokens,
  usesNonLatinScript,
  type LeakSuspect,
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

  it("flags a sentence-initial Titlecase common noun", () => {
    // "Product" starts the source sentence, so its capital carries no proper-
    // noun signal — this is the exact shape CEL-1539 leaked.
    expect(findSourceEchoTokens("Product options", "Product 选项")).toContain(
      "Product"
    );
  });

  it("ignores English words that are not in the source", () => {
    expect(findSourceEchoTokens("Save", "保存 ok")).toEqual([]);
  });

  it("never flags a Titlecase proper noun away from a sentence start", () => {
    // Grape varietals, producers and retailers are legitimate in every locale.
    expect(
      findSourceEchoTokens("e.g., Pinot Noir", "例如：黑皮诺 (Pinot Noir)")
    ).toEqual([]);
    expect(
      findSourceEchoTokens(
        "e.g., William Grant & Sons",
        "例如：William Grant & Sons"
      )
    ).toEqual([]);
    expect(findSourceEchoTokens("Add to Journey", "Добавить в Journey")).toEqual(
      []
    );
  });

  it("never flags a domain term or loanword a locale keeps on purpose", () => {    // Unknown words are assumed untranslatable; only ordinary UI vocabulary
    // can be reported. `Systembolaget` even starts its sentence.
    expect(
      findSourceEchoTokens(
        "Systembolaget generally runs blind tastings.",
        "Systembolaget 通常会进行盲测。"
      )
    ).toEqual([]);
    expect(
      findSourceEchoTokens("Enter your email", "Введите ваш email")
    ).toEqual([]);
    expect(findSourceEchoTokens("Create e-label", "Создать e-label")).toEqual(
      []
    );
    expect(findSourceEchoTokens("Logo uploaded", "Logo 已上传")).toEqual([]);
  });

  it("exempts an ordinary word that is part of a proper-noun phrase", () => {
    // The position rule, not the vocabulary list, is what saves this one:
    // "Label" IS ordinary UI vocabulary, and a wine tier called "Yellow Label"
    // is a proper noun in every locale. Drop the rule and the vocabulary list
    // starts failing brand names the moment a word is added to it.
    expect(
      findSourceEchoTokens(
        "e.g., Veuve Clicquot Yellow Label",
        "例如：Veuve Clicquot Yellow Label"
      )
    ).toEqual([]);
    // Same word, sentence-initial: no proper-noun signal, so it is a leak.
    expect(findSourceEchoTokens("Label printing", "Label 打印")).toEqual([
      "Label",
    ]);
  });

  it("never flags a value that has no translatable word at all", () => {
    expect(
      findSourceEchoTokens("qr-labels-{{count}}.zip", "qr-labels-{{count}}.zip")
    ).toEqual([]);
    expect(findSourceEchoTokens("TanStack Query", "TanStack Query")).toEqual([]);
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
    // The whole value IS the source, so it is retried but never blocked: the
    // previous zh translation is what saves it.
    expect(suspects[0]).toMatchObject({
      key: "card.beverage_one",
      reason: "identical-to-source",
      severity: "fail",
      disposition: "prefer-previous",
    });
    expect(suspects[0].detail).toContain('"Product"');
  });

  it("blocks a leak spliced into otherwise-translated text", () => {
    const suspects = detectLeaks(
      [ZH_BEVERAGE],
      entries({
        "card.beverage_one": "Product 产品",
        "card.beverage_other": "产品",
      }),
      "zh"
    );

    expect(suspects).toEqual([
      expect.objectContaining({
        key: "card.beverage_one",
        reason: "source-echo",
        severity: "fail",
        disposition: "block",
      }),
    ]);
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
        disposition: "block",
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
      disposition: "block",
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
    // Retried once, never blocked: uniformity alone is not evidence of English.
    expect(suspects.every((s) => s.disposition === "prefer-previous")).toBe(
      true
    );
  });

  it("flags a ru group whose English source is only `_other` but count-sensitive", () => {
    const bottleOtherOnly: TranslationEntry = {
      key: "bottle_other",
      value: "{{count}} bottles",
      plural: {
        base: "bottle",
        sourceForms: { other: "{{count}} bottles" },
        targetCategories: ["one", "few", "many", "other"],
      },
    };

    const suspects = detectLeaks(
      [bottleOtherOnly],
      entries({
        bottle_one: "{{count}} бутылок",
        bottle_few: "{{count}} бутылок",
        bottle_many: "{{count}} бутылок",
        bottle_other: "{{count}} бутылок",
      }),
      "ru"
    );

    expect(suspects).toHaveLength(4);
    expect(suspects.every((s) => s.reason === "uniform-plural")).toBe(true);
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

  it("does not flag identical categories when the English source is not count-sensitive", () => {
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

  it("resolves an ordinal group against ordinal CLDR rules, not cardinal ones", () => {
    // ru has four CARDINAL categories but exactly one ordinal category, so a
    // single repeated ordinal form is correct Russian. Reading the cardinal set
    // here failed every ru/pl/cs ordinal group.
    const ordinal: TranslationEntry = {
      key: "place_ordinal_other",
      value: "{{count}}th",
      plural: {
        base: "place_ordinal",
        sourceForms: {
          one: "{{count}}st",
          two: "{{count}}nd",
          few: "{{count}}rd",
          other: "{{count}}th",
        },
        targetCategories: ["one", "two", "few", "other"],
      },
    };

    expect(
      detectLeaks(
        [ordinal],
        entries({
          place_ordinal_one: "{{count}}-й",
          place_ordinal_two: "{{count}}-й",
          place_ordinal_few: "{{count}}-й",
          place_ordinal_other: "{{count}}-й",
        }),
        "ru"
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
        disposition: "accept",
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

describe("severity and disposition are independent", () => {
  const dispositionFor = (suspects: LeakSuspect[], key: string) =>
    suspects.find((s) => s.key === key)?.disposition;

  it("never blocks a byte-identical value, whatever the reason", () => {
    const suspects = detectLeaks(
      entries({ save: "Save" }),
      entries({ save: "Save" }),
      "ru"
    );
    expect(dispositionFor(suspects, "save")).toBe("prefer-previous");
    // Still `fail`, so it earns the one corrective retry.
    expect(suspects[0].severity).toBe("fail");
  });

  it("keeps every warn suspect out of the retry-triggering set", () => {
    const suspects = detectLeaks(
      [RU_ITEM],
      entries({
        item_one: "{{count}} товар",
        item_few: "{{count}} товара",
        item_many: "{{count}} товара",
        item_other: "{{count}} товаров",
      }),
      "ru",
      new Set(["item_many"])
    );
    expect(suspects.filter((s) => s.severity === "fail")).toEqual([]);
  });
});

/**
 * Review round 3, P1a.
 *
 * `TRANSLATABLE_WORDS` used to gate the identity check, so a byte-identical
 * English value made of words outside that list raised NO suspect: it was
 * written to the locale file and cached as translated, and no future run ever
 * retried it. Silent-and-cached is the one outcome this module must never
 * produce, so identity is now decided structurally and the vocabulary only
 * chooses how loudly to complain.
 */
describe("identical-to-source is independent of the vocabulary list", () => {
  /** Real CellarNode UI copy, none of it in `TRANSLATABLE_WORDS`. */
  const DOMAIN_ENGLISH = [
    "Producer dashboard",
    "Importer",
    "Distributor",
    "Vintage",
    "Winery",
    "Vineyard",
    "Grape variety",
    "Region",
    "Certificate",
    "Compliance",
    "Allergen",
    "Ingredient",
    "Nutrition",
    "Shipment",
    "Invoice",
    "Warehouse",
    "Inventory",
    "Overview",
    "Account",
    "Contract",
    "Terms",
    "Policy",
    "Plan",
    "Team",
    "Access",
  ];

  it("has no vocabulary signal for any of them — the anti-vacuity guard", () => {
    // The table below would pass for the wrong reason if these words were
    // simply added to the list, so pin the premise: the echo detector is blind
    // to every one of them, and the table still catches them.
    for (const source of DOMAIN_ENGLISH) {
      expect(findSourceEchoTokens(source, source), source).toEqual([]);
    }
  });

  it.each(DOMAIN_ENGLISH)(
    "reports verbatim English %j that the vocabulary cannot see",
    (source) => {
      const suspects = detectLeaks(
        entries({ k: source }),
        entries({ k: source }),
        "zh"
      );

      expect(suspects).toEqual([
        expect.objectContaining({
          key: "k",
          reason: "identical-to-source",
          // Uncorroborated, so it does not buy a second API call — but it is
          // degraded, which is what keeps it out of the cache.
          severity: "warn",
          disposition: "prefer-previous",
        }),
      ]);
    }
  );

  it("still earns the corrective retry when the vocabulary corroborates it", () => {
    const suspects = detectLeaks(
      entries({ save: "Save" }),
      entries({ save: "Save" }),
      "zh"
    );
    expect(suspects[0]).toMatchObject({
      reason: "identical-to-source",
      severity: "fail",
      disposition: "prefer-previous",
    });
  });

  it("stays silent for a source nothing could have translated", () => {
    const silent = (source: string, lang = "zh") =>
      detectLeaks(entries({ k: source }), entries({ k: source }), lang);

    // A filename template and a slug: one unbroken identifier once the
    // placeholder is removed.
    expect(silent("qr-labels-{{count}}.zip")).toEqual([]);
    expect(silent("cellarnode-admin")).toEqual([]);
    // A brand plus a Titlecase proper noun away from a sentence start.
    expect(silent("TanStack Query")).toEqual([]);
    expect(silent("e.g., Pinot Noir")).toEqual([]);
    // Nothing but a placeholder and an acronym.
    expect(silent("{{count}} PDF")).toEqual([]);
  });

  it("never blocks a byte-identical value, listed word or not", () => {
    for (const source of [...DOMAIN_ENGLISH, "Save", "Product options"]) {
      const suspects = detectLeaks(
        entries({ k: source }),
        entries({ k: source }),
        "ru"
      );
      expect(
        suspects.filter((s) => s.disposition === "block"),
        source
      ).toEqual([]);
    }
  });
});

/**
 * Review round 3, P1b.
 *
 * `block` is what turns the CLI non-zero and drops the key from the cache, so
 * it is reserved for values that demonstrably carry source-language text.
 * Uniformity across plural categories is not that: plenty of correct answers
 * are uniform, and no retry can produce a different one.
 */
describe("uniform plural groups degrade instead of blocking", () => {
  const RU_ML: TranslationEntry = {
    key: "volume.ml_other",
    value: "{{count}} ml",
    plural: {
      base: "volume.ml",
      sourceForms: { other: "{{count}} ml" },
      targetCategories: ["one", "few", "many", "other"],
    },
  };

  it("never blocks a uniform ru group that is correct by necessity", () => {
    // Russian unit abbreviations do not inflect: "{{count}} мл" is the right
    // answer for all four categories. Blocking it failed the job on every run
    // with no answer that could satisfy it.
    const suspects = detectLeaks(
      [RU_ML],
      entries({
        "volume.ml_one": "{{count}} мл",
        "volume.ml_few": "{{count}} мл",
        "volume.ml_many": "{{count}} мл",
        "volume.ml_other": "{{count}} мл",
      }),
      "ru"
    );

    expect(suspects).toHaveLength(4);
    expect(suspects.every((s) => s.reason === "uniform-plural")).toBe(true);
    expect(suspects.every((s) => s.disposition === "prefer-previous")).toBe(
      true
    );
    expect(suspects.filter((s) => s.disposition === "block")).toEqual([]);
  });

  it("never blocks a uniform group whose value is a filename", () => {
    const zip: TranslationEntry = {
      key: "bulkExport.filename_other",
      value: "qr-labels-{{count}}.zip",
      plural: {
        base: "bulkExport.filename",
        sourceForms: { other: "qr-labels-{{count}}.zip" },
        targetCategories: ["one", "few", "many", "other"],
      },
    };

    const suspects = detectLeaks(
      [zip],
      entries({
        "bulkExport.filename_one": "qr-labels-{{count}}.zip",
        "bulkExport.filename_few": "qr-labels-{{count}}.zip",
        "bulkExport.filename_many": "qr-labels-{{count}}.zip",
        "bulkExport.filename_other": "qr-labels-{{count}}.zip",
      }),
      "ru"
    );

    expect(suspects.filter((s) => s.disposition === "block")).toEqual([]);
  });

  it("still blocks a uniform group that really is echoing English", () => {
    // The leak is caught per value, where `block` belongs — and the uniform
    // check does not report the same keys a second time, which is how `block`
    // used to beat `prefer-previous` on a filename group.
    const labels: TranslationEntry = {
      key: "download.labels_other",
      value: "Download labels",
      plural: {
        base: "download.labels",
        sourceForms: { one: "Download label", other: "Download labels" },
        targetCategories: ["one", "few", "many", "other"],
      },
    };

    const suspects = detectLeaks(
      [labels],
      entries({
        "download.labels_one": "Download labels",
        "download.labels_few": "Download labels",
        "download.labels_many": "Download labels",
        "download.labels_other": "Download labels",
      }),
      "ru"
    );

    expect(suspects).toHaveLength(4);
    expect(new Set(suspects.map((s) => s.key)).size).toBe(4);
    expect(suspects.some((s) => s.reason === "uniform-plural")).toBe(false);
    expect(suspects.some((s) => s.disposition === "block")).toBe(true);
  });
});

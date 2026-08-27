import { describe, it, expect } from "vitest";
import {
  collectPluralGroups,
  expandPluralFallback,
  getPluralCategories,
  incompletePluralSourceKeys,
  splitPluralKey,
} from "../plurals.js";

describe("splitPluralKey", () => {
  it("splits an i18next plural key into base and category", () => {
    expect(splitPluralKey("item_other")).toEqual({
      base: "item",
      category: "other",
    });
    expect(splitPluralKey("portfolio.item_many")).toEqual({
      base: "portfolio.item",
      category: "many",
    });
  });

  it("returns null for keys with no plural suffix", () => {
    expect(splitPluralKey("save")).toBeNull();
    expect(splitPluralKey("item_count")).toBeNull();
  });
});

describe("getPluralCategories", () => {
  it("returns the four CLDR categories Russian needs", () => {
    expect(getPluralCategories("ru")).toEqual(["one", "few", "many", "other"]);
  });

  it("returns the four CLDR categories Polish needs", () => {
    expect(getPluralCategories("pl")).toEqual(["one", "few", "many", "other"]);
  });

  it("returns only one/other for English", () => {
    expect(getPluralCategories("en")).toEqual(["one", "other"]);
  });

  it("returns categories in canonical CLDR order for Arabic", () => {
    expect(getPluralCategories("ar")).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
  });

  it("falls back to one/other for an unusable language tag", () => {
    expect(getPluralCategories("not a tag!")).toEqual(["one", "other"]);
  });
});

describe("collectPluralGroups", () => {
  const source = {
    "item_one": "{{count}} item",
    "item_other": "{{count}} items",
  };

  it("expands an English one/other group to Russian's four categories", () => {
    const groups = collectPluralGroups(source, "ru");
    expect(groups.get("item")?.targetCategories).toEqual([
      "one",
      "few",
      "many",
      "other",
    ]);
    expect(groups.get("item")?.sourceKeys).toEqual(["item_one", "item_other"]);
    expect(groups.get("item")?.sourceForms).toEqual({
      one: "{{count}} item",
      other: "{{count}} items",
    });
  });

  it("keeps the English categories for a language with fewer of them", () => {
    // zh needs only `other`; the union keeps `_one` so existing zh
    // translations are never dropped.
    expect(collectPluralGroups(source, "zh").get("item")?.targetCategories)
      .toEqual(["one", "other"]);
  });

  it("ignores a suffixed key that is not a plural group", () => {
    // No `_other` sibling — i18next requires one for every plural key, so
    // "Step one" must not be mistaken for a plural.
    const groups = collectPluralGroups({ step_one: "Step one" }, "ru");
    expect(groups.size).toBe(0);
  });

  it("uses ordinal rules for i18next ordinal keys", () => {
    const groups = collectPluralGroups(
      { place_ordinal_one: "{{count}}st", place_ordinal_other: "{{count}}th" },
      "en"
    );
    expect(groups.get("place_ordinal")?.targetCategories).toEqual([
      "one",
      "two",
      "few",
      "other",
    ]);
  });

  /**
   * CEL-1533.
   *
   * The `_other`-sibling guard was one-sided: it rejected a base with no
   * `_other`, but accepted a base with NOTHING BUT `_other`. Expanding one of
   * those invents `_one`/`_few`/`_many` siblings that i18next then serves
   * whenever the count is not "other" — turning an enum member into four
   * bogus locale keys.
   */
  describe("a lone _other variant", () => {
    it("is not a plural group when its value has no count placeholder", () => {
      // producer-dashboard imports.json: the "other" document kind.
      const groups = collectPluralGroups(
        { "document.kind_other": "Document" },
        "ru"
      );
      expect(groups.size).toBe(0);
    });

    it("stays a plural group when its value carries a count placeholder", () => {
      // producer-dashboard market.json: a genuine single-form plural, and the
      // anti-vacuity pin for the rule above.
      const groups = collectPluralGroups(
        { listingCount_other: "{{count}} listings" },
        "ru"
      );
      expect(groups.get("listingCount")?.targetCategories).toEqual([
        "one",
        "few",
        "many",
        "other",
      ]);
    });

    it("stays a plural group as soon as it has any sibling category", () => {
      const groups = collectPluralGroups(
        { kind_one: "Kind", kind_other: "Kinds" },
        "ru"
      );
      expect(groups.get("kind")?.sourceKeys).toEqual(["kind_one", "kind_other"]);
    });
  });
});

describe("incompletePluralSourceKeys", () => {
  const groups = collectPluralGroups(
    { item_one: "{{count}} item", item_other: "{{count}} items" },
    "ru"
  );

  it("flags a target file missing categories the language needs", () => {
    const target = { item_one: "товар", item_other: "товаров" };
    expect(incompletePluralSourceKeys(target, groups)).toEqual([
      "item_one",
      "item_other",
    ]);
  });

  it("flags nothing when every required category is present", () => {
    const target = {
      item_one: "товар",
      item_few: "товара",
      item_many: "товаров",
      item_other: "товара",
    };
    expect(incompletePluralSourceKeys(target, groups)).toEqual([]);
  });

  it("treats an empty string as a missing category", () => {
    const target = {
      item_one: "товар",
      item_few: "",
      item_many: "товаров",
      item_other: "товара",
    };
    expect(incompletePluralSourceKeys(target, groups)).toHaveLength(2);
  });

  /**
   * CEL-1533.
   *
   * A group whose every category holds the English source form is COMPLETE by
   * key count and carries no translation at all — the shape 0.3.0 wrote to
   * seven production locales. Nothing else can rescue it: the English source
   * never changes, so the cache says "done" on every future run.
   */
  describe("a group filled with the English source", () => {
    it("is flagged even when the English carries stray whitespace", () => {
      // CEL-1543 review, P2. The leak guard's identity test trims
      // (`value.trim() === sourceText.trim()`) and providers do not trim
      // individual values, so a padded English form reaches the file. Under
      // byte equality it was neither flagged here nor blocked there — silent
      // and cached, by one space.
      const target = {
        item_one: " {{count}} item",
        item_few: "{{count}} items ",
        item_many: "{{count}} items",
        item_other: "{{count}} items",
      };
      expect(incompletePluralSourceKeys(target, groups)).toEqual([
        "item_one",
        "item_other",
      ]);
    });

    it("is flagged for regeneration even though every category is present", () => {
      const target = {
        item_one: "{{count}} item",
        item_few: "{{count}} items",
        item_many: "{{count}} items",
        item_other: "{{count}} items",
      };
      expect(incompletePluralSourceKeys(target, groups)).toEqual([
        "item_one",
        "item_other",
      ]);
    });

    it("is not flagged once even one category is really translated", () => {
      const target = {
        item_one: "{{count}} товар",
        item_few: "{{count}} items",
        item_many: "{{count}} items",
        item_other: "{{count}} items",
      };
      expect(incompletePluralSourceKeys(target, groups)).toEqual([]);
    });

    it("leaves a single-form group alone, however identical it looks", () => {
      // A filename, a slug or a Russian unit abbreviation is uniform BY
      // NECESSITY. Flagging those would retranslate them on every run forever,
      // so the check demands two DISTINCT English forms before it fires.
      const filename = collectPluralGroups(
        { "bulkExport.filename_other": "qr-labels-{{count}}.zip" },
        "ru"
      );
      const target = {
        "bulkExport.filename_one": "qr-labels-{{count}}.zip",
        "bulkExport.filename_few": "qr-labels-{{count}}.zip",
        "bulkExport.filename_many": "qr-labels-{{count}}.zip",
        "bulkExport.filename_other": "qr-labels-{{count}}.zip",
      };
      expect(incompletePluralSourceKeys(target, filename)).toEqual([]);
    });
  });
});

describe("expandPluralFallback", () => {
  it("emits every target category from the closest English form", () => {
    const fallback = expandPluralFallback({
      key: "item_other",
      value: "{{count}} items",
      plural: {
        base: "item",
        sourceForms: { one: "{{count}} item", other: "{{count}} items" },
        targetCategories: ["one", "few", "many", "other"],
      },
    });
    expect(fallback).toEqual([
      { key: "item_one", value: "{{count}} item" },
      { key: "item_few", value: "{{count}} items" },
      { key: "item_many", value: "{{count}} items" },
      { key: "item_other", value: "{{count}} items" },
    ]);
  });

  it("passes a non-plural entry through unchanged", () => {
    expect(expandPluralFallback({ key: "save", value: "Save" })).toEqual([
      { key: "save", value: "Save" },
    ]);
  });
});

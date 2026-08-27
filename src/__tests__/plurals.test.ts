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

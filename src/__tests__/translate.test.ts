import { describe, it, expect, vi } from "vitest";
import { translateNamespace } from "../translate.js";
import { hashValue } from "../cache.js";
import type {
  TranslationProvider,
  TranslationEntry,
} from "../providers/types.js";

function createMockProvider(): TranslationProvider {
  return {
    name: "mock",
    translate: vi.fn(async (entries: TranslationEntry[], lang: string) =>
      entries.map((e) => ({ key: e.key, value: `[${lang}] ${e.value}` }))
    ),
  };
}

/**
 * Stands in for Gemini: honours `TranslationEntry.plural` by returning one
 * entry per target category, exactly as `parseGeminiResponse` does.
 */
function createPluralAwareProvider(): TranslationProvider {
  return {
    name: "mock-plural",
    supportsPluralExpansion: true,
    translate: vi.fn(async (entries: TranslationEntry[], lang: string) => {
      const out: TranslationEntry[] = [];
      for (const e of entries) {
        if (!e.plural) {
          out.push({ key: e.key, value: `[${lang}] ${e.value}` });
          continue;
        }
        for (const category of e.plural.targetCategories) {
          out.push({
            key: `${e.plural.base}_${category}`,
            value: `[${lang}:${category}] ${e.plural.sourceForms[category] ?? e.plural.sourceForms.other}`,
          });
        }
      }
      return out;
    }),
  };
}

const RU_SOURCE = {
  "item_one": "{{count}} item",
  "item_other": "{{count}} items",
};

describe("translateNamespace", () => {
  it("translates all keys when no target exists", async () => {
    const provider = createMockProvider();
    const source = { save: "Save", cancel: "Cancel" };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.translated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.output.save).toBe("[sv] Save");
    expect(provider.translate).toHaveBeenCalledOnce();
  });

  it("skips unchanged keys", async () => {
    const provider = createMockProvider();
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.translated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.output.save).toBe("Spara");
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it("retranslates changed keys", async () => {
    const provider = createMockProvider();
    const source = { save: "Save changes" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.changed).toBe(1);
    expect(result.output.save).toBe("[sv] Save changes");
  });

  it("force retranslates everything", async () => {
    const provider = createMockProvider();
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: true,
    });

    expect(result.translated).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe("translateNamespace — non-English plural categories (CEL-1267)", () => {
  it("emits Russian's four plural categories from a two-category English source", async () => {
    const provider = createPluralAwareProvider();

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: false,
    });

    expect(Object.keys(result.output).sort()).toEqual([
      "item_few",
      "item_many",
      "item_one",
      "item_other",
    ]);
    // The written file carries all four, in canonical CLDR order.
    expect(result.outputKeyOrder).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    expect(result.output.item_few).toBe("[ru:few] {{count}} items");
  });

  it("hands the provider one entry carrying the whole plural group", async () => {
    const provider = createPluralAwareProvider();

    await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "pl",
      force: false,
    });

    expect(provider.translate).toHaveBeenCalledOnce();
    const sent = vi.mocked(provider.translate).mock.calls[0][0];
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe("item_other");
    expect(sent[0].plural).toEqual({
      base: "item",
      sourceForms: { one: "{{count}} item", other: "{{count}} items" },
      targetCategories: ["one", "few", "many", "other"],
    });
  });

  it("regenerates a group whose target file predates plural expansion", async () => {
    const provider = createPluralAwareProvider();
    // English unchanged and cached, but the ru file only has one/other.
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: { item_one: "товар", item_other: "товаров" },
      cacheEntries: {
        item_one: hashValue(RU_SOURCE.item_one),
        item_other: hashValue(RU_SOURCE.item_other),
      },
      provider,
      targetLang: "ru",
      force: false,
    });

    expect(provider.translate).toHaveBeenCalledOnce();
    expect(result.output).toHaveProperty("item_few");
    expect(result.output).toHaveProperty("item_many");
    expect(result.skipped).toBe(0);
  });

  it("preserves target-only categories when nothing needs retranslating", async () => {
    const provider = createPluralAwareProvider();
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {
        item_one: "товар",
        item_few: "товара",
        item_many: "товаров",
        item_other: "товара",
      },
      cacheEntries: {
        item_one: hashValue(RU_SOURCE.item_one),
        item_other: hashValue(RU_SOURCE.item_other),
      },
      provider,
      targetLang: "ru",
      force: false,
    });

    expect(provider.translate).not.toHaveBeenCalled();
    // _few / _many have no English source key — they must survive the run.
    expect(result.output.item_few).toBe("товара");
    expect(result.output.item_many).toBe("товаров");
  });

  it("omits every category rather than writing English when a chunk fails", async () => {
    const provider: TranslationProvider = {
      name: "exploding",
      supportsPluralExpansion: true,
      translate: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: false,
    });

    expect(result.errors).toHaveLength(1);
    // Same semantics as the guard path: an API outage is no better a reason to
    // write the English source over a gap than a bad model response is.
    expect(result.output).toEqual({});
    // One failure per EMITTED key — the ru group is four of them.
    expect(result.failed).toBe(4);
    // ...but `translated` counts SOURCE keys, so it must not go to -2.
    expect(result.translated).toBe(0);
  });

  it("leaves providers without plural support on the flat English key set", async () => {
    // DeepL shape: no supportsPluralExpansion flag.
    const provider = createMockProvider();

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: false,
    });

    const sent = vi.mocked(provider.translate).mock.calls[0][0];
    expect(sent.map((e) => e.key)).toEqual(["item_one", "item_other"]);
    expect(sent.every((e) => e.plural === undefined)).toBe(true);
    // The REQUEST is still flat. The key ORDER now reserves a slot for every
    // category ru needs, because the target file may already hold them — but a
    // slot with nothing behind it writes nothing, so a fresh target file comes
    // out exactly as it did before (CEL-1533).
    expect(result.outputKeyOrder).toEqual([
      "item_one",
      "item_few",
      "item_many",
      "item_other",
    ]);
    expect(Object.keys(result.output).sort()).toEqual([
      "item_one",
      "item_other",
    ]);
  });

  it("does not expand a suffixed key that is not a plural group", async () => {
    const provider = createPluralAwareProvider();
    const result = await translateNamespace({
      sourceFlat: { step_one: "Step one" },
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: false,
    });

    expect(result.outputKeyOrder).toEqual(["step_one"]);
    expect(result.output).toEqual({ step_one: "[ru] Step one" });
  });
});

/**
 * A provider that could not produce trustworthy text marks the entry `failed`.
 * The value it carries is the English source — writing it is exactly the
 * CEL-1539 defect, so `translateNamespace` must refuse it.
 */
function createLeakingProvider(): TranslationProvider {
  return {
    name: "leaking",
    supportsPluralExpansion: true,
    translate: vi.fn(async (entries: TranslationEntry[]) =>
      entries.flatMap((e) =>
        e.plural
          ? e.plural.targetCategories.map((category) => ({
              key: `${e.plural!.base}_${category}`,
              value: e.plural!.sourceForms[category] ?? e.value,
              failed: {
                reason: "source-echo",
                detail: 'untranslated English left in the value: "product"',
              },
            }))
          : [
              {
                key: e.key,
                value: e.value,
                failed: {
                  reason: "source-echo",
                  detail: 'untranslated English left in the value: "product"',
                },
              },
            ]
      )
    ),
  };
}

describe("leak-guard failures (CEL-1539)", () => {
  it("never writes a flagged value, and counts it as failed", async () => {
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: {},
      cacheEntries: {},
      provider: createLeakingProvider(),
      targetLang: "zh",
      force: false,
    });

    expect(result.output["card.beverage"]).toBeUndefined();
    expect(result.failed).toBe(1);
    expect(result.translated).toBe(0);
    expect(result.errors[0]).toContain("card.beverage");
    expect(result.errors[0]).toContain("source-echo");
  });

  it("keeps the previous translation rather than regressing it to English", async () => {
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: {},
      provider: createLeakingProvider(),
      targetLang: "zh",
      force: true,
    });

    expect(result.output["card.beverage"]).toBe("产品");
    expect(result.failed).toBe(1);
  });

  it("leaves a failed key out of the cache so the next run retries it", async () => {
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product", save: "Save" },
      targetFlat: {},
      cacheEntries: {},
      provider: {
        name: "half-leaking",
        supportsPluralExpansion: true,
        translate: vi.fn(async (entries: TranslationEntry[]) =>
          entries.map((e) =>
            e.key === "save"
              ? { key: e.key, value: "保存" }
              : {
                  key: e.key,
                  value: e.value,
                  failed: { reason: "source-echo", detail: "leak" },
                }
          )
        ),
      },
      targetLang: "zh",
      force: false,
    });

    expect(result.output.save).toBe("保存");
    expect(result.newCacheEntries.save).toBe(hashValue("Save"));
    expect("card.beverage" in result.newCacheEntries).toBe(false);
  });

  it("invalidates the whole plural group when one category fails", async () => {
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider: createLeakingProvider(),
      targetLang: "ru",
      force: false,
    });

    expect(result.output).toEqual({});
    expect(result.failed).toBe(4);
    // `failed` counts emitted keys; `translated` counts source keys, and
    // `item_one`/`item_other` are the only two of those.
    expect(result.translated).toBe(0);
    expect(Object.keys(result.newCacheEntries)).toEqual([]);
  });

  it("keeps a chunk-failure fallback from overwriting a good translation", async () => {
    const provider: TranslationProvider = {
      name: "exploding",
      supportsPluralExpansion: true,
      translate: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: { item_one: "{{count}} товар", item_other: "{{count}} товара" },
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: true,
    });

    // Existing Russian survives; the categories that never existed are left
    // out entirely rather than filled with English, and nothing is cached.
    expect(result.output.item_one).toBe("{{count}} товар");
    expect(result.output.item_other).toBe("{{count}} товара");
    expect(result.output.item_many).toBeUndefined();
    expect(Object.keys(result.newCacheEntries)).toEqual([]);
  });
});

/**
 * A `degraded` entry is real output that the provider could not vouch for —
 * chiefly a value byte-identical to the English source. It is written, or
 * beaten by a previous translation, but never counted as a failure.
 */
function createDegradingProvider(value: string): TranslationProvider {
  return {
    name: "degrading",
    supportsPluralExpansion: true,
    translate: vi.fn(async (entries: TranslationEntry[]) =>
      entries.map((e) => ({
        key: e.key,
        value,
        degraded: {
          reason: "identical-to-source",
          detail: "value is the English source verbatim",
        },
      }))
    ),
  };
}

describe("degraded values (CEL-1539 review)", () => {
  it("prefers the previous translation over a value identical to the source", async () => {
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: {},
      provider: createDegradingProvider("Product"),
      targetLang: "zh",
      force: true,
    });

    expect(result.output["card.beverage"]).toBe("产品");
    // Never a failure — the CLI exits non-zero on `failed > 0`, and a filename
    // or brand-only label is byte-identical by necessity.
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toContain("card.beverage");
    expect(result.warnings[0]).toContain("kept the previous translation");
  });

  it("writes the value when there is no previous translation to keep", async () => {
    const result = await translateNamespace({
      sourceFlat: { filename: "qr-labels-{{count}}.zip" },
      targetFlat: {},
      cacheEntries: {},
      provider: createDegradingProvider("qr-labels-{{count}}.zip"),
      targetLang: "zh",
      force: false,
    });

    expect(result.output.filename).toBe("qr-labels-{{count}}.zip");
    expect(result.failed).toBe(0);
    expect(result.warnings[0]).toContain("wrote it anyway");
  });

  it("leaves a degraded key out of the cache when English is what is on disk", async () => {
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "Product" },
      cacheEntries: {},
      provider: createDegradingProvider("Product"),
      targetLang: "zh",
      force: true,
    });

    expect("card.beverage" in result.newCacheEntries).toBe(false);
    expect(result.staleSourceKeys).toEqual(["card.beverage"]);
  });

  it("stops asking once a real translation has beaten the degraded value", async () => {
    // CEL-1543: the previous value is a genuine translation of the CURRENT
    // English, so re-asking hands the model the same input that just degraded.
    // The accept is recorded against zh alone; `--force` or an English edit
    // asks again.
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: {},
      provider: createDegradingProvider("Product"),
      targetLang: "zh",
      force: true,
    });

    expect(result.acceptedSourceKeys).toEqual(["card.beverage"]);
    expect(result.staleSourceKeys).toEqual([]);
    expect(result.newCacheEntries["card.beverage"]).toBe(hashValue("Product"));
  });

  it("does not accept when the English behind the previous translation changed", async () => {
    // The Chinese on disk renders text that is gone, so it is NOT a better
    // answer than the attempt — it is a stale one. Keep retrying.
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Beverage product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: { "card.beverage": hashValue("Product") },
      provider: createDegradingProvider("Beverage product"),
      targetLang: "zh",
      force: false,
    });

    expect(result.acceptedSourceKeys).toEqual([]);
    expect(result.staleSourceKeys).toEqual(["card.beverage"]);
  });

  it("does accept on a retry of the SAME English after an earlier eviction", async () => {
    // Same `changed` classification as the test above — no cached hash — but
    // the eviction, not an edit, is why. `retriedSourceKeys` is the only thing
    // that can tell the two apart, and it is what the per-language cache buys.
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: {},
      retriedSourceKeys: new Set(["card.beverage"]),
      provider: createDegradingProvider("Product"),
      targetLang: "zh",
      force: false,
    });

    expect(result.acceptedSourceKeys).toEqual(["card.beverage"]);
    expect(result.staleSourceKeys).toEqual([]);
  });

  it("carries an accept forward through a run that does not re-attempt the key", async () => {
    const provider = createMockProvider();
    const result = await translateNamespace({
      sourceFlat: { "card.beverage": "Product" },
      targetFlat: { "card.beverage": "产品" },
      cacheEntries: { "card.beverage": hashValue("Product") },
      cachedAcceptedKeys: new Set(["card.beverage"]),
      provider,
      targetLang: "zh",
      force: false,
    });

    expect(provider.translate).not.toHaveBeenCalled();
    // Dropped here, the marker would be gone from the merged cache and the key
    // would go back to burning a retranslation every run.
    expect(result.acceptedSourceKeys).toEqual(["card.beverage"]);
  });
});

/**
 * CEL-1533 #3.
 *
 * Plural categories the TARGET language has but English does not (`_few`,
 * `_many`) carry no source key. 0.3.1 collected plural groups only for a
 * provider that could expand them, so running DeepL over a locale Gemini had
 * expanded deleted every one of those keys from the file: the source keys came
 * back translated, the target-only ones were never written, and the writer only
 * emits what `output` holds.
 */
describe("target-only plural categories survive a plural-unaware provider", () => {
  const RU_TARGET = {
    item_one: "{{count}} товар",
    item_few: "{{count}} товара",
    item_many: "{{count}} товаров",
    item_other: "{{count}} товара",
  };

  it("keeps _few and _many when DeepL retranslates the source keys", async () => {
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: RU_TARGET,
      cacheEntries: {},
      provider: createMockProvider(),
      targetLang: "ru",
      // Force: every source key is retranslated, which is exactly the case the
      // old carry-over loop skipped.
      force: true,
    });

    expect(result.output.item_few).toBe("{{count}} товара");
    expect(result.output.item_many).toBe("{{count}} товаров");
    // The source keys really were retranslated — otherwise this would pass for
    // a run that simply did nothing.
    expect(result.output.item_one).toBe("[ru] {{count}} item");
    expect(result.outputKeyOrder).toContain("item_many");
  });

  it("keeps them on an incremental run too", async () => {
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: RU_TARGET,
      cacheEntries: {},
      provider: createMockProvider(),
      targetLang: "ru",
      force: false,
    });

    expect(result.output.item_few).toBe("{{count}} товара");
    expect(result.output.item_many).toBe("{{count}} товаров");
  });

  it("never invents a target-only category the file does not have", async () => {
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider: createMockProvider(),
      targetLang: "ru",
      force: false,
    });

    expect(result.output.item_few).toBeUndefined();
    expect(result.output.item_many).toBeUndefined();
  });
});

/**
 * CEL-1533 #4.
 *
 * `translated`, `changed` and `skipped` count SOURCE keys; `failed` counts
 * EMITTED keys. A plural group collapses several source keys into one chunk
 * entry and expands back into one key per target category, so mixing the two
 * units miscounts in both directions.
 */
describe("counts survive a collapsed plural group", () => {
  it("does not report a failed group as updated as well", async () => {
    const changedCache = {
      item_one: hashValue("stale"),
      item_other: hashValue("stale"),
    };

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {
        item_one: "{{count}} товар",
        item_few: "{{count}} товара",
        item_many: "{{count}} товаров",
        item_other: "{{count}} товара",
      },
      cacheEntries: changedCache,
      provider: createLeakingProvider(),
      targetLang: "ru",
      force: false,
    });

    // Both source keys are `changed` (the cached hash is stale) and both fail.
    // Reporting them as updated AND failed in the same summary is the miscount.
    expect(result.changed).toBe(0);
    expect(result.translated).toBe(0);
    // `failed` is the EMITTED count: four ru categories, not two source keys.
    expect(result.failed).toBe(4);
  });

  it("does not report a degraded group as translated", async () => {
    // Degrades every emitted category, the way the real guard path marks them.
    const provider: TranslationProvider = {
      name: "degrading-plural",
      supportsPluralExpansion: true,
      translate: vi.fn(async (entries: TranslationEntry[]) =>
        entries.flatMap((e) =>
          (e.plural?.targetCategories ?? []).map((category) => ({
            key: `${e.plural!.base}_${category}`,
            value: "{{count}} items",
            degraded: {
              reason: "identical-to-source",
              detail: "value is the English source verbatim",
            },
          }))
        )
      ),
    };

    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "ru",
      force: false,
    });

    // A degraded key kept the previous value or wrote unvouched-for output and
    // left the cache; it did not receive a fresh translation.
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(0);
    expect(Object.keys(result.newCacheEntries)).toEqual([]);
  });

  it("still counts a clean group as translated", async () => {
    // Anti-vacuity: the two tests above would pass for an implementation that
    // reported zero for everything.
    const result = await translateNamespace({
      sourceFlat: RU_SOURCE,
      targetFlat: {},
      cacheEntries: {},
      provider: createPluralAwareProvider(),
      targetLang: "ru",
      force: false,
    });

    expect(result.translated).toBe(2);
    expect(result.failed).toBe(0);
  });
});

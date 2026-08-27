import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translate } from "../translate.js";
import type {
  TranslationEntry,
  TranslationProvider,
} from "../providers/types.js";

/** Stands in for Gemini: honours `TranslationEntry.plural`. */
function pluralAwareProvider(): TranslationProvider {
  return {
    name: "mock-plural",
    supportsPluralExpansion: true,
    translate: async (entries: TranslationEntry[], lang: string) => {
      const out: TranslationEntry[] = [];
      for (const e of entries) {
        if (!e.plural) {
          out.push({ key: e.key, value: `[${lang}] ${e.value}` });
          continue;
        }
        for (const category of e.plural.targetCategories) {
          out.push({
            key: `${e.plural.base}_${category}`,
            value: `[${lang}:${category}]`,
          });
        }
      }
      return out;
    },
  };
}

/** Stands in for DeepL: no plural support, 1:1 key mapping. */
function flatProvider(): TranslationProvider {
  return {
    name: "mock-flat",
    translate: async (entries: TranslationEntry[], lang: string) =>
      entries.map((e) => ({ key: e.key, value: `[${lang}] ${e.value}` })),
  };
}

const SOURCE = {
  save: "Save",
  item_one: "{{count}} item",
  item_other: "{{count}} items",
  cancel: "Cancel",
};

let root: string;
let enDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polyglot-plural-"));
  enDir = join(root, "en");
  mkdirSync(enDir, { recursive: true });
  writeFileSync(
    join(enDir, "common.json"),
    JSON.stringify(SOURCE, null, 2) + "\n"
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function readTarget(lang: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, lang, "common.json"), "utf-8"));
}

describe("translate — written files carry non-English plural categories (CEL-1267)", () => {
  it("writes Russian's four categories, in English key order", async () => {
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: pluralAwareProvider(),
      noCache: true,
    });

    const ru = readTarget("ru");
    // The write path is no longer limited to the English key set.
    expect(Object.keys(ru)).toEqual([
      "save",
      "item_one",
      "item_few",
      "item_many",
      "item_other",
      "cancel",
    ]);
    expect(ru.item_many).toBe("[ru:many]");
  });

  it("keeps the flat English key set for a provider without plural support", async () => {
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: flatProvider(),
      noCache: true,
    });

    expect(Object.keys(readTarget("ru"))).toEqual([
      "save",
      "item_one",
      "item_other",
      "cancel",
    ]);
  });

  it("does not drop target-only categories on a second, fully cached run", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });

    const second = await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });

    expect(second.translated).toBe(0);
    expect(Object.keys(readTarget("ru"))).toEqual([
      "save",
      "item_one",
      "item_few",
      "item_many",
      "item_other",
      "cancel",
    ]);
  });
});

/**
 * CEL-1533 #3, end to end.
 *
 * The two providers are routinely pointed at the same locale tree — Gemini for
 * the bulk, DeepL for a language it does better. 0.3.1 collected plural groups
 * only for a provider that could expand them, so the DeepL run rewrote the file
 * from the flat English key set and every `_few`/`_many` Gemini had written
 * disappeared, silently, with no warning and no failure.
 */
describe("translate — a plural-unaware provider does not delete expanded forms", () => {
  it("keeps the ru categories Gemini wrote when DeepL runs over the same file", async () => {
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: pluralAwareProvider(),
      noCache: true,
    });
    expect(readTarget("ru").item_many).toBe("[ru:many]");

    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: flatProvider(),
      noCache: true,
    });

    const ru = readTarget("ru");
    // The source keys were retranslated by DeepL...
    expect(ru.item_one).toBe("[ru] {{count}} item");
    // ...and the categories only Gemini could produce survived.
    expect(ru.item_few).toBe("[ru:few]");
    expect(ru.item_many).toBe("[ru:many]");
    expect(Object.keys(ru)).toEqual([
      "save",
      "item_one",
      "item_few",
      "item_many",
      "item_other",
      "cancel",
    ]);
  });
});

/**
 * CEL-1533 #2.
 *
 * The cache is namespace-scoped and language-INDEPENDENT: one map of source
 * hashes per file, rewritten once per language. A key one language degraded
 * used to be re-added by the next language's write, so the run wrote an
 * unvouched-for value AND cached it as done — and no plural-completeness check
 * can see that, because the file has every category it needs.
 */
describe("translate — a cache eviction holds across every language in the run", () => {
  function degradingFor(lang: string): TranslationProvider {
    return {
      name: "mock-degrading",
      supportsPluralExpansion: true,
      translate: async (entries: TranslationEntry[], target: string) => {
        const out: TranslationEntry[] = [];
        for (const e of entries) {
          const keys = e.plural
            ? e.plural.targetCategories.map((c) => `${e.plural!.base}_${c}`)
            : [e.key];
          for (const key of keys) {
            out.push({
              key,
              value: `[${target}] ${e.value}`,
              ...(target === lang && e.key === "save"
                ? {
                    degraded: {
                      reason: "identical-to-source",
                      detail: "value is the English source verbatim",
                    },
                  }
                : {}),
            });
          }
        }
        return out;
      },
    };
  }

  it("does not let a later language re-cache what an earlier one degraded", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      // Only zh degrades `save`; ru translates it cleanly and writes last.
      provider: degradingFor("zh"),
      cacheFile,
    });

    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect("save" in cache["common.json"]).toBe(false);
    // Anti-vacuity: the rest of the namespace IS cached, so this is an
    // eviction rather than a cache that was never written.
    expect("cancel" in cache["common.json"]).toBe(true);
  });

  it("caches everything when no language degrades anything", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: degradingFor("de"),
      cacheFile,
    });

    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(Object.keys(cache["common.json"]).sort()).toEqual([
      "cancel",
      "item_one",
      "item_other",
      "save",
    ]);
  });
});

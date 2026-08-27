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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translate } from "../translate.js";
import { hashValue } from "../cache.js";
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
    // The eviction is now recorded AGAINST zh rather than by deleting the key,
    // so ru's write cannot undo it and ru keeps its own cache (CEL-1543).
    expect(cache["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });
    // Anti-vacuity: the rest of the namespace IS cached, so this is an
    // eviction rather than a cache that was never written.
    expect(cache["common.json"].cancel).toBe(hashValue(SOURCE.cancel));
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

/** Plural-aware, records what it was asked for, returns `[lang] …`. */
function spyProvider(): TranslationProvider & {
  translate: ReturnType<typeof vi.fn>;
} {
  return {
    name: "mock-spy",
    supportsPluralExpansion: true,
    translate: vi.fn(async (entries: TranslationEntry[], lang: string) =>
      entries.flatMap((e) =>
        e.plural
          ? e.plural.targetCategories.map((c) => ({
              key: `${e.plural!.base}_${c}`,
              value: `[${lang}:${c}]`,
            }))
          : [{ key: e.key, value: `[${lang}] ${e.value}` }]
      )
    ),
  } as TranslationProvider & { translate: ReturnType<typeof vi.fn> };
}

/** Every source key a spy provider was asked for, across all its chunks. */
function askedKeys(spy: { translate: ReturnType<typeof vi.fn> }): string[] {
  return spy.translate.mock.calls.flatMap((call: [TranslationEntry[], string]) =>
    call[0].map((e) => e.key)
  );
}

/** The same, restricted to one target language. */
function askedKeysFor(
  spy: { translate: ReturnType<typeof vi.fn> },
  lang: string
): string[] {
  return spy.translate.mock.calls
    .filter((call: [TranslationEntry[], string]) => call[1] === lang)
    .flatMap((call: [TranslationEntry[], string]) => call[0].map((e) => e.key));
}

function readCache(file: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(file, "utf-8"));
}

function writeTarget(lang: string, values: Record<string, string>): void {
  mkdirSync(join(root, lang), { recursive: true });
  writeFileSync(
    join(root, lang, "common.json"),
    JSON.stringify(values, null, 2) + "\n"
  );
}

/**
 * CEL-1543 #1 and #2.
 *
 * The eviction union that closed CEL-1533 lived in memory for the length of one
 * `translate()` call, so it could only hold across the languages of a SINGLE
 * invocation. The README's own workflow — `-o zh`, then `-o ru` — put the key
 * back on the second command, restoring the "cached forever" hole; and because
 * the union deleted the key for everybody, one language's eviction also billed
 * every other language for a retranslation it did not need.
 */
describe("translate — a cache eviction is per language and survives the process", () => {
  function degradingFor(lang: string): TranslationProvider {
    return {
      name: "mock-degrading",
      supportsPluralExpansion: true,
      translate: async (entries: TranslationEntry[], target: string) =>
        entries.flatMap((e) => {
          const keys = e.plural
            ? e.plural.targetCategories.map((c) => `${e.plural!.base}_${c}`)
            : [e.key];
          return keys.map((key) => ({
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
          }));
        }),
    };
  }

  it("keeps zh's eviction when ru runs as a SEPARATE invocation", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: degradingFor("zh"),
      cacheFile,
    });
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });

    // A second command, a fresh process as far as the cache is concerned.
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });

    // ru's write must not put zh's key back.
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });

    const third = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: third,
      cacheFile,
    });

    expect(askedKeys(third)).toContain("save");
  });

  it("does not bill ru for a retranslation because zh evicted a key", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: degradingFor("zh"),
      cacheFile,
    });

    const second = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: second,
      cacheFile,
    });

    // Deleting the key for everybody made `save` look `changed` to ru on every
    // subsequent run, with an LLM-nondeterministic value each time.
    expect(second.translate).not.toHaveBeenCalled();
  });
});

/**
 * CEL-1543: the read path has to accept `{ namespace: { sourceKey: hash } }`
 * files written by every published version up to 0.3.2, and upgrade them a key
 * at a time rather than all at once.
 */
describe("translate — a 0.3.x cache file loads and migrates in place", () => {
  const LEGACY = {
    "common.json": {
      save: hashValue(SOURCE.save),
      item_one: hashValue(SOURCE.item_one),
      item_other: hashValue(SOURCE.item_other),
      cancel: hashValue(SOURCE.cancel),
    },
  };

  it("skips everything the old format said was done", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    writeFileSync(cacheFile, JSON.stringify(LEGACY, null, 2) + "\n");
    writeTarget("zh", {
      save: "保存",
      item_one: "{{count}} 件",
      item_other: "{{count}} 件",
      cancel: "取消",
    });

    const provider = spyProvider();
    const result = await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider,
      cacheFile,
    });

    expect(provider.translate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(4);
    // Nothing needed an exception, so nothing grew one.
    expect(readCache(cacheFile)).toEqual(LEGACY);
  });

  it("upgrades only the entry a language has an exception for", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    writeFileSync(cacheFile, JSON.stringify(LEGACY, null, 2) + "\n");
    // `save` is absent from the zh file, so it is retranslated despite the
    // legacy cache claiming it is done — and this provider degrades it.
    writeTarget("zh", {
      item_one: "{{count}} 件",
      item_other: "{{count}} 件",
      cancel: "取消",
    });

    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: {
        name: "degrades-save",
        supportsPluralExpansion: true,
        translate: async (entries: TranslationEntry[]) =>
          entries.map((e) => ({
            key: e.key,
            value: e.value,
            degraded: { reason: "identical-to-source", detail: "verbatim" },
          })),
      },
      cacheFile,
    });

    const namespace = readCache(cacheFile)["common.json"];
    expect(namespace.save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });
    // The untouched keys keep the legacy shape — migration is incremental.
    expect(namespace.cancel).toBe(hashValue(SOURCE.cancel));
    expect(namespace.item_one).toBe(hashValue(SOURCE.item_one));
  });
});

/**
 * CEL-1543: the perpetual-cost mitigation the language dimension unlocks, and
 * the line it may not cross.
 *
 * A plural group whose target reproduces the English source verbatim is
 * regenerated without `--force` (CEL-1533), so a group that is English BY
 * NECESSITY is written, cached, re-queued, retranslated and written again on
 * every run, forever. One retry is worth paying for; an unbounded number is
 * not — but "stop asking" is only safe where something has judged the value.
 * The leak guard does that for non-Latin targets and deliberately does not run
 * on Latin ones, so the accept follows the guard's own scope.
 */
describe("translate — an English-verbatim plural group converges after one retry", () => {
  /** Hands back the English source forms, exactly as they were sent. */
  const echoing: TranslationProvider = {
    name: "echoing",
    supportsPluralExpansion: true,
    translate: async (entries: TranslationEntry[], lang: string) =>
      entries.flatMap((e) =>
        e.plural
          ? e.plural.targetCategories.map((c) => ({
              key: `${e.plural!.base}_${c}`,
              value: e.plural!.sourceForms[c] ?? e.plural!.sourceForms.other,
            }))
          : [{ key: e.key, value: `[${lang}] ${e.value}` }]
      ),
  };

  /**
   * A locale whose plural group holds the English source in every category the
   * language needs, with the cache saying the whole namespace is done.
   */
  function seedEnglishFallback(
    cacheFile: string,
    lang: string,
    categories: string[]
  ): void {
    writeFileSync(
      cacheFile,
      JSON.stringify(
        {
          "common.json": {
            save: hashValue(SOURCE.save),
            item_one: hashValue(SOURCE.item_one),
            item_other: hashValue(SOURCE.item_other),
            cancel: hashValue(SOURCE.cancel),
          },
        },
        null,
        2
      ) + "\n"
    );
    const target: Record<string, string> = {
      save: `[${lang}] Save`,
      cancel: `[${lang}] Cancel`,
    };
    for (const category of categories) {
      target[`item_${category}`] =
        category === "one" ? SOURCE.item_one : SOURCE.item_other;
    }
    writeTarget(lang, target);
  }

  it("asks once, then records the accept for that language and stops", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    // ru: the leak guard reads every ru value, so a group that reaches the
    // convergence pass is one it examined and waved through.
    seedEnglishFallback(cacheFile, "ru", ["one", "few", "many", "other"]);

    const first = await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: echoing,
      cacheFile,
    });

    expect(
      first.warnings.some(
        (w) => w.includes("item") && w.includes("English source again")
      )
    ).toBe(true);

    const namespace = readCache(cacheFile)["common.json"];
    expect(namespace.item_other).toEqual({
      hash: hashValue(SOURCE.item_other),
      langs: {
        ru: { hash: hashValue(SOURCE.item_other), state: "accepted" },
      },
    });
    // The accept covers the whole group, and only the language that made it —
    // no other locale is named in the record.
    expect(namespace.item_one).toEqual({
      hash: hashValue(SOURCE.item_one),
      langs: { ru: { hash: hashValue(SOURCE.item_one), state: "accepted" } },
    });

    const second = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: second,
      cacheFile,
    });

    expect(second.translate).not.toHaveBeenCalled();
  });

  it("records NO accept where the leak guard does not run, and asks again", async () => {
    // CEL-1543 review, P2. In de/fr/es/it the guard is silent by design (an
    // English-looking token is indistinguishable from a loanword), so nothing
    // has judged this group. Accepting it would cache a genuine English leak
    // permanently — the CEL-1539 shape — so the per-run re-queue stands.
    const cacheFile = join(root, ".polyglot-cache.json");
    seedEnglishFallback(cacheFile, "de", ["one", "other"]);

    const first = await translate({
      input: enDir,
      outputLanguages: ["de"],
      provider: echoing,
      cacheFile,
    });

    expect(
      first.warnings.some(
        (w) => w.includes("item") && w.includes("Latin script")
      )
    ).toBe(true);
    // A bare hash: no de record at all, accepted or otherwise.
    expect(readCache(cacheFile)["common.json"].item_other).toBe(
      hashValue(SOURCE.item_other)
    );

    const second = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["de"],
      provider: second,
      cacheFile,
    });

    expect(askedKeys(second)).toContain("item_other");
  });

  it("mints no accept under --force, and clears the one already on record", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    seedEnglishFallback(cacheFile, "ru", ["one", "few", "many", "other"]);

    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: echoing,
      cacheFile,
    });
    // Anti-vacuity: the accept really is on disk before --force runs.
    expect(
      (readCache(cacheFile)["common.json"].item_other as { langs: unknown })
        .langs
    ).toEqual({
      ru: { hash: hashValue(SOURCE.item_other), state: "accepted" },
    });

    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: echoing,
      cacheFile,
      force: true,
    });

    // `--force` is the recovery command: it re-opens decisions, it does not
    // make them. The group came back English again and STILL was not accepted.
    expect(readCache(cacheFile)["common.json"].item_other).toBe(
      hashValue(SOURCE.item_other)
    );

    const after = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: after,
      cacheFile,
    });
    // Named specifically: `save` and `cancel` are asked for on plenty of runs,
    // so "the provider was called" would pass even if the accept had silenced
    // the group it is supposed to re-open.
    expect(askedKeys(after)).toContain("item_other");
  });

  it("asks again after the English changes", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    seedEnglishFallback(cacheFile, "ru", ["one", "few", "many", "other"]);

    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: echoing,
      cacheFile,
    });
    // The marker whose expiry is under test, on disk, immediately before the
    // edit — otherwise this passes for a run that never accepted anything.
    expect(
      (readCache(cacheFile)["common.json"].item_other as { langs: unknown })
        .langs
    ).toEqual({
      ru: { hash: hashValue(SOURCE.item_other), state: "accepted" },
    });

    // An accept is recorded against one English text, so new text asks again
    // with no flag at all.
    writeFileSync(
      join(enDir, "common.json"),
      JSON.stringify({ ...SOURCE, item_other: "{{count}} products" }, null, 2) +
        "\n"
    );

    const edited = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: edited,
      cacheFile,
    });

    expect(askedKeys(edited)).toContain("item_other");
  });
});

/**
 * CEL-1543 review, P1a — the wiring, end to end.
 *
 * `pendingRetryKeys` is the only thing that can tell "this language evicted the
 * key at exactly this English, and the file holds the answer" from "the English
 * moved". Passed by hand it is easy to prove correct; the claim the ticket
 * makes is about a REAL cache file surviving a real process boundary.
 */
describe("translate — an eviction becomes an accept on the run that follows it", () => {
  function degradingFor(lang: string): TranslationProvider {
    return {
      name: "mock-degrading",
      supportsPluralExpansion: true,
      translate: async (entries: TranslationEntry[], target: string) =>
        entries.flatMap((e) => {
          const keys = e.plural
            ? e.plural.targetCategories.map((c) => `${e.plural!.base}_${c}`)
            : [e.key];
          return keys.map((key) => ({
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
          }));
        }),
    };
  }

  it("stops asking after one round, not one per run", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");

    // Run 1: nothing on the record, so the unvouched-for value is written and
    // the key is evicted — stamped with the English it was made from.
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: degradingFor("zh"),
      cacheFile,
    });
    expect(readTarget("zh").save).toBe("[zh] Save");
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });

    // Run 2: same English, same degrade. The record now proves the file
    // answers this exact text, so zh stops asking instead of paying forever.
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: degradingFor("zh"),
      cacheFile,
    });
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "accepted" } },
    });

    // Run 3: nothing left to ask about.
    const third = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: third,
      cacheFile,
    });
    expect(askedKeys(third)).not.toContain("save");
  });

  it("never accepts a translation the English has since moved past", async () => {
    // CEL-1543 review, P1a. The eviction used to be stamped with the hash that
    // was CURRENT when it was written, so one run later it read as "evicted at
    // exactly this text" — and vouched for a translation of text that was
    // already gone. Provenance travels with the value, so it cannot.
    const cacheFile = join(root, ".polyglot-cache.json");

    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: pluralAwareProvider(),
      cacheFile,
    });
    expect(readCache(cacheFile)["common.json"].save).toBe(
      hashValue(SOURCE.save)
    );
    expect(readTarget("zh").save).toBe("[zh] Save");

    // The English moves; the zh file still holds a translation of the old text.
    writeFileSync(
      join(enDir, "common.json"),
      JSON.stringify({ ...SOURCE, save: "Save changes" }, null, 2) + "\n"
    );

    // Run A evicts, keeping the old translation, and records what that
    // translation answers — the OLD hash, not the new one.
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: degradingFor("zh"),
      cacheFile,
    });
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      hash: hashValue(SOURCE.save),
      langs: { zh: { hash: hashValue(SOURCE.save), state: "stale" } },
    });
    expect(readTarget("zh").save).toBe("[zh] Save");

    // Run B is the one that used to launder it. It must not accept.
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: degradingFor("zh"),
      cacheFile,
    });
    expect(readCache(cacheFile)["common.json"].save).toEqual({
      // No provenance survives a second kept-value round: nothing this run saw
      // vouches for the file, and the record says exactly that rather than
      // guessing the current hash.
      hash: hashValue(SOURCE.save),
      langs: { zh: { state: "stale" } },
    });

    // And it is still being asked about, run after run.
    const later = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: later,
      cacheFile,
    });
    expect(askedKeys(later)).toContain("save");
  });
});

/**
 * CEL-1543 review, P1c.
 *
 * The source hash used to be shared by every language and rewritten inside the
 * per-language loop, so after an English edit the FIRST language retranslated
 * and advanced the hash, and every later language then measured its own stale
 * file against the new hash and skipped. `-o zh,ru` and `-o zh` then `-o ru`
 * were equally broken, and no per-language marker could fix it while the number
 * a language is measured against belonged to somebody else.
 */
describe("translate — an English edit reaches every language", () => {
  function editSave(): void {
    writeFileSync(
      join(enDir, "common.json"),
      JSON.stringify({ ...SOURCE, save: "Save changes" }, null, 2) + "\n"
    );
  }

  it("retranslates for both languages in one invocation", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });
    editSave();

    const spy = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: spy,
      cacheFile,
    });

    expect(askedKeysFor(spy, "zh")).toContain("save");
    expect(askedKeysFor(spy, "ru")).toContain("save");
    expect(readTarget("ru").save).toBe("[ru] Save changes");
  });

  it("retranslates for the second language in a separate invocation", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });
    editSave();

    await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: pluralAwareProvider(),
      cacheFile,
    });

    const ru = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: ru,
      cacheFile,
    });

    expect(askedKeysFor(ru, "ru")).toContain("save");
    expect(readTarget("ru").save).toBe("[ru] Save changes");
  });

  it("skips both once both have caught up", async () => {
    // Anti-vacuity: the two tests above would pass for an implementation that
    // never cached anything at all.
    const cacheFile = join(root, ".polyglot-cache.json");
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });
    editSave();
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: pluralAwareProvider(),
      cacheFile,
    });

    const settled = spyProvider();
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: settled,
      cacheFile,
    });

    expect(settled.translate).not.toHaveBeenCalled();
  });
});

/** `--dry-run` reads the same per-language view the real run does. */
describe("translate — dry run", () => {
  function degradingSave(lang: string): TranslationProvider {
    return {
      name: "mock-degrading",
      supportsPluralExpansion: true,
      translate: async (entries: TranslationEntry[], target: string) =>
        entries.flatMap((e) => {
          const keys = e.plural
            ? e.plural.targetCategories.map((c) => `${e.plural!.base}_${c}`)
            : [e.key];
          return keys.map((key) => ({
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
          }));
        }),
    };
  }

  it("counts one language's eviction as work for that language alone", async () => {
    const cacheFile = join(root, ".polyglot-cache.json");
    await translate({
      input: enDir,
      outputLanguages: ["zh", "ru"],
      provider: degradingSave("zh"),
      cacheFile,
    });

    const zhSpy = spyProvider();
    const zh = await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: zhSpy,
      cacheFile,
      dryRun: true,
    });

    expect(zh.translated).toBe(1);
    expect(zh.skipped).toBe(3);
    expect(zhSpy.translate).not.toHaveBeenCalled();

    // ru never evicted anything, so it has nothing to do.
    const ru = await translate({
      input: enDir,
      outputLanguages: ["ru"],
      provider: spyProvider(),
      cacheFile,
      dryRun: true,
    });
    expect(ru.translated).toBe(0);
  });
});

/**
 * CEL-1543 P3. A base the plural guards reject (`kind_other`: "Document" — a
 * lone `_other` with no count placeholder) keeps its own key, but a `_one` an
 * earlier run invented for it has no source key and belongs to no group, so the
 * writer drops it. Right outcome, previously zero output.
 */
describe("translate — dropping a stale plural sibling is announced", () => {
  it("names the keys it is about to remove", async () => {
    const src = join(root, "en", "enums.json");
    writeFileSync(
      src,
      JSON.stringify({ kind_other: "Document", save: "Save" }, null, 2) + "\n"
    );
    mkdirSync(join(root, "zh"), { recursive: true });
    writeFileSync(
      join(root, "zh", "enums.json"),
      JSON.stringify(
        { kind_other: "其他", kind_one: "一个", save: "保存" },
        null,
        2
      ) + "\n"
    );

    const result = await translate({
      input: enDir,
      outputLanguages: ["zh"],
      provider: spyProvider(),
      noCache: true,
    });

    const notice = result.warnings.find((w) => w.startsWith('"kind"'));
    expect(notice).toBeDefined();
    expect(notice).toContain("kind_one");
    expect(notice).toContain("not a plural group");
    // Anti-vacuity: the key really is gone from the written file.
    const written = JSON.parse(
      readFileSync(join(root, "zh", "enums.json"), "utf-8")
    );
    expect("kind_one" in written).toBe(false);
    expect(written.kind_other).toBeDefined();
  });
});

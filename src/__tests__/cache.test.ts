import { describe, it, expect } from "vitest";
import {
  acceptedKeysForSource,
  hashValue,
  buildCacheEntries,
  computeDiff,
  entryHash,
  mergeNamespaceCache,
  pendingRetryKeys,
  viewForLanguage,
  type NamespaceCache,
} from "../cache.js";

describe("hashValue", () => {
  it("returns consistent 8-char hash", () => {
    const h = hashValue("Save");
    expect(h).toHaveLength(8);
    expect(hashValue("Save")).toBe(h);
  });

  it("returns different hash for different values", () => {
    expect(hashValue("Save")).not.toBe(hashValue("Cancel"));
  });
});

describe("buildCacheEntries", () => {
  it("builds hash map from flat entries", () => {
    const entries = { save: "Save", cancel: "Cancel" };
    const cache = buildCacheEntries(entries);
    expect(cache.save).toBe(hashValue("Save"));
    expect(cache.cancel).toBe(hashValue("Cancel"));
  });
});

describe("computeDiff", () => {
  it("marks all keys as missing when no target exists", () => {
    const source = { save: "Save", cancel: "Cancel" };
    const diff = computeDiff(source, {}, {});
    expect(diff.missing).toEqual(["save", "cancel"]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("marks key as unchanged when target exists and cache matches", () => {
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.unchanged).toEqual(["save"]);
    expect(diff.missing).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("marks key as changed when cache hash differs", () => {
    const source = { save: "Save changes" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.changed).toEqual(["save"]);
    expect(diff.unchanged).toEqual([]);
  });

  it("marks key as missing when not in target even if in cache", () => {
    const source = { save: "Save" };
    const target = {};
    const cache = { save: hashValue("Save") };
    const diff = computeDiff(source, target, cache);
    expect(diff.missing).toEqual(["save"]);
  });
});

/**
 * CEL-1543.
 *
 * `.polyglot-cache.json` used to be `{ namespace: { sourceKey: hash } }` with no
 * language dimension, so an eviction could only be expressed by deleting the
 * key — which deleted it for every language, and was undone by the next
 * language's write. The entry now carries per-language PROVENANCE: what each
 * language's value on disk was made from, plus any exception it recorded
 * against it. A bare hash keeps its old meaning so existing cache files load
 * untouched.
 */
describe("viewForLanguage", () => {
  const HASH = hashValue("Save");
  const EDITED = hashValue("Save changes");

  it("reads a legacy bare hash as cached for every language", () => {
    const legacy: NamespaceCache = { save: HASH, cancel: hashValue("Cancel") };

    for (const lang of ["zh", "ru", "de"]) {
      const view = viewForLanguage(legacy, lang);
      expect(view.hashes).toEqual(legacy);
      expect(view.retryHashes).toEqual({});
      expect(view.accepted.size).toBe(0);
    }
  });

  it("gives each language the provenance of its OWN value on disk", () => {
    // zh has already retranslated the edited English; ru has not run since.
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: { hash: EDITED } } },
    };

    expect(viewForLanguage(cache, "zh").hashes).toEqual({ save: EDITED });
    // The entry's own hash is the default for everyone else, and it is frozen
    // at the text ru's file still answers — so ru reads `changed`, not
    // `unchanged`, however many other languages have caught up.
    expect(viewForLanguage(cache, "ru").hashes).toEqual({ save: HASH });
    expect(
      computeDiff({ save: "Save changes" }, { save: "Спасти" }, viewForLanguage(cache, "ru").hashes)
    ).toMatchObject({ changed: ["save"] });
  });

  it("hides a key one language marked stale from that language only", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: { hash: HASH, state: "stale" } } },
    };

    expect(viewForLanguage(cache, "zh").hashes).toEqual({});
    expect(viewForLanguage(cache, "zh").retryHashes).toEqual({ save: HASH });
    // The whole point: ru still has its cache.
    expect(viewForLanguage(cache, "ru").hashes).toEqual({ save: HASH });
    expect(viewForLanguage(cache, "ru").retryHashes).toEqual({});
  });

  it("treats an accepted key as cached and reports the marker", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: { hash: HASH, state: "accepted" } } },
    };

    const zh = viewForLanguage(cache, "zh");
    expect(zh.hashes).toEqual({ save: HASH });
    expect([...zh.accepted]).toEqual(["save"]);
    // The marker is per language — ru never accepted anything.
    expect([...viewForLanguage(cache, "ru").accepted]).toEqual([]);
  });

  it("treats a record with no provenance as uncached, not as the default", () => {
    // Both shapes reach this: a run that kept a value nothing vouched for, and
    // the pre-release `langs: { zh: "stale" }` that carried a state and no hash
    // at all. Falling back to the entry's default would hand the language a
    // provenance it never claimed.
    for (const langs of [{ zh: { state: "stale" } }, { zh: "stale" }]) {
      const cache = {
        save: { hash: HASH, langs },
      } as unknown as NamespaceCache;

      const zh = viewForLanguage(cache, "zh");
      expect(zh.hashes).toEqual({});
      expect(zh.retryHashes).toEqual({});
      expect(viewForLanguage(cache, "ru").hashes).toEqual({ save: HASH });
    }
  });

  it("treats an unreadable entry as uncached rather than throwing", () => {
    const cache = {
      broken: null,
      alsoBroken: { langs: { zh: { hash: HASH, state: "stale" } } },
      fine: HASH,
    } as unknown as NamespaceCache;

    const view = viewForLanguage(cache, "zh");
    expect(view.hashes).toEqual({ fine: HASH });
    expect(entryHash(null)).toBeUndefined();
    expect(entryHash(42)).toBeUndefined();
  });
});

describe("pendingRetryKeys", () => {
  it("returns a key evicted at the English text that is still on disk", () => {
    const cache: NamespaceCache = {
      save: {
        hash: hashValue("Save"),
        langs: { zh: { hash: hashValue("Save"), state: "stale" } },
      },
    };
    const retry = pendingRetryKeys(viewForLanguage(cache, "zh"), {
      save: "Save",
    });
    expect([...retry]).toEqual(["save"]);
  });

  it("does not return a key whose English has changed since the eviction", () => {
    const cache: NamespaceCache = {
      save: {
        hash: hashValue("Save"),
        langs: { zh: { hash: hashValue("Save"), state: "stale" } },
      },
    };
    const retry = pendingRetryKeys(viewForLanguage(cache, "zh"), {
      save: "Save changes",
    });
    expect([...retry]).toEqual([]);
  });

  it("is decided by the DISK VALUE's provenance, not the entry's own hash", () => {
    // The shape a run writes when it keeps a translation of the OLD English and
    // evicts the key: the entry's hash has moved to the new text, the
    // language's record has not. Reading the entry's hash here is how a
    // one-run-old eviction used to vouch for a value made from text that was
    // already gone (CEL-1543).
    const cache: NamespaceCache = {
      save: {
        hash: hashValue("Save changes"),
        langs: { zh: { hash: hashValue("Save"), state: "stale" } },
      },
    };

    const retry = pendingRetryKeys(viewForLanguage(cache, "zh"), {
      save: "Save changes",
    });
    expect([...retry]).toEqual([]);
  });
});

describe("acceptedKeysForSource", () => {
  const HASH = hashValue("Save");

  it("returns an accept recorded against the English being translated", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: { hash: HASH, state: "accepted" } } },
    };

    const accepted = acceptedKeysForSource(viewForLanguage(cache, "zh"), {
      save: "Save",
    });
    expect([...accepted]).toEqual(["save"]);
  });

  it("drops an accept whose English has moved on", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: { hash: HASH, state: "accepted" } } },
    };

    const accepted = acceptedKeysForSource(viewForLanguage(cache, "zh"), {
      save: "Save changes",
    });
    expect([...accepted]).toEqual([]);
  });
});

describe("mergeNamespaceCache", () => {
  const SOURCE = { save: "Save", cancel: "Cancel" };
  const HASHES = buildCacheEntries(SOURCE);

  it("writes a bare hash when a key has no per-language divergence", () => {
    const merged = mergeNamespaceCache({}, "zh", { hashes: HASHES });
    // An all-clean cache file stays byte-identical to the one 0.3.x wrote.
    expect(merged).toEqual(HASHES);
  });

  it("records this language's eviction without touching the others", () => {
    const previous: NamespaceCache = {
      save: {
        hash: HASHES.save,
        langs: { ru: { hash: HASHES.save, state: "accepted" } },
      },
      cancel: HASHES.cancel,
    };

    const merged = mergeNamespaceCache(previous, "zh", {
      hashes: HASHES,
      stale: ["save"],
    });

    expect(merged.save).toEqual({
      hash: HASHES.save,
      langs: {
        ru: { hash: HASHES.save, state: "accepted" },
        zh: { hash: HASHES.save, state: "stale" },
      },
    });
    expect(merged.cancel).toBe(HASHES.cancel);
  });

  it("clears this language's own marker when the run no longer reports it", () => {
    const previous: NamespaceCache = {
      save: {
        hash: HASHES.save,
        langs: {
          zh: { hash: HASHES.save, state: "stale" },
          ru: { hash: HASHES.save, state: "stale" },
        },
      },
      cancel: HASHES.cancel,
    };

    const merged = mergeNamespaceCache(previous, "zh", { hashes: HASHES });

    // zh retried and succeeded; ru has not run since and keeps its eviction.
    expect(merged.save).toEqual({
      hash: HASHES.save,
      langs: { ru: { hash: HASHES.save, state: "stale" } },
    });
  });

  it("freezes the default provenance, so an English edit reaches EVERY language", () => {
    // The defect this replaces: the entry's hash was rewritten to the current
    // text by whichever language ran first, and every later language then read
    // its own stale file as cached. `-o zh,ru` and `-o zh` then `-o ru` were
    // equally broken, and no amount of per-language state fixed it while the
    // hash a language is measured against belonged to somebody else.
    const previous: NamespaceCache = { save: hashValue("Save") };
    const edited = { save: hashValue("Save changes") };

    const merged = mergeNamespaceCache(previous, "zh", { hashes: edited });

    expect(merged.save).toEqual({
      hash: hashValue("Save"),
      langs: { zh: { hash: hashValue("Save changes") } },
    });
    // zh has caught up; ru has not, and says so.
    expect(viewForLanguage(merged, "zh").hashes).toEqual(edited);
    expect(viewForLanguage(merged, "ru").hashes).toEqual(previous);
  });

  it("lets a marker expire on new English without deleting it", () => {
    const previous: NamespaceCache = {
      save: {
        hash: hashValue("Save"),
        langs: {
          zh: { hash: hashValue("Save"), state: "accepted" },
          ru: { hash: hashValue("Save"), state: "stale" },
        },
      },
    };

    const merged = mergeNamespaceCache(previous, "de", {
      hashes: { save: hashValue("Save changes") },
    });

    // The markers are still on the record, but they answer text that is gone,
    // so neither can vouch for anything: zh is `changed` rather than accepted,
    // and ru's eviction is not retry-eligible.
    const source = { save: "Save changes" };
    expect(
      [...acceptedKeysForSource(viewForLanguage(merged, "zh"), source)]
    ).toEqual([]);
    expect(
      [...pendingRetryKeys(viewForLanguage(merged, "ru"), source)]
    ).toEqual([]);
  });

  it("records what the value on disk answers, not the hash that is current", () => {
    // Run A of the laundering trace: English moved to "Save changes", the
    // provider degraded, and the translation of "Save" was kept. Stamping the
    // eviction with the CURRENT hash made run B read it as "evicted at exactly
    // this text" and accept a translation of text that is gone.
    const merged = mergeNamespaceCache({ save: hashValue("Save") }, "zh", {
      hashes: { save: hashValue("Save changes") },
      provenance: { save: hashValue("Save") },
      stale: ["save"],
    });

    expect(merged.save).toEqual({
      hash: hashValue("Save"),
      langs: { zh: { hash: hashValue("Save"), state: "stale" } },
    });
    expect([
      ...pendingRetryKeys(viewForLanguage(merged, "zh"), {
        save: "Save changes",
      }),
    ]).toEqual([]);
  });

  it("records no provenance when nothing vouches for the value on disk", () => {
    // A supplied map that omits the key: the run kept a previous translation it
    // had no cache entry behind. Claiming the current hash would be the same
    // laundering by another route.
    const merged = mergeNamespaceCache({ save: hashValue("Save") }, "zh", {
      hashes: { save: hashValue("Save") },
      provenance: {},
      stale: ["save"],
    });

    expect(merged.save).toEqual({
      hash: hashValue("Save"),
      langs: { zh: { state: "stale" } },
    });
    const zh = viewForLanguage(merged, "zh");
    expect(zh.hashes).toEqual({});
    expect(zh.retryHashes).toEqual({});
  });

  it("drops keys the English source no longer has", () => {
    const previous: NamespaceCache = {
      save: HASHES.save,
      removed: {
        hash: hashValue("Gone"),
        langs: { zh: { hash: hashValue("Gone"), state: "stale" } },
      },
    };

    const merged = mergeNamespaceCache(previous, "zh", {
      hashes: { save: HASHES.save },
    });

    expect(Object.keys(merged)).toEqual(["save"]);
  });

  it("upgrades a legacy entry in place, leaving unlisted languages cached", () => {
    const legacy: NamespaceCache = { save: HASHES.save, cancel: HASHES.cancel };

    const merged = mergeNamespaceCache(legacy, "zh", {
      hashes: HASHES,
      stale: ["save"],
    });

    expect(merged.save).toEqual({
      hash: HASHES.save,
      langs: { zh: { hash: HASHES.save, state: "stale" } },
    });
    // Migration is incremental: only the key that needed an exception grew one.
    expect(merged.cancel).toBe(HASHES.cancel);
    // And ru — never run since the migration — keeps the blanket the legacy
    // entry gave it, so one language's eviction costs no other language a
    // retranslation.
    expect(viewForLanguage(merged, "ru").hashes).toEqual(HASHES);
  });

  it("lets an eviction beat an accept for the same key", () => {
    const merged = mergeNamespaceCache({}, "zh", {
      hashes: HASHES,
      stale: ["save"],
      accepted: ["save"],
    });

    expect(merged.save).toEqual({
      hash: HASHES.save,
      langs: { zh: { hash: HASHES.save, state: "stale" } },
    });
  });
});


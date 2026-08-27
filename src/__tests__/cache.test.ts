import { describe, it, expect } from "vitest";
import {
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
 * language's write. The entry now carries per-language exceptions, and a bare
 * hash keeps its old meaning so existing cache files load untouched.
 */
describe("viewForLanguage", () => {
  const HASH = hashValue("Save");

  it("reads a legacy bare hash as cached for every language", () => {
    const legacy: NamespaceCache = { save: HASH, cancel: hashValue("Cancel") };

    for (const lang of ["zh", "ru", "de"]) {
      const view = viewForLanguage(legacy, lang);
      expect(view.hashes).toEqual(legacy);
      expect(view.retryHashes).toEqual({});
      expect(view.accepted.size).toBe(0);
    }
  });

  it("hides a key one language marked stale from that language only", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: "stale" } },
    };

    expect(viewForLanguage(cache, "zh").hashes).toEqual({});
    expect(viewForLanguage(cache, "zh").retryHashes).toEqual({ save: HASH });
    // The whole point: ru still has its cache.
    expect(viewForLanguage(cache, "ru").hashes).toEqual({ save: HASH });
    expect(viewForLanguage(cache, "ru").retryHashes).toEqual({});
  });

  it("treats an accepted key as cached and reports the marker", () => {
    const cache: NamespaceCache = {
      save: { hash: HASH, langs: { zh: "accepted" } },
    };

    const zh = viewForLanguage(cache, "zh");
    expect(zh.hashes).toEqual({ save: HASH });
    expect([...zh.accepted]).toEqual(["save"]);
    // The marker is per language — ru never accepted anything.
    expect([...viewForLanguage(cache, "ru").accepted]).toEqual([]);
  });

  it("treats an unreadable entry as uncached rather than throwing", () => {
    const cache = {
      broken: null,
      alsoBroken: { langs: { zh: "stale" } },
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
      save: { hash: hashValue("Save"), langs: { zh: "stale" } },
    };
    const retry = pendingRetryKeys(viewForLanguage(cache, "zh"), {
      save: "Save",
    });
    expect([...retry]).toEqual(["save"]);
  });

  it("does not return a key whose English has changed since the eviction", () => {
    const cache: NamespaceCache = {
      save: { hash: hashValue("Save"), langs: { zh: "stale" } },
    };
    const retry = pendingRetryKeys(viewForLanguage(cache, "zh"), {
      save: "Save changes",
    });
    expect([...retry]).toEqual([]);
  });
});

describe("mergeNamespaceCache", () => {
  const SOURCE = { save: "Save", cancel: "Cancel" };
  const HASHES = buildCacheEntries(SOURCE);

  it("writes a bare hash when a key has no per-language exception", () => {
    const merged = mergeNamespaceCache({}, "zh", { hashes: HASHES });
    // An all-clean cache file stays byte-identical to the one 0.3.x wrote.
    expect(merged).toEqual(HASHES);
  });

  it("records this language's eviction without touching the others", () => {
    const previous: NamespaceCache = {
      save: { hash: HASHES.save, langs: { ru: "accepted" } },
      cancel: HASHES.cancel,
    };

    const merged = mergeNamespaceCache(previous, "zh", {
      hashes: HASHES,
      stale: ["save"],
    });

    expect(merged.save).toEqual({
      hash: HASHES.save,
      langs: { ru: "accepted", zh: "stale" },
    });
    expect(merged.cancel).toBe(HASHES.cancel);
  });

  it("clears this language's own marker when the run no longer reports it", () => {
    const previous: NamespaceCache = {
      save: { hash: HASHES.save, langs: { zh: "stale", ru: "stale" } },
      cancel: HASHES.cancel,
    };

    const merged = mergeNamespaceCache(previous, "zh", { hashes: HASHES });

    // zh retried and succeeded; ru has not run since and keeps its eviction.
    expect(merged.save).toEqual({ hash: HASHES.save, langs: { ru: "stale" } });
  });

  it("drops every language's state when the English text changes", () => {
    const previous: NamespaceCache = {
      save: { hash: hashValue("Save"), langs: { zh: "accepted", ru: "stale" } },
    };

    const merged = mergeNamespaceCache(previous, "de", {
      hashes: { save: hashValue("Save changes") },
    });

    // New English invalidates every language at once; a marker written against
    // text that is gone would send a language on a retry it never asked for.
    expect(merged.save).toBe(hashValue("Save changes"));
  });

  it("drops keys the English source no longer has", () => {
    const previous: NamespaceCache = {
      save: HASHES.save,
      removed: { hash: hashValue("Gone"), langs: { zh: "stale" } },
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

    expect(merged.save).toEqual({ hash: HASHES.save, langs: { zh: "stale" } });
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

    expect(merged.save).toEqual({ hash: HASHES.save, langs: { zh: "stale" } });
  });
});

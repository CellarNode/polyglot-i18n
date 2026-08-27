import { createHash } from "node:crypto";

export interface DiffResult {
  missing: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * Per-language exception to "this source key is cached".
 *
 * - `stale` — the language evicted the key and must retry it. Recorded rather
 *   than deleted so the eviction survives the process: 0.3.x held the union of
 *   every language's evictions in memory and rewrote the whole namespace on
 *   each language's turn, so a second invocation (`-o zh` then `-o ru`) put the
 *   key back and the value the first run could not vouch for was cached
 *   forever (CEL-1543).
 * - `accepted` — the language attempted the key, could not improve on what is
 *   already on disk, and stopped asking. Cached like a clean key, and it
 *   additionally suppresses the English-fallback plural re-queue. Cleared the
 *   moment the English text changes, or by `--force`.
 */
export type LangCacheState = "stale" | "accepted";

export interface CacheRecord {
  /** Hash of the English source this record was written for. */
  hash: string;
  /**
   * Languages that deviate from "cached at `hash`". A language absent from
   * this map is cached — which is safe because a language with no value on
   * disk is classified `missing` by `computeDiff` before the cache is ever
   * consulted, so "cached" can only be reached by a language that has one.
   */
  langs?: Record<string, LangCacheState>;
}

/**
 * A bare hash is the 0.3.x shape: language-INDEPENDENT, and read as "cached for
 * every language". It is also what 0.4.0 writes whenever a key has no
 * per-language exceptions, so an all-clean cache file is byte-identical to the
 * one the previous version produced and the format only widens where it must.
 */
export type CacheEntry = string | CacheRecord;

export type NamespaceCache = Record<string, CacheEntry>;

export type FullCache = Record<string, NamespaceCache>;

/** One language's read view of a namespace cache. */
export interface LanguageCacheView {
  /** `{ sourceKey: hash }` for keys this language may skip — feeds `computeDiff`. */
  hashes: Record<string, string>;
  /** `{ sourceKey: hash }` for keys this language evicted and must retry. */
  retryHashes: Record<string, string>;
  /** Source keys this language accepted a flagged value for, at the cached hash. */
  accepted: Set<string>;
}

/** What one language reports back about a namespace after translating it. */
export interface NamespaceCacheUpdate {
  /** Every source key of the namespace with its current hash. */
  hashes: Record<string, string>;
  /** Source keys this language must retry on the next run. */
  stale?: Iterable<string>;
  /** Source keys this language has stopped asking about. */
  accepted?: Iterable<string>;
}

/**
 * Returns first 8 chars of SHA-256 hash.
 */
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * The source hash a cache entry carries, in either format. Returns `undefined`
 * for anything unrecognisable — a hand-edited or truncated cache file then
 * degrades to "not cached" (retranslate) instead of throwing.
 */
export function entryHash(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  const hash = (entry as CacheRecord).hash;
  return typeof hash === "string" ? hash : undefined;
}

/** The recorded exception for one language, if the entry carries one. */
export function entryLangState(
  entry: unknown,
  lang: string
): LangCacheState | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const langs = (entry as CacheRecord).langs;
  if (langs === null || typeof langs !== "object") return undefined;
  const state = (langs as Record<string, unknown>)[lang];
  return state === "stale" || state === "accepted" ? state : undefined;
}

/**
 * Resolves a namespace cache for one language.
 *
 * A legacy (bare-hash) entry resolves to "cached", exactly as 0.3.x behaved:
 * an existing cache file keeps skipping everything it used to skip, and only
 * diverges once a language records an exception on it.
 */
export function viewForLanguage(
  namespaceCache: NamespaceCache,
  lang: string
): LanguageCacheView {
  const hashes: Record<string, string> = {};
  const retryHashes: Record<string, string> = {};
  const accepted = new Set<string>();

  for (const [key, entry] of Object.entries(namespaceCache ?? {})) {
    const hash = entryHash(entry);
    if (hash === undefined) continue;
    const state = entryLangState(entry, lang);
    if (state === "stale") {
      retryHashes[key] = hash;
      continue;
    }
    hashes[key] = hash;
    if (state === "accepted") accepted.add(key);
  }

  return { hashes, retryHashes, accepted };
}

/**
 * Source keys this language evicted at the SAME English text it is about to
 * translate again.
 *
 * `computeDiff` cannot tell those apart from a key whose English genuinely
 * changed — both arrive with no cached hash — but the distinction decides
 * whether a previous translation is still an answer to the current source, and
 * therefore whether a degraded retry may be accepted instead of retried
 * forever.
 */
export function pendingRetryKeys(
  view: LanguageCacheView,
  sourceFlat: Record<string, string>
): Set<string> {
  const keys = new Set<string>();
  for (const [key, hash] of Object.entries(view.retryHashes)) {
    if (key in sourceFlat && hashValue(sourceFlat[key]) === hash) keys.add(key);
  }
  return keys;
}

/**
 * Folds one language's result into a namespace cache, leaving every other
 * language's state alone.
 *
 * The result is rebuilt from `update.hashes`, so a key deleted from the English
 * source drops out of the cache exactly as it did before. Per-language state is
 * carried forward ONLY while the hash is unchanged: new English text
 * invalidates every language at once, and a `stale` marker left over from the
 * old text would send that language on a retry it never asked for.
 */
export function mergeNamespaceCache(
  previous: NamespaceCache,
  lang: string,
  update: NamespaceCacheUpdate
): NamespaceCache {
  const stale = new Set(update.stale ?? []);
  const accepted = new Set(update.accepted ?? []);
  const next: NamespaceCache = {};

  for (const [key, hash] of Object.entries(update.hashes)) {
    const prev = previous?.[key];
    const carried: Record<string, LangCacheState> =
      entryHash(prev) === hash &&
      prev !== null &&
      typeof prev === "object" &&
      prev.langs
        ? { ...prev.langs }
        : {};

    delete carried[lang];
    if (stale.has(key)) carried[lang] = "stale";
    else if (accepted.has(key)) carried[lang] = "accepted";

    next[key] =
      Object.keys(carried).length === 0 ? hash : { hash, langs: carried };
  }

  return next;
}

/**
 * Builds a cache map: { dotPath: hash } from source entries.
 */
export function buildCacheEntries(
  sourceFlat: Record<string, string>
): Record<string, string> {
  const cache: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    cache[key] = hashValue(value);
  }
  return cache;
}

/**
 * Computes which keys need translation by comparing source, target, and cache.
 *
 * `cacheEntries` is ONE language's resolved view (`viewForLanguage(...).hashes`),
 * not the raw file: a key another language evicted must not look changed here.
 */
export function computeDiff(
  sourceFlat: Record<string, string>,
  targetFlat: Record<string, string>,
  cacheEntries: Record<string, string>
): DiffResult {
  const missing: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const key of Object.keys(sourceFlat)) {
    if (!(key in targetFlat) || targetFlat[key] === "") {
      missing.push(key);
    } else {
      const currentHash = hashValue(sourceFlat[key]);
      const cachedHash = cacheEntries[key];
      if (cachedHash && cachedHash === currentHash) {
        unchanged.push(key);
      } else {
        changed.push(key);
      }
    }
  }

  return { missing, changed, unchanged };
}

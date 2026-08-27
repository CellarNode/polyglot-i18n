import { createHash } from "node:crypto";

export interface DiffResult {
  missing: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * Per-language exception to "this source key is done".
 *
 * - `stale` — the language could not vouch for its value and must retry the
 *   key. Recorded rather than deleted so the eviction survives the process:
 *   0.3.x held the union of every language's evictions in memory and rewrote
 *   the whole namespace on each language's turn, so a second invocation
 *   (`-o zh` then `-o ru`) put the key back and the value the first run could
 *   not vouch for was cached forever (CEL-1543).
 * - `accepted` — the language attempted the key, could not improve on what is
 *   already on disk, and stopped asking. Cached like a clean key, and it
 *   additionally suppresses the English-fallback plural re-queue.
 *
 * Neither state carries an expiry of its own. `LangProvenance.hash` is what
 * expires them: both are recorded against the English the value on disk
 * answers, and any edit to that English makes the key `changed` again.
 */
export type LangCacheState = "stale" | "accepted";

/**
 * What one language's value on disk is, as far as the cache knows.
 *
 * `hash` is the PROVENANCE of that value — the English text it was made from —
 * not the English text that happened to be current when the record was
 * written. The distinction is the whole of CEL-1543's first defect: a marker
 * stamped with the current hash lets the next run read "this was evicted at
 * exactly this text" off an eviction that in fact kept a translation of the
 * PREVIOUS text, and accept it. Provenance travels with the value, so it
 * cannot be laundered by the passage of a run.
 *
 * `hash` is absent when nothing knows what the value on disk answers — a run
 * kept a previous translation it had no cache entry for. Such a value is never
 * "cached" and never accept-eligible; it is retranslated until a run produces
 * something it can vouch for.
 */
export interface LangProvenance {
  /** English hash the value on disk for this language answers, if known. */
  hash?: string;
  /** Exception this language recorded against that value, if any. */
  state?: LangCacheState;
}

export interface CacheRecord {
  /**
   * Provenance for languages NOT named in `langs`.
   *
   * FROZEN at the value the entry already carried: it is only ever set when
   * the entry is first created. Advancing it to the current English would
   * promote every language that has not run since — whose file still answers
   * the old text — to "cached", which is how an English edit used to be
   * retranslated for the first language of a run and silently skipped for all
   * the others (CEL-1543).
   */
  hash?: string;
  /** Languages with their own provenance, or an exception, or both. */
  langs?: Record<string, LangProvenance>;
}

/**
 * A bare hash is the 0.3.x shape: language-INDEPENDENT, and read as "every
 * language's value on disk answers this text". It is also what 0.4.0 writes
 * whenever a key has no per-language divergence, so an all-clean cache file is
 * byte-identical to the one the previous version produced and the format only
 * widens where it must.
 */
export type CacheEntry = string | CacheRecord;

export type NamespaceCache = Record<string, CacheEntry>;

export type FullCache = Record<string, NamespaceCache>;

/** One language's read view of a namespace cache. */
export interface LanguageCacheView {
  /**
   * `{ sourceKey: provenanceHash }` for keys this language may skip — feeds
   * `computeDiff`, which compares each against the CURRENT English hash. A key
   * this language is simply behind on therefore reads as `changed`, per
   * language, no matter which language ran last.
   */
  hashes: Record<string, string>;
  /** `{ sourceKey: provenanceHash }` for keys this language evicted. */
  retryHashes: Record<string, string>;
  /** Source keys this language recorded an `accepted` marker for. */
  accepted: Set<string>;
}

/** What one language reports back about a namespace after translating it. */
export interface NamespaceCacheUpdate {
  /** Every source key of the namespace with its CURRENT English hash. */
  hashes: Record<string, string>;
  /**
   * English hash the value this language leaves on disk answers, per source
   * key. A key ABSENT from a supplied map has NO known provenance — the run
   * kept something nothing vouches for — and is recorded without a hash, so it
   * is never cached and never accept-eligible. Omitting the whole field means
   * "every key answers its current hash".
   */
  provenance?: Record<string, string>;
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
 * The default provenance a cache entry carries, in either format. Returns
 * `undefined` for anything unrecognisable — a hand-edited or truncated cache
 * file then degrades to "not cached" (retranslate) instead of throwing.
 */
export function entryHash(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  const hash = (entry as CacheRecord).hash;
  return typeof hash === "string" ? hash : undefined;
}

function entryLangs(entry: unknown): Record<string, unknown> | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const langs = (entry as CacheRecord).langs;
  if (langs === null || typeof langs !== "object") return undefined;
  return langs as Record<string, unknown>;
}

/**
 * Reads one language's record, or `undefined` when the entry does not hold a
 * usable one.
 *
 * A record with no readable `hash` is returned WITH its state and without a
 * hash rather than dropped: dropping it would hand the language the entry's
 * default provenance and quietly promote a value nobody vouched for to
 * "cached". That also covers the pre-release `langs: { zh: "stale" }` shape,
 * which carried a state but no provenance at all.
 */
export function entryLangProvenance(
  entry: unknown,
  lang: string
): LangProvenance | undefined {
  const langs = entryLangs(entry);
  if (langs === undefined || !(lang in langs)) return undefined;
  return parseProvenance(langs[lang]);
}

function parseProvenance(raw: unknown): LangProvenance {
  if (raw === "stale" || raw === "accepted") return { state: raw };
  if (raw === null || typeof raw !== "object") return {};
  const record = raw as LangProvenance;
  const provenance: LangProvenance = {};
  if (typeof record.hash === "string") provenance.hash = record.hash;
  if (record.state === "stale" || record.state === "accepted") {
    provenance.state = record.state;
  }
  return provenance;
}

/**
 * Resolves a namespace cache for one language.
 *
 * A legacy (bare-hash) entry resolves to "cached", exactly as 0.3.x behaved:
 * an existing cache file keeps skipping everything it used to skip, and only
 * diverges once a language records its own provenance on it.
 */
export function viewForLanguage(
  namespaceCache: NamespaceCache,
  lang: string
): LanguageCacheView {
  const hashes: Record<string, string> = {};
  const retryHashes: Record<string, string> = {};
  const accepted = new Set<string>();

  for (const [key, entry] of Object.entries(namespaceCache ?? {})) {
    const own = entryLangProvenance(entry, lang);
    // No record of its own: the language is covered by the entry's default,
    // which is frozen at the text it was created for.
    const hash = own === undefined ? entryHash(entry) : own.hash;
    if (hash === undefined) continue;

    if (own?.state === "stale") {
      retryHashes[key] = hash;
      continue;
    }
    hashes[key] = hash;
    if (own?.state === "accepted") accepted.add(key);
  }

  return { hashes, retryHashes, accepted };
}

/**
 * Source keys this language evicted, whose value on disk was made from the
 * English text it is about to translate again.
 *
 * `computeDiff` cannot tell those apart from a key whose English genuinely
 * changed — both arrive with no cached hash — but the distinction decides
 * whether a previous translation is still an answer to the current source, and
 * therefore whether a degraded retry may be accepted instead of retried
 * forever.
 *
 * The comparison is against the PROVENANCE of the value on disk, not the hash
 * that was current when the eviction was written. An eviction that kept a
 * translation of the previous English therefore never becomes eligible, no
 * matter how many runs pass.
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
 * Accepted keys whose value on disk still answers the current English.
 *
 * An accept vouches for one value against one text. `computeDiff` already
 * reclassifies a key whose provenance moved on as `changed`, so this is the
 * same rule applied to the two places the marker is read directly: carrying
 * the accept forward, and suppressing the English-fallback plural re-queue.
 */
export function acceptedKeysForSource(
  view: LanguageCacheView,
  sourceFlat: Record<string, string>
): Set<string> {
  const keys = new Set<string>();
  for (const key of view.accepted) {
    if (key in sourceFlat && hashValue(sourceFlat[key]) === view.hashes[key]) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Folds one language's result into a namespace cache, leaving every other
 * language's record alone.
 *
 * The result is rebuilt from `update.hashes`, so a key deleted from the English
 * source drops out of the cache exactly as it did before. Two rules hold the
 * merge up:
 *
 * - the acting language always writes its own provenance, and only its own;
 * - the entry's default provenance is FROZEN. Every language absent from
 *   `langs` is covered by it, and this merge cannot know which languages those
 *   are — a locale the user has not run in months is still on disk. Advancing
 *   the default to the current English would tell all of them their old files
 *   are current.
 */
export function mergeNamespaceCache(
  previous: NamespaceCache,
  lang: string,
  update: NamespaceCacheUpdate
): NamespaceCache {
  const stale = new Set(update.stale ?? []);
  const accepted = new Set(update.accepted ?? []);
  const next: NamespaceCache = {};

  for (const [key, currentHash] of Object.entries(update.hashes)) {
    const prev = previous?.[key];

    const mine: LangProvenance = {};
    const provenance = update.provenance
      ? update.provenance[key]
      : currentHash;
    if (provenance !== undefined) mine.hash = provenance;
    if (stale.has(key)) mine.state = "stale";
    else if (accepted.has(key)) mine.state = "accepted";

    // A key the cache has never seen has no other language to protect, so the
    // acting language's provenance becomes the default and the entry can stay
    // a bare hash. From then on the default never moves.
    const defaultHash = entryHash(prev) ?? mine.hash;

    const langs: Record<string, LangProvenance> = {};
    for (const [other, raw] of Object.entries(entryLangs(prev) ?? {})) {
      if (other === lang) continue;
      langs[other] = parseProvenance(raw);
    }
    if (mine.hash !== defaultHash || mine.state !== undefined) {
      langs[lang] = mine;
    }

    if (Object.keys(langs).length === 0 && defaultHash !== undefined) {
      next[key] = defaultHash;
      continue;
    }
    next[key] =
      defaultHash === undefined ? { langs } : { hash: defaultHash, langs };
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
 * not the raw file: it holds what THAT language's value on disk answers, so a
 * key another language evicted must not look changed here, and a key another
 * language has already retranslated must not look unchanged.
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

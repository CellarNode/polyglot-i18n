import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { flattenJSON, unflattenJSON } from "./json-utils.js";
import {
  acceptedKeysForSource,
  computeDiff,
  buildCacheEntries,
  mergeNamespaceCache,
  pendingRetryKeys,
  viewForLanguage,
  type DiffResult,
  type FullCache,
} from "./cache.js";
import { usesNonLatinScript } from "./leak-guard.js";
import { chunkEntries } from "./chunk.js";
import { validatePlaceholders } from "./placeholder.js";
import {
  classifyIncompletePluralGroups,
  collectPluralGroups,
  expandPluralFallback,
  incompletePluralSourceKeys,
  indexGroupsBySourceKey,
  isEnglishFallbackGroup,
  rejectedPluralBases,
  representativeKey,
  sourceFormFor,
  splitPluralKey,
  toPluralExpansion,
  PLURAL_CATEGORIES,
  type PluralGroup,
  type PluralRejectReason,
} from "./plurals.js";
import type {
  TranslationProvider,
  TranslationEntry,
} from "./providers/types.js";

export interface TranslateOptions {
  input: string;
  outputLanguages: string[];
  provider: TranslationProvider;
  outputDir?: string;
  force?: boolean;
  dryRun?: boolean;
  cacheFile?: string;
  noCache?: boolean;
  context?: string;
}

export interface TranslateResult {
  /** SOURCE keys that received a fresh translation. */
  translated: number;
  /** SOURCE keys skipped because the cache says the source is unchanged. */
  skipped: number;
  /** SOURCE keys retranslated because the English source changed. */
  changed: number;
  /**
   * EMITTED keys that could not be written — a different unit from the three
   * above, because one source key can emit four locale entries in a language
   * with four plural categories. `errors` is a third unit again: one line per
   * emitted key from the guard, one line per chunk from a provider outage.
   */
  failed: number;
  warnings: string[];
  errors: string[];
  files: string[];
  elapsed?: string;
}

export interface NamespaceResult {
  /** SOURCE keys that received a fresh translation. */
  translated: number;
  /** SOURCE keys skipped because the cache says the source is unchanged. */
  skipped: number;
  /** SOURCE keys retranslated because the English source changed. */
  changed: number;
  /** EMITTED keys that could not be written — see `TranslateResult.failed`. */
  failed: number;
  warnings: string[];
  errors: string[];
  output: Record<string, string>;
  /**
   * English hash the value this run leaves on disk answers, per SOURCE key.
   *
   * The current hash wherever the run wrote fresh provider output; the hash the
   * value already carried wherever it kept what was on disk. A key is ABSENT
   * when the run kept a value nothing knows the provenance of — the cache then
   * records it without a hash, so it is never skipped and never accepted.
   *
   * This, not the run's own timing, is what a later run's accept is checked
   * against: an eviction stamped with the hash that happened to be current
   * would vouch for a translation of text that had already been replaced
   * (CEL-1543).
   */
  sourceProvenance: Record<string, string>;
  /**
   * SOURCE keys this language must retry on the next run — it failed them, or
   * degraded them with nothing better already on disk. Recorded per language so
   * the eviction survives the process: the whole point of CEL-1543.
   */
  staleSourceKeys: string[];
  /**
   * SOURCE keys this language has stopped asking about: it attempted them and
   * could not improve on what the target file already holds. Cached like a
   * clean key, and carried forward untouched by any run that does not
   * re-attempt them.
   */
  acceptedSourceKeys: string[];
  /**
   * Key order for the written file: English source order, with each plural
   * group replaced by the full category set the target language needs. This is
   * a superset of `Object.keys(sourceFlat)` — the target may carry plural
   * categories English does not have.
   */
  outputKeyOrder: string[];
}

const REJECT_DETAIL: Record<PluralRejectReason, string> = {
  "no-other-variant": 'no "_other" variant, which i18next requires',
  "lone-other-without-count":
    'a lone "_other" with no count placeholder — an enum member, not a plural',
};

const CHUNK_SIZE = 30;
const CHUNK_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressBar(current: number, total: number, width = 20): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = Math.round((current / total) * 100);
  return `${bar} ${pct}%`;
}

function elapsed(startMs: number): string {
  const s = Math.round((Date.now() - startMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * English source order, with every plural group expanded to the categories the
 * target language requires (the group's variants are emitted together at the
 * position of its first source key).
 */
function buildOutputKeyOrder(
  sourceFlat: Record<string, string>,
  pluralGroups: Map<string, PluralGroup>
): string[] {
  const order: string[] = [];
  const emittedBases = new Set<string>();

  for (const key of Object.keys(sourceFlat)) {
    const parts = splitPluralKey(key);
    const group = parts ? pluralGroups.get(parts.base) : undefined;

    if (!group) {
      order.push(key);
      continue;
    }
    if (emittedBases.has(group.base)) continue;
    emittedBases.add(group.base);
    for (const category of group.targetCategories) {
      order.push(`${group.base}_${category}`);
    }
  }

  return order;
}

/**
 * Translates a single namespace (flat key-value map) to one target language.
 */
export async function translateNamespace(opts: {
  sourceFlat: Record<string, string>;
  targetFlat: Record<string, string>;
  cacheEntries: Record<string, string>;
  provider: TranslationProvider;
  targetLang: string;
  force: boolean;
  context?: string;
  /**
   * Source keys this language already accepted a flagged value for, at the hash
   * `cacheEntries` carries. They are cached like any other key, and they
   * additionally suppress the English-fallback plural re-queue that would
   * otherwise retranslate the group on every run forever.
   */
  cachedAcceptedKeys?: ReadonlySet<string>;
  /**
   * Source keys this language evicted on an earlier run, whose value on disk
   * WAS MADE FROM the English text now in `sourceFlat`. `computeDiff` reports
   * those as `changed` — it sees no cached hash and cannot tell why — but the
   * distinction matters: a previous translation is still an answer to the
   * current source, so a value the provider degrades on this attempt may be
   * accepted instead of retried forever.
   *
   * The membership test is the PROVENANCE of the value on disk, not the run
   * that evicted it (`pendingRetryKeys`). A key whose English changed after the
   * translation was made is therefore never eligible, however many runs have
   * passed since — the translation on disk renders text that is gone.
   */
  retriedSourceKeys?: ReadonlySet<string>;
}): Promise<NamespaceResult> {
  const {
    sourceFlat,
    targetFlat,
    cacheEntries,
    provider,
    targetLang,
    force,
    context,
  } = opts;
  const cachedAccepted = opts.cachedAcceptedKeys ?? new Set<string>();
  const retriedKeys = opts.retriedSourceKeys ?? new Set<string>();

  // Plural groups are collected for EVERY provider. Only a provider that opts
  // in has them expanded into the request; the rest of the run still needs the
  // full map, because the target file can hold categories English does not have
  // and nothing else in the pipeline knows they belong together.
  const pluralGroups = collectPluralGroups(sourceFlat, targetLang);
  const expansionGroups = provider.supportsPluralExpansion
    ? pluralGroups
    : new Map<string, PluralGroup>();
  const groupBySourceKey = indexGroupsBySourceKey(expansionGroups);

  const output: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  let failedKeys = 0;

  // A base the plural guards reject keeps its own key, but any sibling an
  // earlier run invented for it (`_one`, `_few`, `_many`) has no source key and
  // belongs to no group, so the writer drops it. Correct — i18next would serve
  // those for every count that is not "other" — but it used to happen in total
  // silence, and a locale losing keys deserves a line of output.
  for (const [base, reason] of rejectedPluralBases(sourceFlat)) {
    const orphans = PLURAL_CATEGORIES.map(
      (category) => `${base}_${category}`
    ).filter((key) => key in targetFlat && !(key in sourceFlat));
    if (orphans.length === 0) continue;
    warnings.push(
      `"${base}" is not a plural group (${REJECT_DETAIL[reason]}); ` +
        `dropping ${orphans.length} stale sibling(s) from the ${targetLang} file: ` +
        orphans.join(", ")
    );
  }

  // Groups whose target file reproduces the English source verbatim, as they
  // stand BEFORE this run touches anything. Held separately so a group that
  // comes back English a SECOND time can be recognised as converged rather than
  // re-queued on every run forever (see the acceptance pass below).
  const preRunFallback = new Set(
    classifyIncompletePluralGroups(targetFlat, expansionGroups).englishFallback
  );

  let keysToTranslate: string[];
  let diff: DiffResult;

  if (force) {
    keysToTranslate = Object.keys(sourceFlat);
    diff = { missing: keysToTranslate, changed: [], unchanged: [] };
  } else {
    diff = computeDiff(sourceFlat, targetFlat, cacheEntries);
    keysToTranslate = [...diff.missing, ...diff.changed];

    // A plural group whose target file is missing a category the language needs
    // must be regenerated even when every English source key is unchanged —
    // otherwise locales written before plural expansion never gain _few/_many.
    // Gated on `expansionGroups`: a provider that cannot expand plurals could
    // never fill those categories, so queueing them would retranslate the whole
    // group on every run and still write nothing.
    const queued = new Set(keysToTranslate);
    const incomplete = incompletePluralSourceKeys(
      targetFlat,
      expansionGroups,
      cachedAccepted
    ).filter((key) => {
      if (queued.has(key)) return false;
      queued.add(key);
      return true;
    });

    if (incomplete.length > 0) {
      const incompleteSet = new Set(incomplete);
      keysToTranslate = [...keysToTranslate, ...incomplete];
      diff = {
        missing: [...diff.missing, ...incomplete],
        changed: diff.changed,
        unchanged: diff.unchanged.filter((key) => !incompleteSet.has(key)),
      };
    }
  }

  const currentHashes = buildCacheEntries(sourceFlat);

  /**
   * The English text the value currently on disk for `key` was made from, as
   * far as anything knows.
   *
   * A cached key answers the hash the cache holds for it. A key this language
   * evicted at the same English answers the current one — `retriedSourceKeys`
   * is the only carrier of that fact, because `computeDiff` cannot see it.
   * Everything else is `undefined`: a value with no cache entry behind it is a
   * value nothing has ever vouched for, and guessing "current" there is exactly
   * how a stale translation gets laundered into a permanent one.
   */
  const provenanceOf = (key: string): string | undefined =>
    retriedKeys.has(key) ? currentHashes[key] : cacheEntries[key];

  /**
   * True when the translation on disk answers the English being translated now
   * — the precondition for preferring it over a degraded attempt and then
   * ceasing to ask.
   *
   * `--force` is excluded outright. It is the command a user reaches for to
   * recover from a bad locale file, and 0.3.x always evicted a degraded key
   * under it; letting force mint accepts would freeze exactly the values the
   * flag exists to re-open.
   */
  const sourceStillMatchesDisk = (key: string): boolean => {
    if (force) return false;
    const current = currentHashes[key];
    return current !== undefined && provenanceOf(key) === current;
  };

  /** Source keys whose value on disk this run kept rather than rewrote. */
  const keptPreviousSourceKeys = new Set<string>();

  // Carry over unchanged translations
  for (const key of diff.unchanged) {
    output[key] = targetFlat[key];
  }

  // Carry over target-locale-only plural variants (ru `_few`, `_many`, ...) for
  // groups that are not being retranslated. They have no source key, so the
  // loop above would silently drop them on the next run.
  const retranslating = new Set(keysToTranslate);
  for (const group of pluralGroups.values()) {
    if (group.sourceKeys.some((key) => retranslating.has(key))) continue;
    for (const category of group.targetCategories) {
      const key = `${group.base}_${category}`;
      if (key in targetFlat && !(key in output)) output[key] = targetFlat[key];
    }
  }

  /**
   * Plural categories the TARGET language has but English does not (`_few`,
   * `_many`) carry no source key, so nothing regenerates them unless the
   * provider expands plurals — and the loop above skips the whole group as soon
   * as one of its source keys is being retranslated. Running DeepL over a
   * locale Gemini had expanded therefore deleted every `_few`/`_many` in the
   * file (CEL-1533): the source keys came back translated, the target-only ones
   * were never written, and the writer only emits what `output` holds.
   *
   * Runs here, before the early return, so the merge loop below can still
   * overwrite any of it with a value the provider actually produced.
   */
  for (const group of pluralGroups.values()) {
    for (const category of group.targetCategories) {
      const key = `${group.base}_${category}`;
      if (key in output || key in sourceFlat) continue;
      const previous = targetFlat[key];
      if (previous !== undefined && previous !== "") output[key] = previous;
    }
  }

  const outputKeyOrder = buildOutputKeyOrder(sourceFlat, pluralGroups);

  /** Accepts this run did not re-evaluate survive untouched. */
  const carriedAccepts = [...cachedAccepted].filter(
    (key) => key in sourceFlat && !retranslating.has(key)
  );

  if (keysToTranslate.length === 0) {
    return {
      translated: 0,
      skipped: diff.unchanged.length,
      changed: 0,
      failed: 0,
      warnings,
      errors: [],
      output,
      // Nothing was rewritten, and every source key is `unchanged` — which is
      // to say the cache already holds the current hash for each of them.
      sourceProvenance: { ...currentHashes },
      staleSourceKeys: [],
      acceptedSourceKeys: carriedAccepts,
      outputKeyOrder,
    };
  }

  // Build entries and chunk. A plural group collapses into ONE entry carrying
  // the whole group, so the provider sees every English form together and its
  // categories can never be split across chunks.
  const entries: TranslationEntry[] = [];
  const emittedBases = new Set<string>();
  for (const key of keysToTranslate) {
    const group = groupBySourceKey.get(key);
    if (!group) {
      entries.push({ key, value: sourceFlat[key] });
      continue;
    }
    if (emittedBases.has(group.base)) continue;
    emittedBases.add(group.base);
    const repKey = representativeKey(group);
    entries.push({
      key: repKey,
      value: sourceFlat[repKey],
      plural: toPluralExpansion(group),
    });
  }

  const chunks = chunkEntries(entries, CHUNK_SIZE);
  const translatedEntries: TranslationEntry[] = [];
  const failedSourceKeys = new Set<string>();
  // Every degraded source key — the unit the summary counts, because a degraded
  // key never received a fresh translation whatever the cache then does with it.
  const degradedSourceKeys = new Set<string>();
  // A degraded key normally leaves the cache so the next run tries again. These
  // are the ones where the target file already holds a better answer than the
  // provider can produce, so asking again is pure cost. Per language, so one
  // language's decision to stop asking says nothing about the others.
  const acceptedSourceKeys = new Set<string>();
  /** Degraded keys that must keep their eviction — the accept did not apply. */
  const retrySourceKeys = new Set<string>();
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);

    const chunk = chunks[i];
    const progress = progressBar(i + 1, chunks.length);
    process.stdout.write(
      `\r    ${progress} chunk ${i + 1}/${chunks.length} (${chunk.length} keys) [${elapsed(startTime)}]`
    );

    try {
      const result = await provider.translate(chunk, targetLang, context);
      translatedEntries.push(...result);
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : String(err);
      errors.push(
        `chunk ${i + 1}/${chunks.length}: ${errMsg}`
      );

      // On chunk failure, keep the previous translation where there is one and
      // otherwise leave the key out entirely — writing the English source over
      // a gap is the CEL-1539 defect, and an API outage is no better a reason
      // for it than a bad model response. Same semantics as the guard path.
      for (const entry of chunk) {
        for (const fallback of expandPluralFallback(entry)) {
          failedKeys++;
          const previous = targetFlat[fallback.key];
          const sourceKeys = sourceKeysFor(
            fallback.key,
            sourceFlat,
            pluralGroups
          );
          if (previous !== undefined && previous !== "") {
            translatedEntries.push({ key: fallback.key, value: previous });
            for (const key of sourceKeys) keptPreviousSourceKeys.add(key);
          }
          for (const key of sourceKeys) {
            failedSourceKeys.add(key);
          }
        }
      }

      console.log(
        `\n    ✗ chunk ${i + 1} failed: ${errMsg.slice(0, 80)}`
      );

      // If rate limited, add extra delay before next chunk
      if (
        errMsg.includes("Rate limited") ||
        errMsg.includes("429")
      ) {
        console.log(`    ⏳ Rate limited — waiting 30s before continuing...`);
        await sleep(30000);
      }
    }
  }

  // Clear the progress line
  process.stdout.write("\r" + " ".repeat(100) + "\r");

  // Validate and merge
  for (const entry of translatedEntries) {
    // A provider that flagged the value could not produce trustworthy target
    // text (CEL-1539). Writing it would put English in the locale file, so the
    // key keeps its previous translation — or is left out entirely — and is
    // counted as failed.
    if (entry.failed) {
      failedKeys++;
      errors.push(
        `Key "${entry.key}": ${entry.failed.reason} — ${entry.failed.detail}`
      );
      const previous = targetFlat[entry.key];
      if (previous !== undefined && previous !== "") output[entry.key] = previous;
      for (const key of sourceKeysFor(entry.key, sourceFlat, pluralGroups)) {
        failedSourceKeys.add(key);
        if (previous !== undefined && previous !== "") {
          keptPreviousSourceKeys.add(key);
        }
      }
      continue;
    }

    // A questionable-but-usable value (chiefly one byte-identical to the
    // English source). Never a failure: a filename or a brand-only label is
    // identical by necessity, and failing it would exit non-zero forever. Any
    // previous translation wins, because only the target file can tell a real
    // leak from a string that has no other form.
    if (entry.degraded) {
      const previous = targetFlat[entry.key];
      const keepPrevious = previous !== undefined && previous !== "";
      output[entry.key] = keepPrevious ? previous : entry.value;
      warnings.push(
        `Key "${entry.key}": ${entry.degraded.reason} — ${entry.degraded.detail}; ` +
          (keepPrevious ? "kept the previous translation" : "wrote it anyway")
      );

      // Whether to ask again next run. A previous translation that is NOT the
      // English source is already a better answer than this attempt produced,
      // and the source has not moved since it was made — so the model would see
      // exactly the input that just degraded, and a uniform group like
      // `{{count}} мл` would burn a retry and a retranslation on every run
      // forever. Remembering the accept per language is what CEL-1543's cache
      // dimension makes possible; `--force` or an edit to the English asks
      // again. Anything else keeps its eviction: English on disk, or a
      // translation of English text that is gone, must be retried.
      //
      // The English comparison TRIMS, to the same rule the leak guard blocks
      // on (`value.trim() === sourceText.trim()`). A provider does not trim
      // individual values, so "Product " on disk is the English source with a
      // stray space — treating it as a real translation would accept it and
      // cache the CEL-1539 shape the guard exists to catch.
      const english = resolveSourceValue(entry.key, sourceFlat, pluralGroups);
      const previousBeatsThis =
        keepPrevious &&
        english !== undefined &&
        previous.trim() !== english.trim();
      for (const key of sourceKeysFor(entry.key, sourceFlat, pluralGroups)) {
        degradedSourceKeys.add(key);
        if (keepPrevious) keptPreviousSourceKeys.add(key);
        if (previousBeatsThis && sourceStillMatchesDisk(key)) {
          acceptedSourceKeys.add(key);
        } else {
          // A plural group reaches this loop once per emitted category, so one
          // category with English on disk evicts the whole group even if
          // another category would have been accepted.
          retrySourceKeys.add(key);
        }
      }
      continue;
    }

    output[entry.key] = entry.value;
    const source = resolveSourceValue(entry.key, sourceFlat, pluralGroups);
    if (source === undefined) continue;
    warnings.push(...validatePlaceholders(source, entry.value, entry.key));
  }

  // A plural group that arrived as the English source verbatim was re-queued to
  // be translated again. When the retry hands back the English source AGAIN,
  // asking a third time cannot change the answer — every future run would
  // re-queue it, retranslate it and get the same bytes, at full API cost and
  // with an LLM-nondeterministic value each time.
  //
  // But "cannot change the answer" is only a reason to STOP asking where
  // something has judged the answer acceptable. On a non-Latin target the leak
  // guard reads every value and blocks or degrades a genuine English leak, so a
  // group that reaches here has been examined and waved through: it is English
  // by necessity (`{{count}} PDF`), and the accept is the documented mitigation.
  // On a LATIN-script target the guard does not run at all (see the SCOPE note
  // in leak-guard.ts) — nothing has looked at the value, and an English leak in
  // de/fr/es/it is indistinguishable from a correct one. Accepting there would
  // cache the CEL-1539 shape permanently, so the group is re-queued instead, at
  // the per-run cost CEL-1533 already accepted for it.
  //
  // `--force` never mints an accept either: it is the flag for re-opening
  // decisions, not for making them.
  //
  // Anything the guard flagged sits in `failedSourceKeys` or
  // `degradedSourceKeys` and is excluded here.
  for (const group of expansionGroups.values()) {
    if (!group.sourceKeys.some((key) => preRunFallback.has(key))) continue;
    if (!group.sourceKeys.some((key) => retranslating.has(key))) continue;
    if (
      group.sourceKeys.some(
        (key) => failedSourceKeys.has(key) || degradedSourceKeys.has(key)
      )
    ) {
      continue;
    }
    if (!isEnglishFallbackGroup(output, group)) continue;

    const guardJudgedIt = usesNonLatinScript(targetLang);
    const mayAccept = !force && guardJudgedIt;
    warnings.push(
      `Plural group "${group.base}": the retranslation returned the English ` +
        `source again — ` +
        (mayAccept
          ? `accepted for ${targetLang} and cached; run with --force to ask again`
          : guardJudgedIt
            ? `--force never records an accept, so it will be asked again`
            : `${targetLang} is written in the Latin script, where the leak ` +
              `guard cannot tell an English leak from a value that is English ` +
              `by necessity, so it will be asked again`)
    );
    if (!mayAccept) continue;
    for (const key of group.sourceKeys) acceptedSourceKeys.add(key);
  }

  // A failed key must NOT be cached as translated, or the next run would see
  // the source hash unchanged and skip it forever. An eviction always beats an
  // accept.
  const staleSourceKeys = new Set([...failedSourceKeys, ...retrySourceKeys]);
  for (const key of staleSourceKeys) acceptedSourceKeys.delete(key);
  for (const key of carriedAccepts) {
    if (!staleSourceKeys.has(key)) acceptedSourceKeys.add(key);
  }

  // What each key's value on disk now answers. A key the run rewrote answers
  // the current English; a key whose previous value was kept still answers
  // whatever that value answered, and answers NOTHING knowable when there was
  // no cache entry behind it. Recording the current hash there would let the
  // next run read the eviction as "asked about this exact text" and accept a
  // translation of text that is gone (CEL-1543).
  const sourceProvenance: Record<string, string> = { ...currentHashes };
  for (const key of keptPreviousSourceKeys) {
    const known = provenanceOf(key);
    if (known === undefined) delete sourceProvenance[key];
    else sourceProvenance[key] = known;
  }

  // UNITS. `translated`, `changed` and `skipped` count SOURCE keys; `failed`
  // counts EMITTED keys, because that is the number of locale entries a reader
  // has to go and look at — a ru plural group is four of them. The guard path
  // pushes one `errors` line per emitted key; the chunk-failure path pushes one
  // per chunk, so `failed` and `errors.length` are not interchangeable.
  //
  // A source key that failed OR degraded did not receive a fresh translation:
  // both leave the cache, and both keep the previous value (or nothing) instead
  // of the provider's answer. Counting either as translated overstates the run,
  // and `changed` used to subtract neither — so a plural group that collapsed
  // into one chunk entry and then failed was reported as "updated" AND "failed"
  // in the same summary (CEL-1533).
  const notTranslated = (keys: string[]) =>
    keys.reduce(
      (n, key) =>
        n + (failedSourceKeys.has(key) || degradedSourceKeys.has(key) ? 1 : 0),
      0
    );
  const translatedCount = force
    ? keysToTranslate.length - notTranslated(keysToTranslate)
    : diff.missing.length - notTranslated(diff.missing);
  const changedCount = force
    ? 0
    : diff.changed.length - notTranslated(diff.changed);

  return {
    translated: Math.max(0, translatedCount),
    skipped: diff.unchanged.length,
    changed: Math.max(0, changedCount),
    failed: failedKeys,
    warnings,
    errors,
    output,
    sourceProvenance,
    staleSourceKeys: [...staleSourceKeys],
    acceptedSourceKeys: [...acceptedSourceKeys],
    outputKeyOrder,
  };
}

/**
 * Source keys whose translation depends on an emitted key. An expanded plural
 * category has no source key of its own, so a failure there invalidates the
 * whole group.
 */
function sourceKeysFor(
  key: string,
  sourceFlat: Record<string, string>,
  pluralGroups: Map<string, PluralGroup>
): string[] {
  if (key in sourceFlat) return [key];
  const parts = splitPluralKey(key);
  const group = parts ? pluralGroups.get(parts.base) : undefined;
  return group ? group.sourceKeys : [];
}

/**
 * English text a translated key should be validated against. Expanded plural
 * categories have no source key of their own, so they fall back to the closest
 * English form of their group.
 */
function resolveSourceValue(
  key: string,
  sourceFlat: Record<string, string>,
  pluralGroups: Map<string, PluralGroup>
): string | undefined {
  if (key in sourceFlat) return sourceFlat[key];
  const parts = splitPluralKey(key);
  if (!parts) return undefined;
  const group = pluralGroups.get(parts.base);
  if (!group) return undefined;
  return sourceFormFor(group, parts.category);
}

/**
 * Main entry point. Reads files, runs translation, writes output.
 */
export async function translate(
  options: TranslateOptions
): Promise<TranslateResult> {
  const {
    input,
    outputLanguages,
    provider,
    force = false,
    dryRun = false,
    context,
  } = options;
  const cacheFilePath = options.noCache
    ? null
    : options.cacheFile ?? join(dirname(input), ".polyglot-cache.json");

  const isDirectory = existsSync(input) && statSync(input).isDirectory();
  const totalResult: TranslateResult = {
    translated: 0,
    skipped: 0,
    changed: 0,
    failed: 0,
    warnings: [],
    errors: [],
    files: [],
  };

  // Load cache. Entries come in either shape: a bare hash written by 0.3.x
  // (language-independent, read as cached everywhere) or a `{ hash, langs }`
  // record with this format's per-language exceptions. Nothing needs migrating
  // up front — a namespace upgrades itself the first time a language records an
  // exception on one of its keys, and stays a plain hash map otherwise.
  let fullCache: FullCache = {};
  if (cacheFilePath && existsSync(cacheFilePath)) {
    fullCache = JSON.parse(readFileSync(cacheFilePath, "utf-8"));
  }

  // Collect source files
  const sourceFiles: { name: string; path: string }[] = [];
  if (isDirectory) {
    for (const file of readdirSync(input)) {
      if (file.endsWith(".json")) {
        sourceFiles.push({ name: file, path: join(input, file) });
      }
    }
  } else {
    sourceFiles.push({ name: basename(input), path: input });
  }

  // Calculate total work
  let totalKeys = 0;
  for (const sf of sourceFiles) {
    const j = JSON.parse(readFileSync(sf.path, "utf-8"));
    totalKeys += Object.keys(flattenJSON(j)).length;
  }
  const totalWork = totalKeys * outputLanguages.length;

  console.log(
    `  ${sourceFiles.length} namespace(s), ${totalKeys} keys, ${outputLanguages.length} language(s) = ${totalWork} translations\n`
  );

  const globalStart = Date.now();
  let completedLangs = 0;

  for (const lang of outputLanguages) {
    completedLangs++;
    console.log(
      `  [${completedLangs}/${outputLanguages.length}] ${lang.toUpperCase()}`
    );

    for (const sourceFile of sourceFiles) {
      const sourceJSON = JSON.parse(readFileSync(sourceFile.path, "utf-8"));
      const sourceFlat = flattenJSON(sourceJSON);

      if (Object.keys(sourceFlat).length === 0) continue;

      // Determine output path
      let outputPath: string;
      if (isDirectory) {
        const outDir = options.outputDir
          ? join(options.outputDir, lang)
          : join(dirname(input), lang);
        mkdirSync(outDir, { recursive: true });
        outputPath = join(outDir, sourceFile.name);
      } else {
        const outDir = options.outputDir
          ? join(options.outputDir, lang)
          : dirname(input);
        mkdirSync(outDir, { recursive: true });
        outputPath = options.outputDir
          ? join(outDir, sourceFile.name)
          : join(outDir, `${lang}.json`);
      }

      // Load existing target
      let targetFlat: Record<string, string> = {};
      if (existsSync(outputPath)) {
        const targetJSON = JSON.parse(readFileSync(outputPath, "utf-8"));
        targetFlat = flattenJSON(targetJSON);
      }

      const cacheKey = sourceFile.name;
      const namespaceCache = fullCache[cacheKey] ?? {};
      const cacheView = viewForLanguage(namespaceCache, lang);
      const retriedSourceKeys = pendingRetryKeys(cacheView, sourceFlat);
      const cachedAcceptedKeys = acceptedKeysForSource(cacheView, sourceFlat);

      if (dryRun) {
        const diff = computeDiff(sourceFlat, targetFlat, cacheView.hashes);
        // Mirror translateNamespace: incomplete plural groups are work too.
        const pluralGroups = provider.supportsPluralExpansion
          ? collectPluralGroups(sourceFlat, lang)
          : new Map<string, PluralGroup>();
        const queued = new Set([...diff.missing, ...diff.changed]);
        const incomplete = incompletePluralSourceKeys(
          targetFlat,
          pluralGroups,
          cachedAcceptedKeys
        ).filter((key) => !queued.has(key));
        const toTranslate = force
          ? Object.keys(sourceFlat).length
          : queued.size + incomplete.length;
        console.log(
          `  [dry-run] ${sourceFile.name} → ${lang}: ${toTranslate} to translate, ${diff.unchanged.length - incomplete.length} skipped`
        );
        totalResult.translated += toTranslate;
        totalResult.skipped += diff.unchanged.length - incomplete.length;
        continue;
      }

      const keyCount = Object.keys(sourceFlat).length;
      console.log(`  ${sourceFile.name} (${keyCount} keys)`);

      const result = await translateNamespace({
        sourceFlat,
        targetFlat,
        cacheEntries: cacheView.hashes,
        cachedAcceptedKeys,
        retriedSourceKeys,
        provider,
        targetLang: lang,
        force,
        context,
      });

      // Write output. Follows English key order, but is NOT limited to the
      // English key set: plural groups carry the target language's own CLDR
      // categories, which can outnumber English's one/other.
      const orderedOutput: Record<string, string> = {};
      for (const key of result.outputKeyOrder) {
        if (key in result.output) orderedOutput[key] = result.output[key];
      }

      const outputJSON = unflattenJSON(orderedOutput);
      writeFileSync(outputPath, JSON.stringify(outputJSON, null, 2) + "\n");

      // Update cache. Only THIS language's state is touched: an eviction it
      // records is written against `lang` and every other language keeps what
      // it had, so a later language can no longer re-cache what an earlier one
      // degraded — and, unlike the in-memory union this replaced, the eviction
      // survives the process. Running `-o zh` and then `-o ru` as two separate
      // invocations now behaves exactly like `-o zh,ru` (CEL-1543).
      //
      // Skipped entirely under `--no-cache` (`cacheFilePath === null`): nothing
      // is ever read back out of `fullCache` at the end of the run, but the
      // object itself lives for the length of this whole function, across every
      // language. Merging into it anyway let the FIRST language's translation
      // mint a bare-hash entry the SECOND language's `namespaceCache` read back
      // as its own cached provenance — `-o zh,ru` silently skipped every ru key
      // whose target file happened to already hold a value, exactly the run
      // `--no-cache` exists to force through the provider (CEL-1545).
      if (cacheFilePath) {
        fullCache[cacheKey] = mergeNamespaceCache(namespaceCache, lang, {
          hashes: buildCacheEntries(sourceFlat),
          provenance: result.sourceProvenance,
          stale: result.staleSourceKeys,
          accepted: result.acceptedSourceKeys,
        });
      }

      totalResult.translated += result.translated;
      totalResult.skipped += result.skipped;
      totalResult.changed += result.changed;
      totalResult.failed += result.failed;
      totalResult.warnings.push(...result.warnings);
      totalResult.errors.push(...result.errors);
      totalResult.files.push(outputPath);

      // Per-namespace summary
      const parts: string[] = [];
      if (result.translated > 0) parts.push(`${result.translated} translated`);
      if (result.changed > 0) parts.push(`${result.changed} updated`);
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      console.log(`    ✓ ${parts.join(", ")}`);
    }

    console.log();
  }

  // Write cache
  if (cacheFilePath && !dryRun) {
    writeFileSync(cacheFilePath, JSON.stringify(fullCache, null, 2) + "\n");
  }

  // Final timing
  totalResult.elapsed = elapsed(globalStart);

  return totalResult;
}

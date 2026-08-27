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
import { computeDiff, buildCacheEntries, type DiffResult } from "./cache.js";
import { chunkEntries } from "./chunk.js";
import { validatePlaceholders } from "./placeholder.js";
import {
  collectPluralGroups,
  expandPluralFallback,
  incompletePluralSourceKeys,
  indexGroupsBySourceKey,
  representativeKey,
  sourceFormFor,
  splitPluralKey,
  toPluralExpansion,
  type PluralGroup,
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
  newCacheEntries: Record<string, string>;
  /**
   * Key order for the written file: English source order, with each plural
   * group replaced by the full category set the target language needs. This is
   * a superset of `Object.keys(sourceFlat)` — the target may carry plural
   * categories English does not have.
   */
  outputKeyOrder: string[];
}

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

  // Plural groups are collected for EVERY provider. Only a provider that opts
  // in has them expanded into the request; the rest of the run still needs the
  // full map, because the target file can hold categories English does not have
  // and nothing else in the pipeline knows they belong together.
  const pluralGroups = collectPluralGroups(sourceFlat, targetLang);
  const expansionGroups = provider.supportsPluralExpansion
    ? pluralGroups
    : new Map<string, PluralGroup>();
  const groupBySourceKey = indexGroupsBySourceKey(expansionGroups);

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
      expansionGroups
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

  const output: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  let failedKeys = 0;

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

  if (keysToTranslate.length === 0) {
    return {
      translated: 0,
      skipped: diff.unchanged.length,
      changed: 0,
      failed: 0,
      warnings: [],
      errors: [],
      output,
      newCacheEntries: buildCacheEntries(sourceFlat),
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
  // Degraded keys are not failures, but they still leave the cache so the next
  // run gets another attempt at a real translation.
  const degradedSourceKeys = new Set<string>();
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
          if (previous !== undefined && previous !== "") {
            translatedEntries.push({ key: fallback.key, value: previous });
          }
          for (const key of sourceKeysFor(
            fallback.key,
            sourceFlat,
            pluralGroups
          )) {
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
      // Left out of the cache so the next run gets another chance at it.
      for (const key of sourceKeysFor(entry.key, sourceFlat, pluralGroups)) {
        degradedSourceKeys.add(key);
      }
      continue;
    }

    output[entry.key] = entry.value;
    const source = resolveSourceValue(entry.key, sourceFlat, pluralGroups);
    if (source === undefined) continue;
    warnings.push(...validatePlaceholders(source, entry.value, entry.key));
  }

  // A failed key must NOT be cached as translated, or the next run would see
  // the source hash unchanged and skip it forever.
  const newCacheEntries = buildCacheEntries(sourceFlat);
  for (const key of failedSourceKeys) delete newCacheEntries[key];
  for (const key of degradedSourceKeys) delete newCacheEntries[key];

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
    newCacheEntries,
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

  // Load cache
  let fullCache: Record<string, Record<string, string>> = {};
  if (cacheFilePath && existsSync(cacheFilePath)) {
    fullCache = JSON.parse(readFileSync(cacheFilePath, "utf-8"));
  }

  /**
   * Keys evicted from the cache by ANY language, per namespace.
   *
   * The cache is namespace-scoped and language-INDEPENDENT: one map of source
   * hashes per file, rewritten once per language in the loop below. An eviction
   * is a property of the namespace, not of the language that found it — without
   * this union, a later language re-added a key an earlier one had degraded,
   * and the next run saw an unchanged hash and skipped the English value it had
   * just written. That is the "complete, never retried" hole (CEL-1533), and no
   * plural-completeness check can see it: the file has every category it needs.
   */
  const evictedPerNamespace = new Map<string, Set<string>>();

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
      const cacheEntries = fullCache[cacheKey] ?? {};

      if (dryRun) {
        const diff = computeDiff(sourceFlat, targetFlat, cacheEntries);
        // Mirror translateNamespace: incomplete plural groups are work too.
        const pluralGroups = provider.supportsPluralExpansion
          ? collectPluralGroups(sourceFlat, lang)
          : new Map<string, PluralGroup>();
        const queued = new Set([...diff.missing, ...diff.changed]);
        const incomplete = incompletePluralSourceKeys(
          targetFlat,
          pluralGroups
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
        cacheEntries,
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

      // Update cache. A key any language dropped stays dropped for the whole
      // namespace, so the language that degraded it gets its retry next run.
      let evicted = evictedPerNamespace.get(cacheKey);
      if (!evicted) {
        evicted = new Set<string>();
        evictedPerNamespace.set(cacheKey, evicted);
      }
      for (const key of Object.keys(sourceFlat)) {
        if (!(key in result.newCacheEntries)) evicted.add(key);
      }
      fullCache[cacheKey] = result.newCacheEntries;
      for (const key of evicted) delete fullCache[cacheKey][key];

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

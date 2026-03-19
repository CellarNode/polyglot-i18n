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
  translated: number;
  skipped: number;
  changed: number;
  failed: number;
  warnings: string[];
  errors: string[];
  files: string[];
  elapsed?: string;
}

export interface NamespaceResult {
  translated: number;
  skipped: number;
  changed: number;
  failed: number;
  warnings: string[];
  errors: string[];
  output: Record<string, string>;
  newCacheEntries: Record<string, string>;
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

  let keysToTranslate: string[];
  let diff: DiffResult;

  if (force) {
    keysToTranslate = Object.keys(sourceFlat);
    diff = { missing: keysToTranslate, changed: [], unchanged: [] };
  } else {
    diff = computeDiff(sourceFlat, targetFlat, cacheEntries);
    keysToTranslate = [...diff.missing, ...diff.changed];
  }

  const output: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  let failedKeys = 0;

  // Carry over unchanged translations
  for (const key of diff.unchanged) {
    output[key] = targetFlat[key];
  }

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
    };
  }

  // Build entries and chunk
  const entries: TranslationEntry[] = keysToTranslate.map((key) => ({
    key,
    value: sourceFlat[key],
  }));

  const chunks = chunkEntries(entries, CHUNK_SIZE);
  const translatedEntries: TranslationEntry[] = [];
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
      failedKeys += chunk.length;

      // On chunk failure, preserve source values so the file isn't missing keys
      for (const entry of chunk) {
        translatedEntries.push({ key: entry.key, value: entry.value });
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
    output[entry.key] = entry.value;
    const phWarnings = validatePlaceholders(
      sourceFlat[entry.key],
      entry.value,
      entry.key
    );
    warnings.push(...phWarnings);
  }

  const translatedCount = force
    ? keysToTranslate.length - failedKeys
    : diff.missing.length - failedKeys;

  return {
    translated: Math.max(0, translatedCount),
    skipped: diff.unchanged.length,
    changed: force ? 0 : diff.changed.length,
    failed: failedKeys,
    warnings,
    errors,
    output,
    newCacheEntries: buildCacheEntries(sourceFlat),
  };
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
        const outDir = options.outputDir ?? dirname(input);
        mkdirSync(outDir, { recursive: true });
        outputPath = join(outDir, `${lang}.json`);
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
        const toTranslate = force
          ? Object.keys(sourceFlat).length
          : diff.missing.length + diff.changed.length;
        console.log(
          `  [dry-run] ${sourceFile.name} → ${lang}: ${toTranslate} to translate, ${diff.unchanged.length} skipped`
        );
        totalResult.translated += toTranslate;
        totalResult.skipped += diff.unchanged.length;
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

      // Write output (preserve English key order)
      const orderedOutput: Record<string, string> = {};
      for (const key of Object.keys(sourceFlat)) {
        if (key in result.output) orderedOutput[key] = result.output[key];
      }

      const outputJSON = unflattenJSON(orderedOutput);
      writeFileSync(outputPath, JSON.stringify(outputJSON, null, 2) + "\n");

      // Update cache
      fullCache[cacheKey] = result.newCacheEntries;

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

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
  warnings: string[];
  files: string[];
}

export interface NamespaceResult {
  translated: number;
  skipped: number;
  changed: number;
  warnings: string[];
  output: Record<string, string>;
  newCacheEntries: Record<string, string>;
}

const CHUNK_SIZE = 50;

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

  // Carry over unchanged translations
  for (const key of diff.unchanged) {
    output[key] = targetFlat[key];
  }

  if (keysToTranslate.length === 0) {
    return {
      translated: 0,
      skipped: diff.unchanged.length,
      changed: 0,
      warnings: [],
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

  for (const chunk of chunks) {
    const result = await provider.translate(chunk, targetLang, context);
    translatedEntries.push(...result);
  }

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

  return {
    translated: force ? keysToTranslate.length : diff.missing.length,
    skipped: diff.unchanged.length,
    changed: force ? 0 : diff.changed.length,
    warnings,
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
    warnings: [],
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

  for (const lang of outputLanguages) {
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
          `[dry-run] ${sourceFile.name} → ${lang}: ${toTranslate} keys to translate, ${diff.unchanged.length} skipped`
        );
        totalResult.translated += toTranslate;
        totalResult.skipped += diff.unchanged.length;
        continue;
      }

      console.log(`  ${sourceFile.name} → ${lang}...`);

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
      totalResult.warnings.push(...result.warnings);
      totalResult.files.push(outputPath);
    }
  }

  // Write cache
  if (cacheFilePath && !dryRun) {
    writeFileSync(cacheFilePath, JSON.stringify(fullCache, null, 2) + "\n");
  }

  return totalResult;
}

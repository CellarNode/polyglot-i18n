#!/usr/bin/env node
import { Command } from "commander";
import { translate } from "./translate.js";
import { GeminiProvider } from "./providers/gemini.js";
import { DeepLProvider } from "./providers/deepl.js";
import type { TranslationProvider } from "./providers/types.js";

const program = new Command();

program
  .name("polyglot-i18n")
  .description(
    "AI-powered i18n translation CLI. Translate JSON locale files using Gemini or DeepL."
  )
  .version("0.1.0");

program
  .command("translate")
  .description("Translate i18n JSON files")
  .requiredOption("-i, --input <path>", "Source English file or directory")
  .requiredOption(
    "-o, --output-languages <langs>",
    "Comma-separated target language codes"
  )
  .option(
    "-p, --provider <provider>",
    "Translation provider (gemini or deepl)",
    "gemini"
  )
  .option(
    "-m, --model <model>",
    "Model name (Gemini only)",
    "gemini-3.1-flash-lite-preview"
  )
  .option(
    "-k, --api-key <key>",
    "API key (or use GOOGLE_API_KEY / DEEPL_API_KEY env var)"
  )
  .option("--output-dir <path>", "Output directory")
  .option("-f, --force", "Retranslate all keys", false)
  .option("--dry-run", "Show what would be translated", false)
  .option(
    "--cache-file <path>",
    "Path to cache file",
    ".polyglot-cache.json"
  )
  .option("--no-cache", "Disable cache")
  .option("-c, --context <text>", "Domain context for better translations")
  .action(async (opts) => {
    const apiKey =
      opts.apiKey ??
      (opts.provider === "deepl"
        ? process.env.DEEPL_API_KEY
        : process.env.GOOGLE_API_KEY);

    if (!apiKey) {
      console.error(
        `Error: No API key provided. Use --api-key or set ${opts.provider === "deepl" ? "DEEPL_API_KEY" : "GOOGLE_API_KEY"} env var.`
      );
      process.exit(1);
    }

    let provider: TranslationProvider;
    if (opts.provider === "deepl") {
      provider = new DeepLProvider(apiKey);
    } else {
      provider = new GeminiProvider(apiKey, opts.model);
    }

    const languages = opts.outputLanguages
      .split(",")
      .map((l: string) => l.trim());

    console.log(
      `\npolyglot-i18n — translating to: ${languages.join(", ")} via ${opts.provider}\n`
    );

    const result = await translate({
      input: opts.input,
      outputLanguages: languages,
      provider,
      outputDir: opts.outputDir,
      force: opts.force,
      dryRun: opts.dryRun,
      cacheFile: opts.cacheFile,
      noCache: !opts.cache,
      context: opts.context,
    });

    console.log(`\nDone!`);
    console.log(`  Translated: ${result.translated} keys`);
    console.log(`  Changed:    ${result.changed} keys (source updated)`);
    console.log(`  Skipped:    ${result.skipped} keys (unchanged)`);
    console.log(`  Files:      ${result.files.length} written`);

    if (result.warnings.length > 0) {
      console.log(`\nWarnings (${result.warnings.length}):`);
      for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    }
  });

program.parse();

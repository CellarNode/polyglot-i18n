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
  .version("0.2.3");

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
        `\n  ✗ No API key provided.\n\n` +
          `  Set the ${opts.provider === "deepl" ? "DEEPL_API_KEY" : "GOOGLE_API_KEY"} environment variable\n` +
          `  or pass --api-key <key>\n`
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
      `\n  polyglot-i18n\n` +
        `  Provider: ${opts.provider}${opts.provider === "gemini" ? ` (${opts.model})` : ""}\n` +
        `  Languages: ${languages.join(", ")}\n` +
        `  Mode: ${opts.force ? "force (retranslate all)" : "incremental (new + changed only)"}\n`
    );

    try {
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

      // Summary
      console.log(`  ─────────────────────────────────`);
      console.log(`  ✓ Complete${result.elapsed ? ` in ${result.elapsed}` : ""}\n`);
      console.log(`    Translated:  ${result.translated} keys`);
      if (result.changed > 0)
        console.log(`    Updated:     ${result.changed} keys (source changed)`);
      if (result.skipped > 0)
        console.log(`    Skipped:     ${result.skipped} keys (unchanged)`);
      if (result.failed > 0)
        console.log(`    Failed:      ${result.failed} keys`);
      console.log(`    Files:       ${result.files.length} written`);

      if (result.warnings.length > 0) {
        console.log(
          `\n  ⚠ Warnings (${result.warnings.length}):`
        );
        for (const w of result.warnings.slice(0, 10)) {
          console.log(`    ${w}`);
        }
        if (result.warnings.length > 10) {
          console.log(
            `    ... and ${result.warnings.length - 10} more`
          );
        }
      }

      if (result.errors.length > 0) {
        console.log(`\n  ✗ Errors (${result.errors.length}):`);
        for (const e of result.errors) {
          console.log(`    ${e}`);
        }
        console.log(
          `\n  Failed chunks used source text as fallback.\n` +
            `  Re-run to retry failed translations.\n`
        );
      }

      console.log();

      // Exit with error code if there were failures
      if (result.failed > 0) process.exit(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Fatal error: ${msg}\n`);
      process.exit(1);
    }
  });

program.parse();

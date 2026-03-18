import * as deepl from "deepl-node";
import type { TranslationProvider, TranslationEntry } from "./types.js";

const DEEPL_LANGUAGE_MAP: Record<string, string> = {
  en: "EN-US",
  zh: "ZH-HANS",
  pt: "PT-BR",
};

export function detectDeepLTier(apiKey: string): "free" | "pro" {
  return apiKey.endsWith(":fx") ? "free" : "pro";
}

export function mapLanguageCode(lang: string): string {
  return DEEPL_LANGUAGE_MAP[lang] ?? lang.toUpperCase();
}

export class DeepLProvider implements TranslationProvider {
  name = "deepl";
  private translator: deepl.Translator;

  constructor(apiKey: string) {
    const options: deepl.TranslatorOptions = {};
    if (detectDeepLTier(apiKey) === "free") {
      options.serverUrl = "https://api-free.deepl.com";
    }
    this.translator = new deepl.Translator(apiKey, options);
  }

  async translate(
    entries: TranslationEntry[],
    targetLang: string,
    _context?: string
  ): Promise<TranslationEntry[]> {
    const texts = entries.map((e) => e.value);
    const deeplLang = mapLanguageCode(targetLang) as deepl.TargetLanguageCode;

    const results = await this.translator.translateText(
      texts,
      "en" as deepl.SourceLanguageCode,
      deeplLang,
      {
        preserveFormatting: true,
        tagHandling: "html",
      }
    );

    const resultArray = Array.isArray(results) ? results : [results];

    return entries.map((entry, i) => ({
      key: entry.key,
      value: resultArray[i]?.text ?? entry.value,
    }));
  }
}

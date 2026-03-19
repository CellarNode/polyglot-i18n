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

/**
 * Replaces {{variable}} placeholders with XML <x> tags that DeepL will not translate.
 * Returns the protected string and a map to restore placeholders after.
 */
export function protectPlaceholders(text: string): {
  protected: string;
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  let counter = 0;

  const protected_ = text.replace(/\{\{([^}]+)\}\}/g, (_match, name) => {
    const id = `__PH${counter++}__`;
    // Use <keep> with translate="no" — DeepL respects this attribute
    const tag = `<keep translate="no">{{${name}}}</keep>`;
    map.set(id, name);
    return tag;
  });

  return { protected: protected_, map };
}

/**
 * Restores {{variable}} placeholders from <x> tags after DeepL translation.
 * Also handles cases where DeepL mangles the tags.
 */
export function restorePlaceholders(
  text: string,
  map: Map<string, string>
): string {
  let result = text;

  // Restore <keep translate="no">{{name}}</keep> back to {{name}}
  result = result.replace(
    /<keep translate="no">(.*?)<\/keep>/g,
    (_match, content) => content
  );

  // Fallback: restore <x id="__PH0__">name</x> pattern (if DeepL restructures tags)
  result = result.replace(
    /<x id="(__PH\d+__)">[^<]*<\/x>/g,
    (_match, id) => {
      const name = map.get(id);
      return name ? `{{${name}}}` : _match;
    }
  );

  // Decode any HTML entities DeepL may have introduced
  result = result.replace(/&#x27;/g, "'");
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');

  return result;
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
    // Protect placeholders before sending to DeepL
    const protectedTexts: string[] = [];
    const placeholderMaps: Map<string, string>[] = [];

    for (const entry of entries) {
      const { protected: p, map } = protectPlaceholders(entry.value);
      protectedTexts.push(p);
      placeholderMaps.push(map);
    }

    const deeplLang = mapLanguageCode(targetLang) as deepl.TargetLanguageCode;

    const results = await this.translator.translateText(
      protectedTexts,
      "en" as deepl.SourceLanguageCode,
      deeplLang,
      {
        preserveFormatting: true,
        tagHandling: "xml",
        ignoreTags: ["keep"],
      }
    );

    const resultArray = Array.isArray(results) ? results : [results];

    return entries.map((entry, i) => ({
      key: entry.key,
      value: restorePlaceholders(
        resultArray[i]?.text ?? entry.value,
        placeholderMaps[i]
      ),
    }));
  }
}

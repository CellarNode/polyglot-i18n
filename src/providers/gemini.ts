import { GoogleGenAI } from "@google/genai";
import type { TranslationProvider, TranslationEntry } from "./types.js";
import { sourceFormFor } from "../plurals.js";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese (Simplified)",
  fr: "French",
  de: "German",
  it: "Italian",
  es: "Spanish",
  sv: "Swedish",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ar: "Arabic",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  tr: "Turkish",
  uk: "Ukrainian",
  cs: "Czech",
  da: "Danish",
  fi: "Finnish",
  el: "Greek",
  hu: "Hungarian",
  id: "Indonesian",
  ms: "Malay",
  nb: "Norwegian",
  ro: "Romanian",
  sk: "Slovak",
  bg: "Bulgarian",
  hr: "Croatian",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  sl: "Slovenian",
};

const SYSTEM_PROMPT = `You are a professional translator for software UI strings.

Rules:
- Translate from English to the target language
- Preserve ALL placeholders exactly: {{variable}}, {{count}}, {0}, %s, %d
- Preserve ALL i18next plural suffixes in keys (_one, _other, _zero, _few, _many)
- When a "Plural forms required" section is present, return EVERY key it lists —
  including plural categories English does not have. Write each form with the
  grammatical number the target language actually uses; never copy English.
- Preserve HTML tags if present: <strong>, <br/>, <a>, etc.
- Keep translations concise — UI strings must fit buttons, labels, menus
- Use formal register unless the source is clearly informal
- Do not translate brand names
- Return ONLY valid JSON, no markdown fences, no explanation`;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildPrompt(
  entries: TranslationEntry[],
  targetLang: string,
  context?: string
): string {
  const langName = LANGUAGE_NAMES[targetLang] ?? targetLang;
  const json: Record<string, string> = {};
  const pluralRequirements: string[] = [];

  for (const e of entries) {
    if (!e.plural) {
      json[e.key] = e.value;
      continue;
    }

    // Send every English form of the group so the model has the full picture.
    for (const [category, value] of Object.entries(e.plural.sourceForms)) {
      json[`${e.plural.base}_${category}`] = value;
    }

    const missing = e.plural.targetCategories.filter(
      (category) => !(category in e.plural!.sourceForms)
    );
    if (missing.length > 0) {
      const required = e.plural.targetCategories
        .map((category) => `${e.plural!.base}_${category}`)
        .join(", ");
      pluralRequirements.push(`- ${required}`);
    }
  }

  let prompt = `Translate this JSON from English to ${langName} (${targetLang}).\n`;
  if (context) prompt += `Context: ${context}\n`;
  prompt += `\n${JSON.stringify(json, null, 2)}`;

  if (pluralRequirements.length > 0) {
    prompt +=
      `\n\nPlural forms required: ${langName} uses plural categories English does not.\n` +
      `Return these keys in the JSON, adding the forms that are missing above:\n` +
      `${pluralRequirements.join("\n")}`;
  }

  return prompt;
}

export function parseGeminiResponse(
  raw: string,
  sourceEntries: TranslationEntry[]
): TranslationEntry[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(cleaned) as Record<string, string>;

  const result: TranslationEntry[] = [];
  for (const entry of sourceEntries) {
    if (!entry.plural) {
      result.push({ key: entry.key, value: parsed[entry.key] ?? entry.value });
      continue;
    }

    // Accept the expanded key set: one key per category the target needs,
    // not just the categories the English source happened to carry.
    const { base, targetCategories } = entry.plural;
    for (const category of targetCategories) {
      const key = `${base}_${category}`;
      result.push({
        key,
        value:
          parsed[key] ??
          parsed[`${base}_other`] ??
          sourceFormFor(entry.plural, category) ??
          entry.value,
      });
    }
  }

  return result;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate") ||
      msg.includes("quota") ||
      msg.includes("resource_exhausted") ||
      msg.includes("too many requests") ||
      msg.includes("503") ||
      msg.includes("service unavailable") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("fetch failed")
    );
  }
  return false;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    // Extract useful info from Gemini API errors
    const msg = err.message;
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED"))
      return "Rate limited by Gemini API";
    if (msg.includes("403")) return "API key invalid or lacks permissions";
    if (msg.includes("400")) return "Bad request — prompt may be too large";
    if (msg.includes("500") || msg.includes("503"))
      return "Gemini API server error";
    if (msg.includes("fetch failed") || msg.includes("ECONNRESET"))
      return "Network error — connection dropped";
    return msg.slice(0, 120);
  }
  return String(err).slice(0, 120);
}

export class GeminiProvider implements TranslationProvider {
  name = "gemini";
  supportsPluralExpansion = true;
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = "gemini-3.1-flash-lite-preview") {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async translate(
    entries: TranslationEntry[],
    targetLang: string,
    context?: string
  ): Promise<TranslationEntry[]> {
    const prompt = buildPrompt(entries, targetLang, context);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.1,
          },
        });

        const text = response.text ?? "";

        try {
          return parseGeminiResponse(text, entries);
        } catch {
          // JSON parse failed — retry with stricter prompt
          const retry = await this.client.models.generateContent({
            model: this.model,
            contents:
              prompt +
              "\n\nIMPORTANT: Return ONLY valid JSON. No explanation.",
            config: {
              systemInstruction: SYSTEM_PROMPT,
              temperature: 0,
            },
          });
          return parseGeminiResponse(retry.text ?? "", entries);
        }
      } catch (err) {
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(
            `      ↻ ${formatError(err)} — retrying in ${(delay / 1000).toFixed(0)}s (attempt ${attempt}/${MAX_RETRIES})`
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable or exhausted retries
        throw new Error(
          `Gemini translation failed after ${attempt} attempt(s): ${formatError(err)}`
        );
      }
    }

    // Should never reach here
    throw new Error("Gemini translation failed: exhausted all retries");
  }
}

import { GoogleGenAI } from "@google/genai";
import type { TranslationProvider, TranslationEntry } from "./types.js";

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
  for (const e of entries) json[e.key] = e.value;

  let prompt = `Translate this JSON from English to ${langName} (${targetLang}).\n`;
  if (context) prompt += `Context: ${context}\n`;
  prompt += `\n${JSON.stringify(json, null, 2)}`;
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

  return sourceEntries.map((entry) => ({
    key: entry.key,
    value: parsed[entry.key] ?? entry.value,
  }));
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

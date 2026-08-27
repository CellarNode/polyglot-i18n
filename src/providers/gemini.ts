import { GoogleGenAI } from "@google/genai";
import type { TranslationProvider, TranslationEntry } from "./types.js";
import { sourceFormFor } from "../plurals.js";
import { flattenJSON } from "../json-utils.js";
import {
  buildCorrectiveInstruction,
  detectLeaks,
  expectedKeys,
  type LeakSuspect,
} from "../leak-guard.js";

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

export const SYSTEM_PROMPT = `You are a professional translator for software UI strings.

Rules:
- Translate from English to the target language
- EVERY value you return must be written entirely in the target language. Leaving
  an English word inside a value — even one word, even mid-sentence — is a defect,
  not a fallback. If you are unsure of a term, translate it anyway.
- The ONLY text copied verbatim from the source is: placeholders, HTML tags and
  brand names. Ordinary nouns like "product", "option" or "listing" are never
  brand names — translate them.
- Preserve ALL placeholders exactly: {{variable}}, {{count}}, {0}, %s, %d
- Preserve ALL i18next plural suffixes in keys (_one, _other, _zero, _few, _many)
- Return the JSON flat: keys contain dots (\`card.beverage_one\`) and must be
  returned as single flat keys, never expanded into nested objects
- Return EVERY key you were given, plus every key a "Plural forms required"
  section lists — including plural categories English does not have. Omitting a
  key is a defect; there is no fallback for it.
- Plural categories must DIFFER wherever the target language's grammar differs.
  Write each form with the grammatical number that category actually covers, and
  never repeat one form across categories unless the language genuinely uses the
  same wording. Never copy an English form into a category.
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
  const pluralCategoriesInPlay = new Set<string>();
  let hasPluralGroup = false;

  for (const e of entries) {
    if (!e.plural) {
      json[e.key] = e.value;
      continue;
    }
    hasPluralGroup = true;

    // Send every English form of the group so the model has the full picture.
    for (const [category, value] of Object.entries(e.plural.sourceForms)) {
      json[`${e.plural.base}_${category}`] = value;
    }
    for (const category of e.plural.targetCategories) {
      pluralCategoriesInPlay.add(category);
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

  // The grouped-plural path is where CEL-1539's English leaks concentrated:
  // repeating the same English string under several `_category` keys invites
  // the model to echo it back. Spell out both requirements at the point of use.
  if (hasPluralGroup) {
    const categories = [...pluralCategoriesInPlay].join(", ");
    prompt +=
      `\n\nPlural rules for this request (${langName}, categories: ${categories}):\n` +
      `1. Translate EVERY plural value fully into ${langName}. The same English string ` +
      `appears under several _category keys above — that is the source, not an answer. ` +
      `Copying an English word such as "product", "option" or "listing" into any value is a defect.\n` +
      `2. Give each category the wording ${langName} grammar requires for the numbers it covers. ` +
      `Repeat identical text across categories ONLY when ${langName} genuinely uses one form for them.\n` +
      `3. Return every listed key. A missing key is not backfilled — it is dropped.`;
  }

  return prompt;
}

export interface ParsedResponse {
  /**
   * One entry per key the model actually produced a target-language value for.
   * Keys the model omitted are ABSENT — never backfilled from the English
   * source. CEL-1539: the 0.3.0 backfill is what wrote English to disk.
   */
  entries: TranslationEntry[];
  /** Keys whose value was copied from the group's translated `_other` form. */
  filledFromOther: Set<string>;
  /** Expected keys the model returned nothing usable for. */
  unresolved: Set<string>;
}

export function parseGeminiResponse(
  raw: string,
  sourceEntries: TranslationEntry[]
): ParsedResponse {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Flat dotted keys are what we asked for, but a model that nests
  // `{"card": {"beverage_one": …}}` used to resolve to `undefined` and get
  // backfilled with English. Re-flattening makes both shapes readable.
  const parsed = flattenJSON(
    JSON.parse(cleaned) as Record<string, unknown>
  );

  const entries: TranslationEntry[] = [];
  const filledFromOther = new Set<string>();
  const unresolved = new Set<string>();

  const usable = (value: string | undefined): value is string =>
    typeof value === "string" && value.trim() !== "";

  for (const entry of sourceEntries) {
    if (!entry.plural) {
      if (usable(parsed[entry.key])) {
        entries.push({ key: entry.key, value: parsed[entry.key] });
      } else {
        unresolved.add(entry.key);
      }
      continue;
    }

    // Accept the expanded key set: one key per category the target needs,
    // not just the categories the English source happened to carry.
    const { base, targetCategories } = entry.plural;
    const otherForm = parsed[`${base}_other`];

    for (const category of targetCategories) {
      const key = `${base}_${category}`;
      if (usable(parsed[key])) {
        entries.push({ key, value: parsed[key] });
        continue;
      }
      // A translated `_other` is a usable stand-in (zh has no `_one` of its
      // own). The English source is NOT — that key stays unresolved so the
      // guard can retry it and, failing that, fail it.
      if (usable(otherForm)) {
        entries.push({ key, value: otherForm });
        filledFromOther.add(key);
        continue;
      }
      unresolved.add(key);
    }
  }

  return { entries, filledFromOther, unresolved };
}

/**
 * Entries for keys that stayed suspicious after the corrective retry. They
 * carry the English source as `value` so callers keep a complete key set, but
 * `failed` marks them un-writable — `translateNamespace` counts them as
 * failures and keeps the previous translation instead.
 */
function markFailed(
  requested: TranslationEntry[],
  parsed: ParsedResponse,
  suspects: LeakSuspect[]
): TranslationEntry[] {
  const fatal = new Map<string, LeakSuspect>();
  for (const suspect of suspects) {
    if (suspect.severity === "fail") fatal.set(suspect.key, suspect);
  }
  if (fatal.size === 0) return parsed.entries;

  const englishFor = new Map<string, string>();
  for (const entry of requested) {
    if (!entry.plural) {
      englishFor.set(entry.key, entry.value);
      continue;
    }
    for (const category of entry.plural.targetCategories) {
      englishFor.set(
        `${entry.plural.base}_${category}`,
        sourceFormFor(entry.plural, category) ?? entry.value
      );
    }
  }

  const result: TranslationEntry[] = [];
  const emitted = new Set<string>();
  for (const entry of parsed.entries) {
    const suspect = fatal.get(entry.key);
    result.push(
      suspect
        ? {
            key: entry.key,
            value: englishFor.get(entry.key) ?? entry.value,
            failed: { reason: suspect.reason, detail: suspect.detail },
          }
        : entry
    );
    emitted.add(entry.key);
  }

  // Keys the model never returned still need an entry so the failure is counted.
  for (const entry of requested) {
    for (const key of expectedKeys(entry)) {
      if (emitted.has(key)) continue;
      const suspect = fatal.get(key);
      if (!suspect) continue;
      result.push({
        key,
        value: englishFor.get(key) ?? entry.value,
        failed: { reason: suspect.reason, detail: suspect.detail },
      });
      emitted.add(key);
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

/** Compact one-line summary of a suspect set for console output. */
function describeSuspects(suspects: LeakSuspect[]): string {
  const counts = new Map<string, number>();
  for (const s of suspects) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${reason}×${n}`).join(", ");
}

function formatError(err: unknown): string {  if (err instanceof Error) {
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
    const langName = LANGUAGE_NAMES[targetLang] ?? targetLang;

    const generate = async (text: string, temperature: number) => {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: text,
        config: { systemInstruction: SYSTEM_PROMPT, temperature },
      });
      return response.text ?? "";
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        let parsed: ParsedResponse;
        try {
          parsed = parseGeminiResponse(await generate(prompt, 0.1), entries);
        } catch {
          // JSON parse failed — retry with stricter prompt
          parsed = parseGeminiResponse(
            await generate(
              `${prompt}\n\nIMPORTANT: Return ONLY valid JSON. No explanation.`,
              0
            ),
            entries
          );
        }

        let suspects = detectLeaks(
          entries,
          parsed.entries,
          targetLang,
          parsed.filledFromOther
        );
        if (suspects.length === 0) return parsed.entries;

        // One corrective retry naming exactly what was wrong (CEL-1539).
        console.log(
          `\n    ⚠ ${suspects.length} suspicious value(s) in ${targetLang} — retrying: ${describeSuspects(suspects)}`
        );
        const corrective =
          prompt + buildCorrectiveInstruction(suspects, langName);
        const retried = parseGeminiResponse(await generate(corrective, 0), entries);
        suspects = detectLeaks(
          entries,
          retried.entries,
          targetLang,
          retried.filledFromOther
        );
        if (suspects.length === 0) return retried.entries;

        const fatal = suspects.filter((s) => s.severity === "fail");
        if (fatal.length > 0) {
          console.log(
            `    ✗ ${fatal.length} value(s) still unusable after retry — failing those keys: ${describeSuspects(fatal)}`
          );
        }
        return markFailed(entries, retried, suspects);
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

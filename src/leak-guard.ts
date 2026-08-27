import { getPluralCategories, sourceFormFor } from "./plurals.js";
import type { TranslationEntry } from "./providers/types.js";

/**
 * Post-parse quality gate for provider output (CEL-1539).
 *
 * The 0.3.0 plural-group path shipped a silent fallback chain: any category the
 * model failed to return was backfilled from the English source, so a partial
 * model response was written to disk as a translation. Production run
 * 33088731240 wrote 429 English strings across 7 locales that way. Nothing in
 * the pipeline could tell a real translation from a backfilled English one.
 *
 * This module makes those shapes detectable so the provider can retry once and
 * then fail the key instead of writing it.
 */

export type LeakReason =
  /** No target-language text at all — the English source would be written. */
  | "no-target-form"
  /** Value carries English tokens copied from the source (non-Latin targets). */
  | "source-echo"
  /** Every plural category is byte-identical in a language with >2 categories. */
  | "uniform-plural"
  /** A category the language genuinely needs was filled from `_other`. */
  | "undifferentiated-category";

export interface LeakSuspect {
  /** The emitted key, e.g. `portfolio.item_few`. */
  key: string;
  reason: LeakReason;
  /** Human-readable explanation, used in the corrective retry and in errors. */
  detail: string;
  /**
   * `fail` suspects are never written: after the corrective retry they become
   * failed keys. `warn` suspects are imperfect but usable — they are reported
   * and written, because dropping them would lose a valid translation.
   */
  severity: "fail" | "warn";
}

/**
 * Languages whose default script is not Latin. Only these get the
 * source-echo check: a stray "product" is unmistakable in Chinese or Russian,
 * whereas in French or Swedish it is indistinguishable from a loanword.
 *
 * Matched on the primary subtag, so `zh-Hant` resolves via `zh`. A Latin-script
 * variant of a listed language (`sr-Latn`) is a known false positive; it costs
 * one corrective retry, never a wrong value.
 */
const NON_LATIN_SCRIPT_LANGS = new Set([
  "am", "ar", "be", "bg", "bn", "bo", "dv", "el", "fa", "gu", "he", "hi", "hy",
  "ja", "ka", "km", "kn", "ko", "ky", "lo", "mk", "ml", "mn", "mr", "my", "ne",
  "pa", "ps", "ru", "si", "sr", "ta", "te", "th", "ti", "uk", "ur", "yi", "zh",
]);

export function usesNonLatinScript(lang: string): boolean {
  return NON_LATIN_SCRIPT_LANGS.has(lang.toLowerCase().split(/[-_]/)[0]);
}

/** Placeholders, HTML tags and URLs are copied verbatim by design. */
const VERBATIM_PATTERNS = [
  /\{\{[^}]*\}\}/g, // {{count}}
  /\{[0-9]+\}/g, // {0}
  /%[sd]/g, // %s, %d
  /<[^>]*>/g, // <strong>, <br/>, <a href="...">
  /&[a-z]+;/gi, // &nbsp;
  /\bhttps?:\/\/\S+/gi, // URLs
  /\b[\w.+-]+@[\w.-]+\b/g, // emails
];

function stripVerbatim(text: string): string {
  let out = text;
  for (const pattern of VERBATIM_PATTERNS) out = out.replace(pattern, " ");
  return out;
}

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

/** Crude English de-pluralisation so "products" matches a leaked "product". */
function stem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("es") && lower.length > 3) return lower.slice(0, -2);
  if (lower.endsWith("s") && lower.length > 3) return lower.slice(0, -1);
  return lower;
}

/**
 * Brand names and acronyms are meant to survive translation ("CellarNode",
 * "PDF", "QR"). Recognised by their source casing: an internal capital or an
 * all-caps spelling. A plain Titlecase word ("Product") is NOT a brand — that
 * is the exact shape CEL-1539 leaked.
 */
function isBrandSpelling(word: string): boolean {
  if (word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
    return true;
  }
  return /[A-Z]/.test(word.slice(1));
}

/**
 * English tokens from `source` that survived untranslated into `translated`.
 * Placeholders, HTML, URLs, brand names and acronyms are excluded.
 */
export function findSourceEchoTokens(
  source: string,
  translated: string
): string[] {
  const sourceStems = new Map<string, string[]>();
  for (const word of stripVerbatim(source).match(WORD_RE) ?? []) {
    const key = stem(word);
    const spellings = sourceStems.get(key);
    if (spellings) spellings.push(word);
    else sourceStems.set(key, [word]);
  }

  const leaked: string[] = [];
  const seen = new Set<string>();
  for (const word of stripVerbatim(translated).match(WORD_RE) ?? []) {
    if (word.length < 3) continue;
    const spellings = sourceStems.get(stem(word));
    if (!spellings) continue;
    if (spellings.some(isBrandSpelling) || isBrandSpelling(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    leaked.push(word);
  }
  return leaked;
}

/** The key set a request entry is expected to produce. */
export function expectedKeys(entry: TranslationEntry): string[] {
  if (!entry.plural) return [entry.key];
  return entry.plural.targetCategories.map(
    (category) => `${entry.plural!.base}_${category}`
  );
}

function checkValue(
  key: string,
  sourceText: string,
  value: string | undefined,
  targetLang: string
): LeakSuspect | null {
  if (value === undefined || value.trim() === "") {
    return {
      key,
      reason: "no-target-form",
      detail: "model returned no value; the English source would be written",
      severity: "fail",
    };
  }
  if (!usesNonLatinScript(targetLang)) return null;

  const leaked = findSourceEchoTokens(sourceText, value);
  if (leaked.length === 0) return null;
  return {
    key,
    reason: "source-echo",
    detail: `untranslated English left in the value: ${leaked
      .map((t) => `"${t}"`)
      .join(", ")}`,
    severity: "fail",
  };
}

/**
 * Inspects parsed provider output for the CEL-1539 failure shapes.
 *
 * `translated` is the provider's parsed result; `filledFromOther` names the
 * keys the parser backfilled from the group's translated `_other` form (a
 * usable value, but evidence the model under-differentiated the categories).
 */
export function detectLeaks(
  requested: TranslationEntry[],
  translated: TranslationEntry[],
  targetLang: string,
  filledFromOther: ReadonlySet<string> = new Set()
): LeakSuspect[] {
  const byKey = new Map(translated.map((e) => [e.key, e.value]));
  const suspects: LeakSuspect[] = [];
  const langCategories = getPluralCategories(targetLang);

  for (const entry of requested) {
    if (!entry.plural) {
      const suspect = checkValue(
        entry.key,
        entry.value,
        byKey.get(entry.key),
        targetLang
      );
      if (suspect) suspects.push(suspect);
      continue;
    }

    const { base, targetCategories, sourceForms } = entry.plural;
    for (const category of targetCategories) {
      const key = `${base}_${category}`;
      const suspect = checkValue(
        key,
        sourceFormFor(entry.plural, category) ?? entry.value,
        byKey.get(key),
        targetLang
      );
      if (suspect) {
        suspects.push(suspect);
        continue;
      }
      // A category the language genuinely uses must come from the model, not
      // from a copy of `_other`. Usable, so it is a warning, not a failure.
      if (
        filledFromOther.has(key) &&
        (langCategories as string[]).includes(category)
      ) {
        suspects.push({
          key,
          reason: "undifferentiated-category",
          detail: `${targetLang} distinguishes "${category}" but the model returned no form for it; copied from _other`,
          severity: "warn",
        });
      }
    }

    // Byte-identical across every category, in a language that grammatically
    // differentiates more than two of them, while English itself differentiates.
    if (langCategories.length <= 2) continue;
    const values = targetCategories.map((c) => byKey.get(`${base}_${c}`));
    if (values.some((v) => v === undefined)) continue;
    if (new Set(values).size !== 1) continue;
    if (new Set(Object.values(sourceForms)).size < 2) continue;

    for (const category of targetCategories) {
      suspects.push({
        key: `${base}_${category}`,
        reason: "uniform-plural",
        detail: `all ${targetCategories.length} plural categories are byte-identical, but ${targetLang} has ${langCategories.length} distinct CLDR categories and English differentiates its forms`,
        severity: "fail",
      });
    }
  }

  return suspects;
}

/** Extra prompt text for the one corrective retry a suspicious chunk gets. */
export function buildCorrectiveInstruction(
  suspects: LeakSuspect[],
  langName: string
): string {
  const lines = suspects.map((s) => `- ${s.key}: ${s.detail}`);
  return (
    `\n\nYour previous answer was rejected. Problems found:\n${lines.join("\n")}\n\n` +
    `Return the FULL JSON again with every one of these keys corrected:\n` +
    `- Write every value entirely in ${langName}. No English word may remain in any value.\n` +
    `- Copy verbatim only placeholders ({{count}}, {0}, %s), HTML tags and brand names.\n` +
    `- Give each plural category the distinct wording ${langName} grammar requires for the numbers it covers.\n` +
    `- Return every key that was asked for. Never omit one, and never echo the English source.`
  );
}

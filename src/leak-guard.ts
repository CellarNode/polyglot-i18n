import {
  COUNT_PLACEHOLDER_RE,
  getPluralCategories,
  pluralTypeForBase,
  sourceFormFor,
} from "./plurals.js";
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
 * then either drop the key or fall back to the previous translation.
 *
 * The detector is deliberately biased towards silence. Replaying it over the
 * 8904 shipped en→zh/ru pairs in producer-dashboard, importer-dashboard,
 * public-site and @cellarnode/i18n must not flag a single correct value —
 * proper nouns (grape varietals, producers, retailers, product names) and
 * loanwords retained on purpose (`cookie`, `email`, `e-label`) are legitimate
 * in every locale. A guard that fails them turns a translation job permanently
 * red and can never be satisfied.
 *
 * SCOPE — read this before quoting the invariant below.
 *
 * Every check except `no-target-form` and `uniform-plural` is gated on the
 * target language using a non-Latin script (`usesNonLatinScript`). In French or
 * Swedish an English-looking token is indistinguishable from a loanword, so no
 * echo or identity check runs there at all. "Silent-and-cached is the one
 * outcome this module must never produce" is therefore a guarantee about
 * NON-LATIN targets: a byte-identical `fr` value is still written and cached,
 * exactly as it was before this module existed.
 *
 * `uniform-plural` sits outside that gate on purpose — Latin-script pl, cs, lt
 * and lv need four CLDR categories just as ru does — so those languages do get
 * one check, and pay its cost (see the disposition on that suspect).
 */

export type LeakReason =
  /** No target-language text at all — the English source would be written. */
  | "no-target-form"
  /** Common English source words spliced into an otherwise-translated value. */
  | "source-echo"
  /** The value is the English source, verbatim. */
  | "identical-to-source"
  /** Every plural category is byte-identical in a language with >2 categories. */
  | "uniform-plural"
  /** A category the language genuinely needs was filled from `_other`. */
  | "undifferentiated-category";

/**
 * What happens to a value that is still suspect after the corrective retry.
 *
 * `block` is the only disposition that can lose a value — it is what turns the
 * CLI non-zero — so it is RESERVED for values that demonstrably carry
 * source-language text: an English token spliced into an otherwise-translated
 * value, no value at all, or a value that IS the source and is built from
 * ordinary UI vocabulary a translator renders.
 *
 * What may never block is an UNCORROBORATED byte-identical value — filenames
 * like `qr-labels-{{count}}.zip`, slugs, brand-only strings and domain terms
 * are identical by necessity, and the vocabulary list has no signal for them —
 * and a uniform plural group: "{{count}} мл" repeated across all four Russian
 * categories is correct Russian, and blocking it makes the job permanently red
 * with no way to satisfy it.
 *
 * `prefer-previous` is the degrade path for everything else: keep the previous
 * translation when the target file has one, otherwise write the value with a
 * warning — and in BOTH cases leave the key out of the cache so the next run
 * tries again. Silent-and-cached is the one outcome this module must never
 * produce (within the script scope stated at the top of the file).
 */
export type LeakDisposition =
  /** Never write the value: keep the previous translation, or omit the key. */
  | "block"
  /** Keep the previous translation if there is one; otherwise write and warn. */
  | "prefer-previous"
  /** Write the value; report it as a warning only. */
  | "accept";

export interface LeakSuspect {
  /** The emitted key, e.g. `portfolio.item_few`. */
  key: string;
  reason: LeakReason;
  /** Human-readable explanation, used in the corrective retry and in errors. */
  detail: string;
  /**
   * `fail` suspects trigger the one corrective retry; `warn` suspects never do
   * — a warning is by definition a usable value, and re-rolling a whole chunk
   * for one is a wasted API call that can come back worse.
   */
  severity: "fail" | "warn";
  disposition: LeakDisposition;
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

/** As `stripVerbatim`, but without leaving a space behind — used only to ask
 * whether what remains is a single unbroken identifier. */
function stripVerbatimTight(text: string): string {
  let out = text;
  for (const pattern of VERBATIM_PATTERNS) out = out.replace(pattern, "");
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
 * Ordinary English UI vocabulary — the words a translator is expected to
 * translate. An echo is only reported for a word on this list.
 *
 * The list is an allow-list for *failing*, not a dictionary of English: an
 * unknown word is assumed to be a proper noun, a domain term or a loanword and
 * is left alone. Words deliberately kept OUT because real locales retain them
 * verbatim: `email`, `cookie`, `logo`, `favicon`, `query`, `router`, `standard`,
 * `journey`, `discover`, `incoterm`, `make`, `e-label`, `wine`, `single`,
 * `year`, `research`, `works`. Function words are out too — they only ever
 * appear inside proper-noun phrases ("Fair for Life").
 */
const TRANSLATABLE_WORDS = new Set([
  "abort", "accept", "action", "activate", "active", "add", "address", "alert",
  "amount", "answer", "apply", "approve", "archive", "attach", "attachment",
  "available", "back", "beverage", "bottle", "browse", "button", "buyer",
  "cancel", "category", "change", "check", "choose", "clear", "click", "close",
  "collapse", "colour", "column", "comment", "company", "complete", "confirm",
  "connect", "contact", "continue", "copy", "count", "create", "currency",
  "current", "customer", "date", "day", "decline", "delete", "deliver",
  "delivery", "description", "detail", "disable", "discard", "dismiss",
  "document", "done", "download", "draft", "duplicate", "edit", "empty",
  "enable", "error", "expand", "expire", "export", "fail", "failure",
  "favourite", "field", "file", "filter", "finish", "folder", "form", "found",
  "hide", "hour", "image", "import", "inactive", "invite", "item", "keyword",
  "label", "language", "link", "list", "listing", "load", "loading", "log",
  "login", "logout", "manage", "match", "member", "message", "minute", "month",
  "move", "name", "network", "note", "notification", "number", "offer",
  "open", "option", "order", "organisation", "organization", "owner", "page",
  "password", "paste", "pending", "picture", "preview", "price", "product",
  "profile", "publish", "quantity", "question", "reason", "refresh", "reject",
  "reload", "remove", "rename", "reply", "report", "request", "required",
  "reset", "result", "retry", "return", "review", "role", "row", "sample",
  "save", "search", "second", "select", "seller", "send", "setting", "share",
  "show", "sign", "size", "sort", "start", "state", "status", "step", "stop",
  "submit", "subscribe", "success", "summary", "supplier", "support", "table",
  "tender", "text", "time", "title", "total", "translate", "unit", "unknown",
  "update", "upload", "user", "value", "variant", "version", "view", "volume",
  "warning", "week", "welcome", "word", "write", "year-old",
]);

/**
 * Brand names and acronyms are meant to survive translation ("CellarNode",
 * "PDF", "QR"). Recognised by their spelling: an internal capital or an
 * all-caps form.
 */
function isBrandSpelling(word: string): boolean {
  if (word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
    return true;
  }
  return /[A-Z]/.test(word.slice(1));
}

const SENTENCE_START_RE = /(?:^|[.!?:;•|\n])\s*$/;

/**
 * A Titlecase word that does NOT start a sentence is a proper noun: "Grant" in
 * "e.g., William Grant & Sons", "Noir" in "e.g., Pinot Noir", "Journey" in
 * "Add to Journey". Sentence-initial Titlecase carries no such signal —
 * "Product" in "Product options" is just a capitalised common noun, and that is
 * the exact shape CEL-1539 leaked.
 */
function isProperNounOccurrence(source: string, word: string, index: number): boolean {
  if (isBrandSpelling(word)) return true;
  if (!/^[A-Z]/.test(word)) return false;
  return !SENTENCE_START_RE.test(source.slice(0, index));
}

interface SourceToken {
  /** True when any occurrence of the word looks like a proper noun. */
  proper: boolean;
}

function indexSource(source: string): Map<string, SourceToken> {
  const stripped = stripVerbatim(source);
  const index = new Map<string, SourceToken>();
  for (const match of stripped.matchAll(WORD_RE)) {
    const word = match[0];
    const key = stem(word);
    const proper = isProperNounOccurrence(stripped, word, match.index);
    const existing = index.get(key);
    if (existing) existing.proper ||= proper;
    else index.set(key, { proper });
  }
  return index;
}

/**
 * English tokens from `source` that survived untranslated into `translated`.
 *
 * A token is only reported when ALL of the following hold, because each gate
 * removes a class of legitimate value observed in the shipped locales:
 *
 * - it is not a placeholder, HTML tag, URL or email (copied verbatim by design);
 * - it is not brand-spelled — `PDF`, `CellarNode`, `TanStack` survive on purpose;
 * - no occurrence of it in the source looks like a proper noun (Titlecase away
 *   from a sentence start) — `Pinot Noir`, `William Grant & Sons`,
 *   `Systembolaget`, `Producer Journey`, `Google Analytics`;
 * - it is ordinary English UI vocabulary (`TRANSLATABLE_WORDS`) — an unknown
 *   word is assumed to be a domain term or a retained loanword.
 */
export function findSourceEchoTokens(
  source: string,
  translated: string
): string[] {
  const sourceTokens = indexSource(source);
  if (sourceTokens.size === 0) return [];

  const leaked: string[] = [];
  const seen = new Set<string>();
  for (const word of stripVerbatim(translated).match(WORD_RE) ?? []) {
    if (word.length < 3) continue;
    if (isBrandSpelling(word)) continue;
    const key = stem(word);
    const token = sourceTokens.get(key);
    if (!token || token.proper) continue;
    if (!TRANSLATABLE_WORDS.has(key)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    leaked.push(word);
  }
  return leaked;
}

/**
 * A source that survives translation unchanged BY NECESSITY: a filename, slug,
 * path or dotted identifier. Recognised structurally — one unbroken token once
 * placeholders are removed, carrying a path or extension separator.
 *
 * `_` and `/` are never sentence punctuation, so one of those settles it. A
 * period counts only when it sits BETWEEN two characters (`.zip`, `a.b.c`),
 * never when it merely ends the token: `Vintage.` is a word with a full stop.
 *
 * An internal hyphen is NOT a signal on its own. `Sign-up`, `Read-only`,
 * `Real-time`, `Opt-in` and `Follow-up` are ordinary English compounds a
 * translator renders, and exempting them left a byte-identical English value
 * both silent AND cached — the one outcome this module exists to prevent
 * (CEL-1542). `qr-labels-{{count}}.zip` still qualifies, on its `.zip` rather
 * than its hyphens. The cost is that a bare hyphenated slug with no separator
 * (`cellarnode-admin`) now degrades instead of passing silently: a warning and
 * a retranslation next run, never a failure.
 */
function isIdentifierShaped(source: string): boolean {
  const tight = stripVerbatimTight(source).trim();
  if (tight === "" || /\s/.test(tight)) return false;
  return /[_/]/.test(tight) || /[^.]\.[^.]/.test(tight);
}

/**
 * True when `source` contains English a translator was supposed to render —
 * i.e. at least one word that is neither a placeholder, nor brand-spelled, nor
 * a proper-noun occurrence, in a string that is not itself an identifier.
 *
 * Deliberately NOT vocabulary-driven. `TRANSLATABLE_WORDS` is an allow-list for
 * blaming an individual word inside an otherwise-translated value; using it to
 * decide whether a byte-identical value is suspect made every English string
 * outside the list invisible (`Producer dashboard`, `Vintage`, `Certificate`),
 * which is the CEL-1539 pass-through this module exists to stop.
 */
function hasOrdinaryEnglishContent(source: string): boolean {
  if (isIdentifierShaped(source)) return false;
  const stripped = stripVerbatim(source);
  for (const match of stripped.matchAll(WORD_RE)) {
    // Same floor as `findSourceEchoTokens`: one- and two-letter fragments are
    // abbreviation debris ("e.g.,"), not words a translator renders.
    if (match[0].length < 3) continue;
    if (!isProperNounOccurrence(stripped, match[0], match.index)) return true;
  }
  return false;
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
      disposition: "block",
    };
  }
  if (!usesNonLatinScript(targetLang)) return null;

  const leaked = findSourceEchoTokens(sourceText, value);
  const quoted = leaked.map((t) => `"${t}"`).join(", ");

  // IDENTITY IS CHECKED FIRST, AND INDEPENDENTLY OF `TRANSLATABLE_WORDS`.
  //
  // The vocabulary list used to gate this branch, so a byte-identical value
  // whose words are not on the list ("Producer dashboard", "Vintage",
  // "Certificate") raised no suspect at all: it was written to the locale file
  // AND cached as translated, so no future run ever retried it — the exact
  // 0.3.0 shape this module exists to stop (review round 2, P1a).
  //
  // A value that IS the source is retried, but NEVER blocked: it is the shape
  // both a genuine leak and a legitimately-untranslatable string take, and only
  // the previous translation can tell them apart.
  if (value.trim() === sourceText.trim()) {
    // Nothing a translator could have rendered — `TanStack Query`,
    // `qr-labels-{{count}}.zip`. Identical is the only correct answer.
    if (leaked.length === 0 && !hasOrdinaryEnglishContent(sourceText)) {
      return null;
    }
    return {
      key,
      reason: "identical-to-source",
      detail:
        leaked.length > 0
          ? `value is the English source verbatim (${quoted})`
          : "value is the English source verbatim",
      // Corroborated by ordinary UI vocabulary → worth the one corrective
      // retry. Uncorroborated → the words may be domain terms or a brand the
      // heuristics cannot recognise, so re-rolling a whole chunk is not worth
      // an API call. Either way the value degrades: warned, and left out of the
      // cache so the next run tries again.
      severity: leaked.length > 0 ? "fail" : "warn",
      // A CORROBORATED identity is source-language text by any reading: the
      // whole value is the source AND it is built from words a translator
      // renders. It is blocked like any other echo — previous translation or
      // nothing, never English on disk. Writing it was recoverable (the group
      // left the cache and the CLI still exited 1) but the write happened, and
      // in a uniform plural group it put English into every fallback category
      // (CEL-1542).
      //
      // Uncorroborated identity stays `prefer-previous`: a filename, a slug or
      // a brand-only label is identical by necessity, and blocking those failed
      // the CLI on every run with no answer that could satisfy it.
      disposition: leaked.length > 0 ? "block" : "prefer-previous",
    };
  }

  if (leaked.length === 0) return null;
  return {
    key,
    reason: "source-echo",
    detail: `untranslated English left in the value: ${quoted}`,
    severity: "fail",
    disposition: "block",
  };
}

/**
 * Inspects parsed provider output for the CEL-1539 failure shapes.
 *
 * `translated` is the provider's parsed result; `filledFromOther` names the
 * keys the parser backfilled from the group's translated `_other` form (a
 * usable value, but evidence the model under-differentiated the categories).
 *
 * INVARIANT `filledFromOther` must satisfy: it never contains `${base}_other`.
 * The parser only backfills a key from a usable `_other`, so `_other` itself
 * can never be backfilled — if it were, the `alreadyReported` dedup below would
 * mark `_other` with an `accept` disposition and suppress the `prefer-previous`
 * uniform-plural suspect on that one key, leaving the group half-cached.
 * `parseGeminiResponse` is what upholds it, and a test pins it there.
 */
export function detectLeaks(
  requested: TranslationEntry[],
  translated: TranslationEntry[],
  targetLang: string,
  filledFromOther: ReadonlySet<string> = new Set()
): LeakSuspect[] {
  const byKey = new Map(translated.map((e) => [e.key, e.value]));
  const suspects: LeakSuspect[] = [];

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
    // Ordinal groups resolve against ordinal CLDR rules: ru has four cardinal
    // categories but a single ordinal one, so reading the cardinal set here
    // fails a correct single-form ordinal translation.
    const langCategories = getPluralCategories(
      targetLang,
      pluralTypeForBase(base)
    );

    // Keys this group already reported per value. The uniform-plural check below
    // must not report them a second time: a filename plural group would emit
    // both `identical-to-source` (prefer-previous) and `uniform-plural` for the
    // same key, and `applySuspects` lets the harsher disposition win.
    const alreadyReported = new Set<string>();

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
        alreadyReported.add(key);
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
          disposition: "accept",
        });
        alreadyReported.add(key);
      }
    }

    // Byte-identical across every category, in a language that grammatically
    // differentiates more than two of them, while the English source is itself
    // count-sensitive (distinct forms, or a count placeholder — a single
    // `_other` source like "{{count}} bottles" still has to inflect in ru).
    if (langCategories.length <= 2) continue;
    const values = targetCategories.map((c) => byKey.get(`${base}_${c}`));
    if (values.some((v) => v === undefined)) continue;
    if (new Set(values).size !== 1) continue;
    const forms = Object.values(sourceForms);
    const countSensitive =
      new Set(forms).size >= 2 || forms.some((f) => COUNT_PLACEHOLDER_RE.test(f));
    if (!countSensitive) continue;

    for (const category of targetCategories) {
      const key = `${base}_${category}`;
      if (alreadyReported.has(key)) continue;
      suspects.push({
        key,
        reason: "uniform-plural",
        detail: `all ${targetCategories.length} plural categories are byte-identical, but ${targetLang} has ${langCategories.length} distinct CLDR categories and the English source is count-sensitive`,
        // Worth the one corrective retry — "differentiate the categories" is a
        // correction the model can act on. But NOT a block: uniformity on its
        // own is not evidence of source-language text, and plenty of correct
        // answers are uniform ("{{count}} мл" — Russian unit abbreviations do
        // not inflect; a filename; an invariant code). Blocking those failed
        // the CLI on every run with no answer that could satisfy it (review
        // round 2, P1b). Real leakage is caught by `checkValue` above, where
        // `block` belongs.
        //
        // ACCEPTED COST: a group that is uniform BY NECESSITY can never stop
        // being suspect, so every run spends one corrective retry on it and
        // then evicts it from the cache — forever, for as long as the key
        // exists. The alternative is caching a value we cannot tell apart from
        // a real under-differentiation, which is the CEL-1539 defect. The cache
        // cannot carry an "accepted" marker to end it either: it is keyed by
        // namespace and source hash with no language dimension (`translate()`
        // rewrites the same map once per language), so a marker set while
        // translating ru would silence zh too. This cost lands on Latin-script
        // pl/cs/lt/lv as well, because this check is outside the non-Latin
        // script gate on purpose — those languages differentiate four
        // categories just as ru does.
        severity: "fail",
        disposition: "prefer-previous",
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

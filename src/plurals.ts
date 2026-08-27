import type { PluralExpansion, TranslationEntry } from "./providers/types.js";

/**
 * CLDR plural categories in canonical order.
 * https://cldr.unicode.org/index/cldr-spec/plural-rules
 */
export const PLURAL_CATEGORIES = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

/** i18next marks ordinal plurals with an `_ordinal` segment before the category. */
const ORDINAL_SUFFIX = "_ordinal";

/**
 * A source form that has to inflect with a count says so with a placeholder.
 * The only structural evidence available for telling a real single-form plural
 * (`listingCount_other`: "{{count}} listings") from an enum member that merely
 * ends in `_other` (`document.kind_other`: "Document").
 */
export const COUNT_PLACEHOLDER_RE = /\{\{[^}]*\}\}|\{[0-9]+\}|%[sd]/;

export interface PluralKeyParts {
  base: string;
  category: PluralCategory;
}

/**
 * Splits an i18next plural key into its base and CLDR category.
 * `item_other` → `{ base: "item", category: "other" }`. Returns null for
 * keys with no plural suffix.
 */
export function splitPluralKey(key: string): PluralKeyParts | null {
  const match = PLURAL_SUFFIX_RE.exec(key);
  if (!match) return null;
  return {
    base: key.slice(0, match.index),
    category: match[1] as PluralCategory,
  };
}

function sortCategories(categories: Iterable<string>): PluralCategory[] {
  const set = new Set(categories);
  return PLURAL_CATEGORIES.filter((c) => set.has(c));
}

/**
 * CLDR plural categories the target language actually needs, via
 * `Intl.PluralRules`. Russian/Polish/Czech return one/few/many/other where
 * English only has one/other — that gap is what CEL-1267 exists to close.
 *
 * Falls back to the English shape (one/other) when the tag is unusable, so an
 * unknown language code degrades to today's behaviour instead of throwing.
 */
export function getPluralCategories(
  lang: string,
  type: "cardinal" | "ordinal" = "cardinal"
): PluralCategory[] {
  try {
    const resolved = new Intl.PluralRules(lang, {
      type,
    }).resolvedOptions().pluralCategories;
    const sorted = sortCategories(resolved);
    return sorted.length > 0 ? sorted : ["one", "other"];
  } catch {
    return ["one", "other"];
  }
}

/**
 * Which CLDR rule set a plural base resolves against. i18next marks ordinal
 * plurals with an `_ordinal` segment, and the two sets differ sharply — ru has
 * four cardinal categories but a single ordinal one.
 */
export function pluralTypeForBase(base: string): "cardinal" | "ordinal" {
  return base.endsWith(ORDINAL_SUFFIX) ? "ordinal" : "cardinal";
}

export interface PluralGroup {
  /** Key prefix shared by every variant, e.g. `portfolio.item`. */
  base: string;
  /** English source variants keyed by CLDR category. */
  sourceForms: Record<string, string>;
  /** Source keys belonging to this group, in source order. */
  sourceKeys: string[];
  /**
   * Categories the emitted target file must carry: the union of the English
   * source categories and the target language's own categories. Union rather
   * than replacement so a target with FEWER categories than English (zh, ja)
   * never loses existing translations.
   */
  targetCategories: PluralCategory[];
}

/**
 * Groups the plural keys of a flat source map by base and resolves the plural
 * categories the target language requires for each.
 *
 * Two guards keep incidental keys out of the expansion path, because expanding
 * one invents `_one`/`_few`/`_many` siblings that i18next then serves whenever
 * the count is not "other":
 *
 * - no `_other` variant → not a plural. i18next requires `_other` for every
 *   plural key, so `step_one` ("Step one") is a key that merely ends in `_one`.
 * - a LONE `_other` variant whose value carries no count placeholder → not a
 *   plural either. `document.kind_other` is the "other" document kind, not a
 *   plural of `document.kind`; `listingCount_other` ("{{count}} listings") is a
 *   genuine single-form plural and keeps its expansion.
 */
export function collectPluralGroups(
  sourceFlat: Record<string, string>,
  targetLang: string
): Map<string, PluralGroup> {
  const groups = collectSourceForms(sourceFlat);

  for (const [base, group] of groups) {
    if (rejectReasonFor(group.sourceForms) !== null) {
      groups.delete(base);
      continue;
    }
    const type = pluralTypeForBase(base);
    group.targetCategories = sortCategories([
      ...Object.keys(group.sourceForms),
      ...getPluralCategories(targetLang, type),
    ]);
  }

  return groups;
}

/** Every `_category`-suffixed base in the source, before either guard runs. */
function collectSourceForms(
  sourceFlat: Record<string, string>
): Map<string, PluralGroup> {
  const groups = new Map<string, PluralGroup>();

  for (const key of Object.keys(sourceFlat)) {
    const parts = splitPluralKey(key);
    if (!parts) continue;

    let group = groups.get(parts.base);
    if (!group) {
      group = {
        base: parts.base,
        sourceForms: {},
        sourceKeys: [],
        targetCategories: [],
      };
      groups.set(parts.base, group);
    }
    group.sourceForms[parts.category] = sourceFlat[key];
    group.sourceKeys.push(key);
  }

  return groups;
}

/** Why a suffixed base is not a plural group, or `null` when it is one. */
export type PluralRejectReason =
  | "no-other-variant"
  | "lone-other-without-count";

function rejectReasonFor(
  sourceForms: Record<string, string>
): PluralRejectReason | null {
  const categories = Object.keys(sourceForms);
  if (!categories.includes("other")) return "no-other-variant";
  // The `_other`-sibling guard was one-sided: a base with NOTHING but
  // `_other` passed it and was expanded into a full plural group (CEL-1533).
  if (categories.length === 1 && !COUNT_PLACEHOLDER_RE.test(sourceForms.other)) {
    return "lone-other-without-count";
  }
  return null;
}

/**
 * Bases that LOOK like plural groups — they carry a CLDR category suffix — but
 * are excluded by the guards above, with the reason.
 *
 * Derived from the same `rejectReasonFor` that `collectPluralGroups` deletes
 * with, so the two can never drift apart. Reported because the exclusion has a
 * side effect worth naming: a `_one`/`_few`/`_many` sibling an earlier run
 * invented for the base has no source key and now belongs to no group, so the
 * writer drops it from the target file. That is the right outcome — i18next
 * would serve those keys for every count that is not "other" — but 0.3.x did it
 * with no output at all.
 */
export function rejectedPluralBases(
  sourceFlat: Record<string, string>
): Map<string, PluralRejectReason> {
  const rejected = new Map<string, PluralRejectReason>();
  for (const [base, group] of collectSourceForms(sourceFlat)) {
    const reason = rejectReasonFor(group.sourceForms);
    if (reason !== null) rejected.set(base, reason);
  }
  return rejected;
}

/** Maps every source key of every group back to its group. */
export function indexGroupsBySourceKey(
  groups: Map<string, PluralGroup>
): Map<string, PluralGroup> {
  const index = new Map<string, PluralGroup>();
  for (const group of groups.values()) {
    for (const key of group.sourceKeys) index.set(key, group);
  }
  return index;
}

/** Why a plural group has to be regenerated despite an unchanged source. */
export interface IncompletePluralClassification {
  /** Source keys of groups missing a category the target language needs. */
  missingCategories: string[];
  /**
   * Source keys of groups whose target reproduces the English source in every
   * category. Split out from `missingCategories` because the two converge
   * differently: a missing category is filled by one successful run, while an
   * English-verbatim group can come back English again and again.
   */
  englishFallback: string[];
}

/**
 * Splits the "regenerate even though the source is unchanged" set by reason.
 * The two lists are disjoint: a group with a missing category cannot also hold
 * the English form in every category.
 */
export function classifyIncompletePluralGroups(
  targetFlat: Record<string, string>,
  groups: Map<string, PluralGroup>
): IncompletePluralClassification {
  const missingCategories: string[] = [];
  const englishFallback: string[] = [];

  for (const group of groups.values()) {
    const complete = group.targetCategories.every((category) => {
      const key = `${group.base}_${category}`;
      return key in targetFlat && targetFlat[key] !== "";
    });
    if (!complete) {
      missingCategories.push(...group.sourceKeys);
      continue;
    }
    if (isEnglishFallbackGroup(targetFlat, group)) {
      englishFallback.push(...group.sourceKeys);
    }
  }

  return { missingCategories, englishFallback };
}

/**
 * Source keys of every plural group whose target file needs regenerating even
 * though its English source is unchanged. Two shapes qualify:
 *
 * - a category the language needs is missing or empty — otherwise a locale
 *   written before plural expansion existed never gains its `_few`/`_many`
 *   forms without `--force`;
 * - every category holds the English source form it would have been backfilled
 *   with. Such a group is complete by key count and carries no translation at
 *   all; nothing else in the pipeline can rescue it, because the source hash
 *   never changes and the cache says "done" (CEL-1533).
 *
 * `acceptedSourceKeys` are keys the target language has already retried and
 * stopped asking about (see `LangCacheState`). Only the second shape honours
 * them: a group missing a category is regenerated regardless, because the file
 * is structurally wrong and one successful run fixes it. Without that, a group
 * that is English by necessity on a Latin-script target — where the leak guard
 * deliberately does not run — burned a retranslation on every run forever.
 */
export function incompletePluralSourceKeys(
  targetFlat: Record<string, string>,
  groups: Map<string, PluralGroup>,
  acceptedSourceKeys: ReadonlySet<string> = new Set()
): string[] {
  const { missingCategories, englishFallback } =
    classifyIncompletePluralGroups(targetFlat, groups);
  return [
    ...missingCategories,
    // Accepts are always recorded for a whole group, so filtering per key and
    // per group agree; a half-marked group re-queues, which is the safe way to
    // be wrong.
    ...englishFallback.filter((key) => !acceptedSourceKeys.has(key)),
  ];
}

/**
 * True when the target reproduces the group's English source forms verbatim in
 * every category — the exact shape `expandPluralFallback` writes, and the shape
 * 0.3.0 shipped to production across seven locales.
 *
 * Requires the English source to have TWO OR MORE DISTINCT forms. One form
 * repeated across every category is what a filename, a slug or a Russian unit
 * abbreviation legitimately looks like, and flagging those would retranslate
 * them on every run forever with no answer that could satisfy the check. Two
 * distinct English forms reproduced exactly, category by category, is not
 * something a real translation arrives at.
 *
 * That exemption covers only the single-form case. A multi-form group CAN be
 * English by necessity too — a Latin-script target the leak guard does not
 * judge, a brand-shaped source — so the caller is expected to stop re-queueing
 * a group that has already come back English once (`acceptedSourceKeys` above).
 */
export function isEnglishFallbackGroup(
  targetFlat: Record<string, string>,
  group: PluralGroup
): boolean {
  if (new Set(Object.values(group.sourceForms)).size < 2) return false;
  return group.targetCategories.every((category) => {
    const english = sourceFormFor(group, category);
    return (
      english !== undefined && targetFlat[`${group.base}_${category}`] === english
    );
  });
}

/** The key a plural group is represented by in a provider request. */
export function representativeKey(group: PluralGroup): string {
  const other = `${group.base}_other`;
  return group.sourceKeys.includes(other) ? other : group.sourceKeys[0];
}

/** Builds the provider-facing expansion payload for a group. */
export function toPluralExpansion(group: PluralGroup): PluralExpansion {
  return {
    base: group.base,
    sourceForms: { ...group.sourceForms },
    targetCategories: [...group.targetCategories],
  };
}

/**
 * Best English source text for a target category — the exact form when English
 * has it, otherwise the `_other` form.
 */
export function sourceFormFor(
  expansion: Pick<PluralExpansion, "sourceForms">,
  category: string
): string | undefined {
  return (
    expansion.sourceForms[category] ??
    expansion.sourceForms.other ??
    Object.values(expansion.sourceForms)[0]
  );
}

/**
 * Untranslated fallback used when a provider call fails: emit every target
 * category with the closest English source form, so the written file is never
 * missing a category the language needs.
 */
export function expandPluralFallback(
  entry: TranslationEntry
): TranslationEntry[] {
  if (!entry.plural) return [{ key: entry.key, value: entry.value }];
  return entry.plural.targetCategories.map((category) => ({
    key: `${entry.plural!.base}_${category}`,
    value: sourceFormFor(entry.plural!, category) ?? entry.value,
  }));
}

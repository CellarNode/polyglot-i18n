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

  for (const [base, group] of groups) {
    const categories = Object.keys(group.sourceForms);
    if (!categories.includes("other")) {
      groups.delete(base);
      continue;
    }
    // The `_other`-sibling guard was one-sided: a base with NOTHING but
    // `_other` passed it and was expanded into a full plural group (CEL-1533).
    if (
      categories.length === 1 &&
      !COUNT_PLACEHOLDER_RE.test(group.sourceForms.other)
    ) {
      groups.delete(base);
      continue;
    }
    const type = pluralTypeForBase(base);
    group.targetCategories = sortCategories([
      ...categories,
      ...getPluralCategories(targetLang, type),
    ]);
  }

  return groups;
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
 */
export function incompletePluralSourceKeys(
  targetFlat: Record<string, string>,
  groups: Map<string, PluralGroup>
): string[] {
  const keys: string[] = [];
  for (const group of groups.values()) {
    const complete = group.targetCategories.every((category) => {
      const key = `${group.base}_${category}`;
      return key in targetFlat && targetFlat[key] !== "";
    });
    if (!complete || isEnglishFallback(targetFlat, group)) {
      keys.push(...group.sourceKeys);
    }
  }
  return keys;
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
 */
function isEnglishFallback(
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

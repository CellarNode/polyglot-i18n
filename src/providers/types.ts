/**
 * Describes an i18next plural group so a provider can emit the target
 * language's full CLDR category set — which may be larger than English's
 * one/other (Russian, Polish and Czech need one/few/many/other).
 */
export interface PluralExpansion {
  /** Key prefix shared by every variant, e.g. `portfolio.item`. */
  base: string;
  /** English source variants keyed by CLDR category. */
  sourceForms: Record<string, string>;
  /** Categories the provider must return, as `${base}_${category}` keys. */
  targetCategories: string[];
}

export interface TranslationEntry {
  key: string;
  value: string;
  /**
   * Set only on the single entry that represents a plural group. A provider
   * that declares `supportsPluralExpansion` must return one entry per
   * `targetCategories` member instead of a single entry for `key`.
   */
  plural?: PluralExpansion;
}

export interface TranslationProvider {
  name: string;
  /**
   * True when `translate()` honours `TranslationEntry.plural` and can return
   * more keys than it was given. Providers that leave this unset receive the
   * flat English key set exactly as before.
   */
  supportsPluralExpansion?: boolean;
  translate(
    entries: TranslationEntry[],
    targetLang: string,
    context?: string
  ): Promise<TranslationEntry[]>;
}

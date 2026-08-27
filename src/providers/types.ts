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
  /**
   * Set by a provider when the returned value could not be trusted — it echoed
   * the English source, or the model produced no target form at all (CEL-1539).
   * `value` then carries the English source only so the key set stays complete;
   * consumers MUST NOT write it. `translateNamespace` counts these as failures,
   * keeps any previous translation, and leaves the key out of the cache so the
   * next run retries it.
   */
  failed?: { reason: string; detail: string };
  /**
   * Set by a provider when the value is questionable but not provably wrong —
   * chiefly a value byte-identical to the English source, which is what both a
   * leak and an untranslatable string (filename, slug, brand-only label) look
   * like. `value` is real output and MAY be written: `translateNamespace`
   * prefers any previous translation, falls back to `value`, and reports a
   * warning either way. It is never counted as a failure, so a legitimate
   * identical value cannot turn the CLI non-zero.
   */
  degraded?: { reason: string; detail: string };
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

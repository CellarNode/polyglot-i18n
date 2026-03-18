export interface TranslationEntry {
  key: string;
  value: string;
}

export interface TranslationProvider {
  name: string;
  translate(
    entries: TranslationEntry[],
    targetLang: string,
    context?: string
  ): Promise<TranslationEntry[]>;
}

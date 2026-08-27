export { translate, translateNamespace } from "./translate.js";
export type {
  TranslateOptions,
  TranslateResult,
  NamespaceResult,
} from "./translate.js";
export type {
  TranslationProvider,
  TranslationEntry,
  PluralExpansion,
} from "./providers/types.js";
export {
  collectPluralGroups,
  getPluralCategories,
  isEnglishFallbackGroup,
  rejectedPluralBases,
  splitPluralKey,
  PLURAL_CATEGORIES,
} from "./plurals.js";
export type {
  PluralCategory,
  PluralGroup,
  PluralRejectReason,
} from "./plurals.js";
export {
  acceptedKeysForSource,
  computeDiff,
  entryLangProvenance,
  hashValue,
  mergeNamespaceCache,
  pendingRetryKeys,
  viewForLanguage,
} from "./cache.js";
export type {
  CacheEntry,
  CacheRecord,
  FullCache,
  LangCacheState,
  LangProvenance,
  LanguageCacheView,
  NamespaceCache,
  NamespaceCacheUpdate,
} from "./cache.js";
export {
  detectLeaks,
  findSourceEchoTokens,
  usesNonLatinScript,
} from "./leak-guard.js";
export type { LeakReason, LeakSuspect } from "./leak-guard.js";
export { GeminiProvider } from "./providers/gemini.js";
export { DeepLProvider } from "./providers/deepl.js";

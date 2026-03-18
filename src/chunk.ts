import type { TranslationEntry } from "./providers/types.js";

/**
 * Splits entries into chunks of maxSize for batched API calls.
 */
export function chunkEntries(
  entries: TranslationEntry[],
  maxSize: number
): TranslationEntry[][] {
  if (entries.length === 0) return [];

  const chunks: TranslationEntry[][] = [];
  for (let i = 0; i < entries.length; i += maxSize) {
    chunks.push(entries.slice(i, i + maxSize));
  }
  return chunks;
}

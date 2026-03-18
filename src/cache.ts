import { createHash } from "node:crypto";

export interface DiffResult {
  missing: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * Returns first 8 chars of SHA-256 hash.
 */
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Builds a cache map: { dotPath: hash } from source entries.
 */
export function buildCacheEntries(
  sourceFlat: Record<string, string>
): Record<string, string> {
  const cache: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceFlat)) {
    cache[key] = hashValue(value);
  }
  return cache;
}

/**
 * Computes which keys need translation by comparing source, target, and cache.
 */
export function computeDiff(
  sourceFlat: Record<string, string>,
  targetFlat: Record<string, string>,
  cacheEntries: Record<string, string>
): DiffResult {
  const missing: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const key of Object.keys(sourceFlat)) {
    if (!(key in targetFlat)) {
      missing.push(key);
    } else {
      const currentHash = hashValue(sourceFlat[key]);
      const cachedHash = cacheEntries[key];
      if (cachedHash && cachedHash === currentHash) {
        unchanged.push(key);
      } else {
        changed.push(key);
      }
    }
  }

  return { missing, changed, unchanged };
}

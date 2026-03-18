import { describe, it, expect } from "vitest";
import { chunkEntries } from "../chunk.js";
import type { TranslationEntry } from "../providers/types.js";

describe("chunkEntries", () => {
  it("returns single chunk when under limit", () => {
    const entries: TranslationEntry[] = [
      { key: "a", value: "A" },
      { key: "b", value: "B" },
    ];
    const chunks = chunkEntries(entries, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(entries);
  });

  it("splits into multiple chunks", () => {
    const entries: TranslationEntry[] = Array.from(
      { length: 120 },
      (_, i) => ({
        key: `key${i}`,
        value: `Value ${i}`,
      })
    );
    const chunks = chunkEntries(entries, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(50);
    expect(chunks[2]).toHaveLength(20);
  });

  it("returns empty array for empty input", () => {
    expect(chunkEntries([], 50)).toEqual([]);
  });
});

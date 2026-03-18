import { describe, it, expect, vi } from "vitest";
import { translateNamespace } from "../translate.js";
import { hashValue } from "../cache.js";
import type {
  TranslationProvider,
  TranslationEntry,
} from "../providers/types.js";

function createMockProvider(): TranslationProvider {
  return {
    name: "mock",
    translate: vi.fn(async (entries: TranslationEntry[], lang: string) =>
      entries.map((e) => ({ key: e.key, value: `[${lang}] ${e.value}` }))
    ),
  };
}

describe("translateNamespace", () => {
  it("translates all keys when no target exists", async () => {
    const provider = createMockProvider();
    const source = { save: "Save", cancel: "Cancel" };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: {},
      cacheEntries: {},
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.translated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.output.save).toBe("[sv] Save");
    expect(provider.translate).toHaveBeenCalledOnce();
  });

  it("skips unchanged keys", async () => {
    const provider = createMockProvider();
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.translated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.output.save).toBe("Spara");
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it("retranslates changed keys", async () => {
    const provider = createMockProvider();
    const source = { save: "Save changes" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: false,
    });

    expect(result.changed).toBe(1);
    expect(result.output.save).toBe("[sv] Save changes");
  });

  it("force retranslates everything", async () => {
    const provider = createMockProvider();
    const source = { save: "Save" };
    const target = { save: "Spara" };
    const cache = { save: hashValue("Save") };

    const result = await translateNamespace({
      sourceFlat: source,
      targetFlat: target,
      cacheEntries: cache,
      provider,
      targetLang: "sv",
      force: true,
    });

    expect(result.translated).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

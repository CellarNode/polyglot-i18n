import { describe, it, expect } from "vitest";
import { detectDeepLTier, mapLanguageCode } from "../../providers/deepl.js";

describe("detectDeepLTier", () => {
  it("detects free tier from :fx suffix", () => {
    expect(detectDeepLTier("abc123:fx")).toBe("free");
  });

  it("detects pro tier for regular keys", () => {
    expect(detectDeepLTier("abc123-def456")).toBe("pro");
  });
});

describe("mapLanguageCode", () => {
  it("maps zh to ZH-HANS for DeepL", () => {
    expect(mapLanguageCode("zh")).toBe("ZH-HANS");
  });

  it("maps en to EN-US", () => {
    expect(mapLanguageCode("en")).toBe("EN-US");
  });

  it("uppercases standard codes", () => {
    expect(mapLanguageCode("fr")).toBe("FR");
    expect(mapLanguageCode("de")).toBe("DE");
  });

  it("maps pt to PT-BR", () => {
    expect(mapLanguageCode("pt")).toBe("PT-BR");
  });
});

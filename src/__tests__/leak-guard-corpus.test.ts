import { describe, it, expect } from "vitest";
import { detectLeaks, findSourceEchoTokens } from "../leak-guard.js";
import pairs from "./fixtures/shipped-locale-pairs.json" with { type: "json" };

/**
 * Regression corpus (CEL-1539 review).
 *
 * Every pair below is a verbatim `en` → `zh`/`ru` pair lifted out of a locale
 * file that is live in production: producer-dashboard, importer-dashboard,
 * public-site and @cellarnode/i18n. The `clean` entries are the classes of
 * value the first cut of this guard failed — proper nouns (grape varietals,
 * producers, retailers, people, product and feature names), loanwords a locale
 * keeps on purpose (`cookie`, `email`, `e-label`, `Logo`, `Favicon`), and
 * strings that must stay byte-identical (a filename template, a library name).
 *
 * Failing any of them is not a cosmetic defect: `cli.ts` exits non-zero when
 * `failed > 0`, the key is dropped from the cache, and the next run fails it
 * again — a permanently red translation job with no way to satisfy it. So the
 * bar here is absolute: ZERO of them may be reported, and none may be blocked.
 *
 * The `leak` entries are the counterweight. They are also real — the
 * @cellarnode/i18n zh/ru bundles and the importer `counterError.*` block ship
 * untranslated English today — and prove the corpus is not passing simply
 * because the detector went silent.
 *
 * Regenerate with the locale files themselves; do not hand-edit the values.
 */

interface Pair {
  repo: string;
  lang: string;
  file: string;
  key: string;
  source: string;
  target: string;
  expect: "clean" | "leak";
}

const corpus = pairs as Pair[];
const clean = corpus.filter((p) => p.expect === "clean");
const leaks = corpus.filter((p) => p.expect === "leak");
const label = (p: Pair) => `${p.repo}/${p.lang}/${p.file} ${p.key}`;

describe("regression corpus — shipped locale pairs", () => {
  it("covers the value classes the review flagged", () => {
    expect(clean.length).toBeGreaterThanOrEqual(40);
    expect(leaks.length).toBeGreaterThanOrEqual(4);
    const sources = clean.map((p) => p.source);
    for (const needle of [
      "William Grant & Sons",
      "Pinot Noir",
      "Systembolaget",
      "TanStack Query",
      "qr-labels-{{count}}.zip",
      "Macallan",
      "Glenfiddich",
      "Cookie Policy",
      "Google Analytics",
      "Favicon",
    ]) {
      expect(sources.some((s) => s.includes(needle))).toBe(true);
    }
    expect(new Set(clean.map((p) => p.lang))).toEqual(new Set(["zh", "ru"]));
  });

  it("reports no echo token for any correct shipped value", () => {
    const flagged = clean
      .map((p) => ({ at: label(p), tokens: findSourceEchoTokens(p.source, p.target) }))
      .filter((r) => r.tokens.length > 0);

    expect(flagged).toEqual([]);
  });

  it("never blocks a correct shipped value", () => {
    const blocked = clean
      .map((p) => ({
        at: label(p),
        suspects: detectLeaks(
          [{ key: p.key, value: p.source }],
          [{ key: p.key, value: p.target }],
          p.lang
        ).filter((s) => s.disposition === "block"),
      }))
      .filter((r) => r.suspects.length > 0);

    expect(blocked).toEqual([]);
  });

  it("raises no suspect at all for a correct shipped value", () => {
    // Stronger than the two assertions above: a `warn`/`prefer-previous`
    // suspect is harmless to the file but still noise in every run's output.
    const noisy = clean
      .map((p) => ({
        at: label(p),
        suspects: detectLeaks(
          [{ key: p.key, value: p.source }],
          [{ key: p.key, value: p.target }],
          p.lang
        ),
      }))
      .filter((r) => r.suspects.length > 0);

    expect(noisy).toEqual([]);
  });

  it("still catches the untranslated English that really did ship", () => {
    for (const pair of leaks) {
      expect(
        findSourceEchoTokens(pair.source, pair.target),
        label(pair)
      ).not.toEqual([]);

      const suspects = detectLeaks(
        [{ key: pair.key, value: pair.source }],
        [{ key: pair.key, value: pair.target }],
        pair.lang
      );
      expect(suspects, label(pair)).toHaveLength(1);
      expect(suspects[0].severity, label(pair)).toBe("fail");
      // A value that IS the source can only be resolved against the previous
      // translation; one with English spliced in is provably wrong.
      expect(suspects[0].reason, label(pair)).toBe(
        pair.target.trim() === pair.source.trim()
          ? "identical-to-source"
          : "source-echo"
      );
    }
  });
});

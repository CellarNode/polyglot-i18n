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
 * Review round 3 narrowed exactly one guarantee. "Zero suspects" now holds for
 * the clean pairs that were actually translated; the five byte-identical clean
 * pairs are enumerated and pinned separately, because a byte-identical target
 * is the one shape a leak and a correct value share, and the guard must not
 * stay silent on it. "Never blocked" and "never retried" still hold for ALL of
 * them, so no clean value can fail the CLI or cost an API call.
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
const isIdentical = (p: Pair) => p.target.trim() === p.source.trim();
const identical = clean.filter(isIdentical);
const translated = clean.filter((p) => !isIdentical(p));
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

  it("never spends a corrective retry on a correct shipped value", () => {
    // `fail` severity is what buys a second API call. A clean value that earns
    // one costs a request on every run of every job, forever.
    const retried = clean
      .map((p) => ({
        at: label(p),
        suspects: detectLeaks(
          [{ key: p.key, value: p.source }],
          [{ key: p.key, value: p.target }],
          p.lang
        ).filter((s) => s.severity === "fail"),
      }))
      .filter((r) => r.suspects.length > 0);

    expect(retried).toEqual([]);
  });

  it("raises no suspect at all for a correct shipped value it could translate", () => {
    // Stronger than the two assertions above: a `warn`/`prefer-previous`
    // suspect is harmless to the file but still noise in every run's output.
    //
    // Scoped to the pairs whose target actually differs from the source. A
    // byte-identical target is inherently ambiguous — it is what both a leak
    // and an untranslatable string look like — and since review round 3 the
    // guard reports it rather than staying silent. Those five are enumerated
    // and pinned in the next test.
    const noisy = translated
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

  it("pins which shipped values are byte-identical, and how loud each one is", () => {
    // The exemption above is only safe while this bucket stays known. A new
    // byte-identical pair must be classified here on purpose, not inherit the
    // exemption silently.
    expect(identical.map(label)).toEqual([
      "producer-dashboard/zh/qr-labels.json bulkExport.filename",
      "producer-dashboard/ru/qr-labels.json bulkExport.filename",
      "producer-dashboard/zh/common.json devtools.tanstackQuery",
      "producer-dashboard/ru/common.json devtools.tanstackQuery",
      "producer-dashboard/ru/market.json listing.deliveryTermsIncoterm2020",
    ]);

    const suspectsFor = (p: Pair) =>
      detectLeaks(
        [{ key: p.key, value: p.source }],
        [{ key: p.key, value: p.target }],
        p.lang
      );

    // Structurally untranslatable — a filename template, and a brand followed
    // by a Titlecase proper noun. Silence here is earned, not vocabulary luck.
    for (const p of identical.filter((x) => x.key !== "listing.deliveryTermsIncoterm2020")) {
      expect(suspectsFor(p), label(p)).toEqual([]);
    }

    // "Incoterm 2020" is a standard's name, but sentence-initial Titlecase
    // carries no proper-noun signal, so it is indistinguishable from "Save".
    // The guard says so out loud instead of guessing: a warn-level
    // prefer-previous, which keeps the shipped value, never fails the CLI, and
    // leaves the key out of the cache.
    const incoterm = identical.find(
      (p) => p.key === "listing.deliveryTermsIncoterm2020"
    )!;
    expect(suspectsFor(incoterm)).toEqual([
      expect.objectContaining({
        reason: "identical-to-source",
        severity: "warn",
        disposition: "prefer-previous",
      }),
    ]);
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

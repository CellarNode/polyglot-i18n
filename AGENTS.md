# polyglot-i18n

AI-powered i18n translation CLI + GitHub Action. Translates JSON locale files using Google Gemini (default) or DeepL. Drop-in replacement for locize / Crowdin / Phrase — zero recurring SaaS cost.

## Stack

- TypeScript 5.x. Built with `tsc`. Tested with vitest.
- Distributed as BOTH:
  - npm CLI: `polyglot-i18n` bin (global install or `npx`).
  - GitHub Action: `action.yml` + bundled `dist/` (`uses: CellarNode/polyglot-i18n@v1`).

## Commands

```bash
pnpm install
pnpm build              # Builds CLI + GitHub Action distribution
pnpm test               # vitest run
```

## Usage

### Local CLI (engineer-driven refresh)

```bash
GOOGLE_API_KEY=<key> polyglot-i18n translate \
  -i ./locales/en \
  -o sv,fr,de,it,es,zh \
  -c "CellarNode beverage matching platform"

# Single flat file
polyglot-i18n translate -i ./en.json -o sv,fr,de

# Force retranslate all keys (overwrites cache)
polyglot-i18n translate -i ./locales/en -o sv --force

# Preview without API calls
polyglot-i18n translate -i ./locales/en -o sv --dry-run

# DeepL provider
DEEPL_API_KEY=<key> polyglot-i18n translate -i ./locales/en -o sv,fr,de -p deepl
```

### GitHub Action (auto-PR on merge)

```yaml
- uses: CellarNode/polyglot-i18n@v1
  with:
    input: './locales/en'
    output-languages: 'sv,fr,de,it,es,zh'
    api-key: ${{ secrets.GOOGLE_API_KEY }}
    context: 'Your app description'
    force: ${{ inputs.force }}
```

The action creates a PR with translated files. Consumer workflow needs `contents: write` + `pull-requests: write` permissions.

## Incremental cache

`.polyglot-cache.json` tracks per-key SHA hashes of the English source. Only changed keys are
retranslated. **ALWAYS commit the cache file** — it prevents the CI pipeline from clobbering
manual translation fixes.

The cache has a **language dimension** since 0.4.0 (CEL-1543). An entry is either a bare hash —
what every version up to 0.3.2 wrote, read as "every language's value on disk answers this text" —
or `{ hash, langs: { zh: { hash, state?: "stale" | "accepted" } } }`. Only divergence is recorded,
so an all-clean namespace stays a plain hash map and existing cache files need no migration; a key
upgrades to the record shape the first time a language diverges on it.

Three rules hold the whole design up:

- **A language's `hash` is PROVENANCE, not a timestamp.** It is the English text that language's
  value on disk was made from. Stamping a marker with whatever hash was current when it was
  written let the next run read an eviction as "asked about exactly this text" when it had in fact
  kept a translation of the PREVIOUS text — and accept it. A record with NO hash means nothing
  vouches for the file at all: never cached, never accept-eligible.
- **The entry-level `hash` is the default for unlisted languages, and it is FROZEN.** It is set
  once, when the entry is created, and never advances. 0.3.x rewrote a shared hash inside the
  per-language loop, so after an English edit the first language retranslated and every later one
  measured its own stale file against the new hash and skipped.
- **`mergeNamespaceCache` touches one language.** 0.3.x held the union of every eviction in memory
  and rewrote the whole namespace on each language's turn, so the eviction died with the process:
  `-o zh` then `-o ru` as two commands put the key back and cached a value nothing had vouched
  for. It also billed every other language for a retranslation it did not need.

A language with no record is cached at the default. Safe because a language with no value on disk
is classified `missing` by `computeDiff` before the cache is consulted, so "cached" can only be
reached by a language that already has one.

`accepted` is the mitigation the dimension unlocks: a key whose target file already holds a better
answer than the provider can produce (a uniform `{{count}} мл` group, a `{{count}} PDF` the leak
guard examined and waved through) stops being retried, for that language, against that source
hash. It never forms under `--force`, never over a target file holding the English source, and
never where the leak guard did not run — on a Latin-script target an English leak is
indistinguishable from a value that is English by necessity, so the re-queue stands and the
per-run cost is paid. Both eviction and accept are per language by construction —
`staleSourceKeys` / `acceptedSourceKeys` / `sourceProvenance` on `NamespaceResult`.

## Structure

```
src/
├── cli.ts             # `polyglot-i18n` entry (commander)
├── index.ts           # Public API
├── translate.ts       # Core translation loop
├── chunk.ts           # Batch keys to respect provider token limits
├── cache.ts           # .polyglot-cache.json read/write + per-language resolution
├── json-utils.ts      # Recursive JSON walking (preserves nesting)
├── placeholder.ts     # Protect {{variables}}, plurals (_one/_other), HTML tags
├── plurals.ts         # CLDR plural groups + Intl.PluralRules category resolution
├── providers/         # gemini.ts, deepl.ts
└── __tests__/

action.yml             # GitHub Action manifest
```

## What it preserves

- `{{variables}}` interpolation
- Nested JSON structure
- HTML tags inside translation strings

## Plural categories

Target files are NOT a 1:1 mirror of the English key set. `src/plurals.ts` resolves each target
language's CLDR categories via `Intl.PluralRules`, and the Gemini provider is asked for the full
set — so `item_one`/`item_other` in English becomes `item_one`/`item_few`/`item_many`/`item_other`
in Russian and Polish. The emitted set is the union of English's categories and the target's, so
languages with fewer categories (zh, ja) never lose translations. Detection requires an `_other`
sibling, which keeps incidental keys like `step_one` out of the expansion path — and a base with
NOTHING but `_other` needs a count placeholder to qualify, so `document.kind_other` ("Document")
is an enum member rather than a plural. DeepL does not opt in
(`TranslationProvider.supportsPluralExpansion`) and is still sent the flat English key set, but
`translateNamespace` carries over target-only categories already in the file for EVERY provider —
running DeepL over a locale Gemini expanded must not delete its `_few`/`_many` (CEL-1533).

## Translation-quality guard

`src/leak-guard.ts` inspects parsed Gemini output before anything is written: untranslated
English echoed into a non-Latin-script target, a key the model never returned, and plural
categories that came back byte-identical in a language with more than two of them. A suspicious
chunk gets exactly one corrective retry; values that are still bad are marked
`TranslationEntry.failed` and never written — `translateNamespace` keeps the previous
translation, counts the key as failed, and drops it from the cache so the next run retries it.
The parser NEVER substitutes the English source for a missing key; that backfill is what shipped
429 English strings to production in 0.3.0 (CEL-1539).

Two rules are easy to get backwards. `block` — the only disposition that loses a value and the
only one that exits the CLI non-zero — covers an English token spliced into a translated value, a
missing value, and a byte-identical value whose words are on `TRANSLATABLE_WORDS`. It must NEVER
cover an uncorroborated byte-identical value (a filename, a slug, a brand) or a uniform plural
group: both are correct by necessity often enough that blocking them makes the job permanently
red. And every check except the missing-value and uniform-plural ones is gated on the target
using a non-Latin script, so "never silent-and-cached" is a guarantee about zh/ru/uk/ar, not fr
or sv.

## CRITICAL: do not run `instrument`

**NEVER run `polyglot-i18n instrument`** — it wraps CSS values, gradient strings, class names, and non-text content with `t()`, breaks rendering, and produces garbage translation keys. Always add `t()` calls manually, component by component.

This rule is re-stated in every consumer's AGENTS.md (`cellarnode-public-site`, `producer-dashboard`, `cellarnode-importer-dashboard`, ...) because the symptom is silent visual breakage.

## Consumers

All CellarNode i18n pipelines: `cellarnode-public-site`, `producer-dashboard`, `cellarnode-importer-dashboard`, `cellarnode-elabel-frontend`, `cellarnode-mobile-app` (manual mode), and the locale dev workflow of `@cellarnode/i18n` itself.

## Agent skills

### Issue tracker

Linear, workspace `cellarnode`, team **CellarNode** (`CEL`) — Linear MCP first,
GraphQL `issueCreate` fallback. There are no GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Linear states carry `needs-triage` (`Backlog`) and `wontfix` (`Canceled`); three new labels
carry `needs-info`, `ready-for-agent`, `ready-for-human`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. ADRs are graph-anchored RepoSkein decisions, not `docs/adr/*.md`.
See `docs/agents/domain.md`.

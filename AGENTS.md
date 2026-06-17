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

`.polyglot-cache.json` tracks per-key SHA hashes of the English source. Only changed keys are retranslated. **ALWAYS commit the cache file** — it prevents the CI pipeline from clobbering manual translation fixes.

## Structure

```
src/
├── cli.ts             # `polyglot-i18n` entry (commander)
├── index.ts           # Public API
├── translate.ts       # Core translation loop
├── chunk.ts           # Batch keys to respect provider token limits
├── cache.ts           # .polyglot-cache.json read/write
├── json-utils.ts      # Recursive JSON walking (preserves nesting)
├── placeholder.ts     # Protect {{variables}}, plurals (_one/_other), HTML tags
├── providers/         # gemini.ts, deepl.ts
└── __tests__/

action.yml             # GitHub Action manifest
```

## What it preserves

- `{{variables}}` interpolation
- i18next plurals (`_one`, `_other`, `_zero`, `_few`, `_many`)
- Nested JSON structure
- HTML tags inside translation strings

## CRITICAL: do not run `instrument`

**NEVER run `polyglot-i18n instrument`** — it wraps CSS values, gradient strings, class names, and non-text content with `t()`, breaks rendering, and produces garbage translation keys. Always add `t()` calls manually, component by component.

This rule is re-stated in every consumer's AGENTS.md (`cellarnode-public-site`, `producer-dashboard`, `cellarnode-importer-dashboard`, ...) because the symptom is silent visual breakage.

## Consumers

All CellarNode i18n pipelines: `cellarnode-public-site`, `producer-dashboard`, `cellarnode-importer-dashboard`, `cellarnode-elabel-frontend`, `cellarnode-mobile-app` (manual mode), and the locale dev workflow of `@cellarnode/i18n` itself.

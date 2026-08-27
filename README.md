# polyglot-i18n

AI-powered i18n translation CLI + GitHub Action. Translate JSON locale files using Google Gemini or DeepL.

Drop-in replacement for locize, Crowdin, and Phrase — zero recurring SaaS cost.

## Features

- **Two providers:** Google Gemini (AI, cheap) and DeepL (professional quality)
- **Incremental:** Only translates missing or changed keys — won't overwrite manual edits
- **Preserves:** `{{variables}}`, nested JSON, HTML tags
- **Plural-aware:** Generates each language's own CLDR plural categories — Russian and Polish get `_one`/`_few`/`_many`/`_other` from an English `_one`/`_other` source
- **Two modes:** Namespaced directories (`en/common.json`) or flat files (`en.json`)
- **GitHub Action:** Auto-creates a PR with translated files
- **Dry run:** Preview what would be translated before running

## Install

```bash
npm install -g polyglot-i18n
```

## Quick Start

```bash
# Translate all English namespaces to 6 languages using Gemini
export GOOGLE_API_KEY="your-key"
polyglot-i18n translate -i ./locales/en -o sv,fr,de,it,es,zh

# Use DeepL instead
export DEEPL_API_KEY="your-key"
polyglot-i18n translate -i ./locales/en -o sv,fr,de -p deepl

# Translate a single flat file
polyglot-i18n translate -i ./en.json -o sv,fr,de

# Force retranslate everything
polyglot-i18n translate -i ./locales/en -o sv --force

# Dry run — see what would be translated
polyglot-i18n translate -i ./locales/en -o sv --dry-run

# Add domain context for better translations
polyglot-i18n translate -i ./locales/en -o sv -c "E-commerce checkout flow"
```

## CLI Reference

```
polyglot-i18n translate [options]

Options:
  -i, --input <path>              Source English file or directory (required)
  -o, --output-languages <langs>  Comma-separated target language codes (required)
  -p, --provider <provider>       gemini or deepl (default: gemini)
  -m, --model <model>             Gemini model (default: gemini-3.1-flash-lite-preview)
  -k, --api-key <key>             API key (or use GOOGLE_API_KEY / DEEPL_API_KEY env)
  --output-dir <path>             Output directory
  -f, --force                     Retranslate all keys
  --dry-run                       Preview without translating
  --cache-file <path>             Cache file path (default: .polyglot-cache.json)
  --no-cache                      Disable incremental cache
  -c, --context <text>            Domain context for better translations
```

## GitHub Action

```yaml
name: Translate
on:
  workflow_dispatch:
    inputs:
      force:
        description: 'Force retranslate all keys'
        required: false
        default: false
        type: boolean

permissions:
  contents: write
  pull-requests: write

jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: CellarNode/polyglot-i18n@v1
        with:
          input: './locales/en'
          output-languages: 'sv,fr,de,it,es,zh'
          api-key: ${{ secrets.GOOGLE_API_KEY }}
          context: 'Your app description'
          force: ${{ inputs.force }}
```

The action automatically creates a PR with the translated files.

### Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider` | No | `gemini` | `gemini` or `deepl` |
| `input` | Yes | — | Path to English source file/directory |
| `output-languages` | Yes | — | Comma-separated target language codes |
| `api-key` | Yes | — | Provider API key |
| `model` | No | `gemini-3.1-flash-lite-preview` | Model (Gemini only) |
| `output-dir` | No | auto | Output directory |
| `force` | No | `false` | Retranslate all keys |
| `context` | No | — | Domain context |

## How Incremental Translation Works

polyglot-i18n tracks which English strings have been translated via a `.polyglot-cache.json` file:

| Key state | What happens |
|-----------|-------------|
| **Missing** — key in English but not in target | Translated |
| **Changed** — English value changed since last run | Retranslated |
| **Unchanged** — same as last run | Skipped (existing translation preserved) |

Use `--force` to retranslate everything regardless of cache state.

## Plural Categories

English has two plural categories (`one`, `other`). Many languages have more — Russian, Polish
and Czech need `one`, `few`, `many` and `other`, and Arabic needs all six. A target file that
only mirrors the English key set therefore cannot express those languages correctly: i18next
falls back to `_other`, so counts like 2, 3 and 4 render the wrong form.

polyglot-i18n resolves each target language's categories with `Intl.PluralRules` and asks the
model for the full set:

```jsonc
// locales/en/common.json
{
  "item_one": "{{count}} item",
  "item_other": "{{count}} items"
}
```

```jsonc
// locales/ru/common.json — four categories from a two-category source
{
  "item_one": "{{count}} товар",
  "item_few": "{{count}} товара",
  "item_many": "{{count}} товаров",
  "item_other": "{{count}} товара"
}
```

Details worth knowing:

- **Detection is conservative.** A key only counts as a plural when its base has an `_other`
  variant, which i18next requires. A lone `step_one` ("Step one") is left alone.
- **Categories are never removed.** The emitted set is the union of the English categories and
  the target's own, so a language with fewer categories than English (`zh`, `ja`) keeps its
  existing translations.
- **Existing locales upgrade themselves.** A target file missing a category its language needs
  is regenerated on the next run even when the English source is unchanged — no `--force`.
- **The cache stays keyed on English.** `.polyglot-cache.json` tracks the English source keys;
  the extra target-only forms are carried over untouched between runs.
- **Ordinals are handled too** — an i18next `_ordinal_*` key resolves against ordinal rules.
- **Gemini only.** DeepL translates strings, not key sets, so the DeepL provider keeps writing
  the flat English key set.

## Providers

### Google Gemini

Default provider. Set `GOOGLE_API_KEY` env var or pass `--api-key`.

Default model: `gemini-3.1-flash-lite-preview`. Override with `--model`.

### DeepL

Set `DEEPL_API_KEY` env var or pass `--api-key`. Free and Pro tiers auto-detected from the key format (free keys end in `:fx`).

DeepL translates strings rather than key sets, so it writes the flat English key set — see
[Plural Categories](#plural-categories).

```bash
polyglot-i18n translate -i ./locales/en -o sv,fr,de -p deepl
```

## Supported Input Formats

**Namespaced directory:**
```
locales/en/common.json    →    locales/sv/common.json
locales/en/auth.json      →    locales/sv/auth.json
```

**Flat file:**
```
en.json    →    sv.json, fr.json, de.json
```

Auto-detected from the input path.

## Programmatic API

```typescript
import { translate, GeminiProvider } from "polyglot-i18n";

const provider = new GeminiProvider(process.env.GOOGLE_API_KEY!);

const result = await translate({
  input: "./locales/en",
  outputLanguages: ["sv", "fr", "de"],
  provider,
  context: "E-commerce platform",
});

console.log(`Translated ${result.translated} keys, skipped ${result.skipped}`);
```

## License

MIT

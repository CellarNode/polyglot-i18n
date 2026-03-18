# polyglot-i18n

AI-powered i18n translation CLI + GitHub Action. Translate JSON locale files using Google Gemini or DeepL.

Drop-in replacement for locize, Crowdin, and Phrase — zero recurring SaaS cost.

## Features

- **Two providers:** Google Gemini (AI, cheap) and DeepL (professional quality)
- **Incremental:** Only translates missing or changed keys — won't overwrite manual edits
- **Preserves:** `{{variables}}`, nested JSON, plurals (`_one`/`_other`), HTML tags
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

## Providers

### Google Gemini

Default provider. Set `GOOGLE_API_KEY` env var or pass `--api-key`.

Default model: `gemini-3.1-flash-lite-preview`. Override with `--model`.

### DeepL

Set `DEEPL_API_KEY` env var or pass `--api-key`. Free and Pro tiers auto-detected from the key format (free keys end in `:fx`).

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

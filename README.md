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

### The cache has a language dimension

An entry is normally just the hash of the English source, meaning "every language's translation
was made from this text":

```jsonc
// .polyglot-cache.json
{
  "common.json": {
    "save": "1d4f2a9c",
    "cancel": "8b03e517"
  }
}
```

A language that diverges from that — because it has retranslated newer English, because it could
not vouch for its value, or because it has stopped asking — records its own entry, and the key
grows a `langs` map:

```jsonc
{
  "common.json": {
    // The default, "1d4f2a9c", is the hash any language NOT listed below is
    // still on. It is frozen: it never moves, so a locale that has not run
    // since the English changed is never told its file is current.
    "save": {
      "hash": "1d4f2a9c",
      "langs": {
        // zh has already retranslated the edited English...
        "zh": { "hash": "5a71c0de" },
        // ...ru could not vouch for its value and will retry it. The hash is
        // what the RU FILE answers, not what English says today.
        "ru": { "hash": "1d4f2a9c", "state": "stale" }
      }
    },
    // el converged twice on a group whose value the leak guard examined and
    // waved through, so it stopped asking — at that hash. Any English edit,
    // or --force, asks again. (A Latin-script target like de never earns an
    // accept this way — the guard does not run there, so it is re-queued.)
    "item_other": {
      "hash": "6ec1b820",
      "langs": { "el": { "hash": "6ec1b820", "state": "accepted" } }
    },
    "cancel": "8b03e517"
  }
}
```

- **The hash on a language's record is provenance, not a timestamp.** It is the English text that
  language's value on disk was made from. That is what an `accepted` or `stale` marker is checked
  against, so an eviction that kept a translation of the PREVIOUS English can never, one run
  later, be read as evidence that the file answers the current text.
- **A language with no record is on the entry's default hash, and the default never moves.**
  Before 0.4.0 the hash was shared and rewritten by whichever language ran last, so after an
  English edit the first language retranslated and every later one measured its own stale file
  against the new hash and skipped. `-o zh,ru` and `-o zh` then `-o ru` were equally affected.
- **Cache files from 0.3.x and earlier load unchanged.** A bare hash keeps its old meaning —
  every language is on this text — so nothing needs migrating and no first run after upgrading
  retranslates anything it would not have retranslated before. A key upgrades to the record shape
  only when a language actually diverges on it.
- **A language not named in `langs` is cached.** That cannot silently skip a language with no
  translation on disk: a key absent from a target file is classified **Missing** before the cache
  is consulted at all.
- **A record with no `hash` means nothing vouches for the file.** A run that keeps a previous
  translation it has no cache entry behind writes `{ "state": "stale" }` and no hash, rather than
  claiming the current one. Such a key is retranslated every run until a translation the run can
  vouch for lands — the same cost 0.3.x paid, and the honest answer when there is no evidence.
- **One language's problem is not another language's bill.** Before 0.4.0 an eviction was
  expressed by deleting the key, which deleted it for everyone, so a single degraded `zh` value
  meant `sv`, `fr`, `de`, `it`, `es` and `ru` all retranslated it on the next run — with a
  different model answer each time.
- **Evictions survive the process.** Running `-o zh` and then `-o ru` as two separate commands now
  behaves exactly like `-o zh,ru`. Before 0.4.0 the second command put the first command's
  evictions back.
- **`--force` never records an accept.** It always evicts a value it could not vouch for, exactly
  as every version before 0.4.0 did. It is the command for re-opening decisions, not for making
  them.

`--cache-file` and `--no-cache` are unchanged. Commit `.polyglot-cache.json` — it is what stops CI
from clobbering hand-edited translations.

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
  variant, which i18next requires. A lone `step_one` ("Step one") is left alone. A base with
  NOTHING but `_other` needs a count placeholder to qualify: `listingCount_other`
  ("{{count}} listings") is a plural, `document.kind_other` ("Document") is an enum member and
  expanding it would invent `_one`/`_few`/`_many` keys i18next then serves. When a rejected base
  still has such siblings in a target file from an earlier run, they are dropped — and the run
  says so by name, rather than removing them in silence.
- **Categories are never removed.** The emitted set is the union of the English categories and
  the target's own, so a language with fewer categories than English (`zh`, `ja`) keeps its
  existing translations.
- **Existing locales upgrade themselves.** A target file missing a category its language needs
  is regenerated on the next run even when the English source is unchanged — no `--force`.
- **A group filled with the English source is regenerated too.** A locale where every category
  holds the English form it would have been backfilled with is complete by key count and carries
  no translation; it is retranslated without `--force`. Only groups whose English has two or more
  distinct forms qualify — one form repeated is what a filename or a `{{count}} мл` legitimately
  looks like. The comparison ignores surrounding whitespace, matching the leak guard's own
  identity test, because a provider does not trim individual values.

  If the retranslation hands back the English source **again**, what happens next depends on
  whether anything is in a position to judge the value:

  - on a **non-Latin** target (`zh`, `ru`, `uk`, `ar`, …) the leak guard read every category and
    stayed silent, which means the source has no ordinary English content to render — a
    `{{count}} PDF`. A third attempt cannot produce a different answer, so the group is accepted
    for that language at that source hash and stops being re-queued.
  - on a **Latin-script** target (`de`, `fr`, `es`, `it`, `sv`, …) the guard does not run at all,
    so nothing has looked at the value and a genuine English leak is indistinguishable from a
    correct one. Accepting it would cache the leak permanently, so the group is re-queued on
    every run instead. That is a real per-run cost, and it is the one the leak guard's script
    scope obliges: a recoverable bill beats an unrecoverable English locale.

  `--force`, or an edit to the English, asks again — and `--force` never records an accept of its
  own.
- **The cache stays keyed on English, per language.** `.polyglot-cache.json` tracks the English
  source keys; the extra target-only forms are carried over untouched between runs. It is scoped
  per namespace, and a key one language drops stays dropped **for that language**, across
  invocations — see [How Incremental Translation Works](#how-incremental-translation-works).
- **Ordinals are handled too** — an i18next `_ordinal_*` key resolves against ordinal rules.
- **Gemini writes them; DeepL never deletes them.** DeepL translates strings, not key sets, so it
  is still sent the flat English key set. Target-only categories already in the file are carried
  over untouched, so pointing DeepL at a locale Gemini expanded does not wipe its `_few`/`_many`.

## Translation-quality guard

Gemini output is inspected before it is written (`src/leak-guard.ts`). A value is flagged when it

- is **missing or empty**, where earlier versions silently wrote the English source instead;
- carries **English words copied from the source**, for a target language written in a non-Latin
  script (`zh`, `ru`, `uk`, `ar`, ...);
- is **byte-identical to the English source**, in the same non-Latin targets;
- repeats one identical string across **every plural category** of a language that grammatically
  distinguishes more than two, while the English source is count-sensitive (its forms differ, or
  it carries a `{{count}}` placeholder). Ordinal groups (`_ordinal_*`) resolve against ordinal
  CLDR rules, where `ru` has a single category and one repeated form is correct.

A chunk with any flagged value is sent back to the model **once**, with the specific problems
named. Only these hard flags earn that retry — an imperfect-but-usable value (a category copied
from a translated `_other`) is reported as a warning and never costs a second API call. The retry
is merged **per key**: a key is replaced only when it was flagged *and* the retry improved it, so
a correction can never drop a value that was already good.

What happens to a value that is still flagged afterwards depends on what it is:

| Shape | Outcome |
| --- | --- |
| English spliced into a translated value, or no value at all | **Blocked.** The previous translation is kept, or the key is left out of the file entirely. Counted in `failed`, reported in `errors`, dropped from the cache. |
| Byte-identical to the source, **and** built from ordinary UI vocabulary (`Save`, `Download labels`) | **Blocked**, same as above. The whole value is the source and every word in it is one a translator renders — English never reaches the file. |
| Byte-identical to the source, uncorroborated (`Systembolaget`, `Vintage`, `qr-labels-{{count}}.zip`) | **Never blocked.** The previous translation wins if there is one; otherwise the value is written. Reported as a warning and dropped from the cache, never counted in `failed`. Once a translation on disk that is known to answer the current English has beaten the same text twice, the key is accepted for that language and stops being retried. |
| A uniform plural group | **Never blocked.** Same as above: warned, written or beaten by the previous translation, dropped from the cache, then accepted on the retry that changes nothing. |
| A category copied from a translated `_other` | **Written**, reported as a warning. |

English is never written over a gap on any path — including an API outage, where a failed chunk
keeps existing translations and omits the keys that have none.

The **uncorroborated** byte-identical case is deliberately non-fatal. Filenames
(`qr-labels-{{count}}.zip`), slugs and brand-only labels (`Systembolaget`, `TanStack Query`) are
identical by necessity, and failing them would exit the CLI non-zero on every run with no way to
satisfy it. Only the target file can tell those apart from a real leak, so the decision is made
there.

A uniform group that is uniform BY NECESSITY (`{{count}} мл` — Russian unit abbreviations do not
inflect) can never stop being suspect, so the first run that meets it spends one corrective retry
and one cache eviction on it. That is the accepted price of never caching a value the guard cannot
distinguish from a real under-differentiation, and it applies to Latin-script `pl`, `cs`, `lt` and
`lv` as well, because the uniform check is deliberately outside the script gate — those languages
need four CLDR categories just as `ru` does.

It is a one-off cost rather than a per-run one. The eviction is recorded against the language that
made it, stamped with the English its file actually answers, so the next run can see that the
model has already been asked about this exact text and that the file already holds a real
translation — and accepts it instead of paying again. Three things can never be accepted, and each
goes back to being retried instead:

- a target file holding the English source, with one deliberate exception: a **non-Latin-script**
  plural group that converged to the English source across two rounds — every value examined by
  the leak guard — is accepted rather than re-asked forever (on Latin-script targets, where the
  guard cannot judge, such a group is always re-queued);
- a translation made from English that has since been edited, however long ago the eviction was
  written, because the value on disk renders text that is gone;
- anything at all under `--force`.

### What is never reported as a leak

The echo detector is biased towards silence, because a false positive is unrecoverable: the key is
dropped, the cache entry is removed, and the next run fails it again. Exempt from the check:

- placeholders, HTML tags, URLs and email addresses (`{{count}}`, `<strong>`, `https://…`);
- brand spellings — an all-caps or internal-capital word (`PDF`, `QR`, `CellarNode`, `TanStack`);
- **proper nouns**: a Titlecase word away from a sentence start (`Pinot Noir`,
  `William Grant & Sons`, `Producer Journey`, `Google Analytics`, `Yellow Label`);
- anything outside `TRANSLATABLE_WORDS`, the list of ordinary UI vocabulary in `leak-guard.ts`.
  An unknown word is assumed to be a domain term or a loanword a locale keeps on purpose —
  `cookie`, `email`, `e-label`, `Logo`, `Favicon`, `Incoterm`, `Systembolaget`.

A byte-identical value is additionally left **silent** when the source could not have been
translated at all: a single unbroken token carrying a path or extension separator
(`qr-labels-{{count}}.zip`, `locales/en/common.json`, `bulk_qr_codes`), or a string made only of
placeholders, brand spellings and proper nouns (`TanStack Query`, `{{count}} PDF`). An internal
hyphen is **not** enough on its own — `Sign-up`, `Read-only` and `Vintage.` are ordinary English,
and exempting them left them silent *and* cached.

`src/__tests__/leak-guard-corpus.test.ts` replays the detector over verbatim `en`→`zh`/`ru` pairs
taken from the locale files shipping in producer-dashboard, importer-dashboard, public-site and
`@cellarnode/i18n`, and asserts that none of them is reported.

Latin-script targets (`fr`, `de`, `it`, `es`, `sv`) get the prompt hardening, the missing-value
check and the uniform-plural check, but neither the source-echo nor the identical-value check: a
stray `option` there is indistinguishable from a loanword. Everything this section says about a
value being warned rather than silently cached is therefore a guarantee about **non-Latin**
targets.

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

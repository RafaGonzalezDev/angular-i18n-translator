# Angular i18n Translator

Node.js CLI tool for managing i18n translation workflows in Angular projects using LLMs (Large Language Models).

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Manual Steps (Recovery)](#manual-steps-recovery)
- [Recommended Setup: DeepSeek](#recommended-setup-deepseek)
- [Other LLM Providers](#other-llm-providers)
- [Manual Editing](#manual-editing)
- [Migrating from 1.x](#migrating-from-1x)
- [Safe Cleanup](#safe-cleanup)
- [Validation](#validation)
- [Security](#security)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Description

**Angular i18n Translator** automates the translation of XLIFF 1.2 (XLF) files used by Angular's internationalization system. It converts the XLF file to CSV, translates it through any OpenAI-compatible LLM API, and converts the result back to one XLF file per language — while respecting interpolations, placeholders, and ICU message formats.

The CSV file is a first-class citizen of the workflow: it is intentionally easy to open, review, and **edit by hand** before or after the automatic translation.

### Workflow

```
messages.xlf --> messages.csv --> batches/*.csv --> LLM translation
             --> batches/translated/<lang>/*.csv --> messages.translated.csv --> dist-i18n/*.xlf
```

## Features

- **XLF 1.2 to CSV conversion** with one column per target language
- **Canonical, versioned CSV content**: `__content_format=xliff-fragment-v1` distinguishes escaped literal text from real inline XLIFF markup; legacy CSV is rejected rather than guessed
- **Placeholder-safe round-trip**: preserves placeholder multiplicity, attributes and nesting; literal `<x>` text stays text, not a placeholder
- **Structural ICU validation**: checks nested expressions, variables, types and selectors using Angular's compiler parser
- **Strict input handling**: malformed XML, XLIFF 2.0 files, and empty files fail fast with clear errors instead of producing corrupt output
- **LLM translation** through any OpenAI-compatible API, with retries and exponential backoff
- **Batch processing** with configurable size and concurrency; languages are processed sequentially, batches in parallel
- **Id-based result matching**: translations are matched back to records by `id`, so rows dropped or reordered by the model are reported as failures instead of silently corrupting other records
- **Verified resume support**: only structurally valid caches matching current inputs and request settings are skipped; `--force` always re-translates
- **Owned-file cleanup**: a versioned artifact manifest tracks generated files; `clean --dry-run` previews deletion without removing foreign content
- **Honest reporting**: the exit code reflects real failures, and untranslated rows are listed explicitly
- **Validation** of interpolations `{{var}}`, inline placeholders, ICU structure, duplicate IDs, and translation coverage

## Prerequisites

- **Node.js** `^24.15.0 || >=26.0.0`: Node 24.15+ within the 24.x line, or Node 26+. Node 18, 20, 22 and 25 are not supported.
- An **API key** from an OpenAI-compatible LLM provider (DeepSeek, OpenAI, Groq, Ollama, ...)
- **Angular CLI** to extract i18n strings (`ng extract-i18n`)

## Installation

```bash
cd angular-i18n-translator
npm install

# Configure environment variables
cp .env.example .env
# Edit .env and set LLM_API_KEY (and optionally LLM_MODEL / LLM_BASE_URL)
```

Then either run the interactive wizard or edit `i18n.config.json` manually:

```bash
npm run init
```

## Project Structure

```
angular-i18n-translator/
├── src/
│   ├── index.js          # CLI entry point and command handlers
│   ├── config.js         # Configuration loading (.env resolution, caching)
│   ├── config-schema.js  # Zod schema for i18n.config.json
│   ├── csv-converter.js  # XLF parsing/generation and XLF <-> CSV conversion
│   ├── csv-records.js    # Versioned CSV parsing and physical record locations
│   ├── message-content.js # Canonical fragments and shared XML/ICU validation
│   ├── paths.js          # Output containment, protected paths and link guards
│   ├── artifacts.js      # Versioned generated-file ownership manifest
│   ├── batch-manager.js  # Split / translate / merge of CSV batches
│   ├── llm-client.js     # HTTP client for OpenAI-compatible LLM APIs
│   ├── validator.js      # CSV validation (interpolations, ICU, IDs, coverage)
│   ├── cleaner.js        # Cleanup of generated artifacts
│   ├── languages.js      # Language code/name mappings
│   ├── errors.js         # Typed errors with suggestions
│   ├── cli/ui.js         # Colors and spinners
│   └── commands/init.js  # Interactive configuration wizard
├── test/                 # Automated tests (node --test)
├── batches/              # Generated: pending and translated batches
├── dist-i18n/            # Generated: translated XLF files
├── .env.example          # Environment variables template
├── i18n.config.json      # Main configuration
├── messages.xlf          # Source XLF file (from Angular)
├── .i18n-artifacts.json   # Generated ownership metadata (no API key)
└── package.json
```

## Configuration

### `i18n.config.json`

```json
{
  "languages": [
    { "code": "en", "name": "English", "file": "messages.en.xlf" },
    { "code": "es", "name": "Spanish", "file": "messages.es.xlf" }
  ],
  "sourceLanguage": "en",
  "sourceFile": "messages.xlf",
  "csvOutput": "messages.csv",
  "outputDir": "dist-i18n",
  "batchDir": "batches",
  "llm": {
    "baseURL": "${LLM_BASE_URL}",
    "apiKey": "${LLM_API_KEY}",
    "model": "${LLM_MODEL}",
    "batchSize": 50,
    "concurrency": 5,
    "timeoutMs": 300000,
    "requestExtra": { "thinking": { "type": "disabled" } }
  }
}
```

Values like `${LLM_API_KEY}` are resolved from the environment (`.env`). If a referenced variable is not set, the tool fails immediately and tells you exactly which variable is missing.

| Field | Type | Description |
|-------|------|-------------|
| `languages` | Array | Supported languages: `code`, `name`, and output `file` |
| `sourceLanguage` | String | Source language code (must be present in `languages`) |
| `sourceFile` | String | Source XLF file extracted from Angular (default `messages.xlf`) |
| `csvOutput` | String | Intermediate CSV file (default `messages.csv`) |
| `outputDir` | String | Directory for translated XLF files (default `dist-i18n`) |
| `batchDir` | String | Directory for translation batches (default `batches`) |
| `llm.baseURL` | String | Base URL of the OpenAI-compatible API |
| `llm.apiKey` | String | API key (prefer `${LLM_API_KEY}`) |
| `llm.model` | String | Model identifier |
| `llm.batchSize` | Number | Records per batch (default 50) |
| `llm.concurrency` | Number | Parallel batches per language (default 5) |
| `llm.timeoutMs` | Number | Request timeout in ms (default 300000) |
| `llm.requestExtra` | Object | Extra fields merged into the API request body (provider-specific) |
| `llm.systemPrompt` | String | Optional custom system prompt. If omitted, a built-in CSV-aware prompt is used that always names the target language |

> **Note on `requestExtra`**: provider-specific options such as DeepSeek's thinking mode are forwarded, but cannot override the configured `model` or generated `messages`. Most other providers need no extra fields.

Language codes must be BCP47-like (for example `en`, `es`, `zh-Hant-TW`), and each language output filename must be a basename ending in `.xlf`, without directory separators. Output/batch directories cannot be the project root, contain traversal, overlap each other or overlap source/CSV paths. At runtime, generated outputs must be strict descendants of the working project root and cannot pass through symlinks/junctions or protected source, configuration, environment, package, code or documentation paths.

## Quick Start

After installation, the whole workflow is two commands:

```bash
npm run init        # first time only: creates i18n.config.json interactively
npm run translate   # does everything: XLF -> CSV -> LLM -> merged CSV -> XLF
```

The full sequence is:

1. **Extract i18n strings from Angular** and copy the file next to this tool:

   ```bash
   ng extract-i18n --output-path src/locale --out-file messages.xlf
   ```

   Only **XLIFF 1.2** is supported (the Angular CLI default); XLIFF 2.0 files are rejected with a clear error.

2. **Run the pipeline:**

   ```bash
   npm run translate
   ```

   One command runs all five steps: XLF to CSV, batch splitting, LLM translation, merge, and CSV to XLF. Languages run sequentially, with each language's batches running in parallel according to `llm.concurrency`. Failed batches do not prevent recovery of complete, valid languages: the pipeline exports those languages and exits **1** if any batch, merge coverage or language export failed. If no valid batches remain, merge fails without fabricating translations.

3. **Review and validate:**

   ```bash
   npm run validate
   ```

4. **Copy the translated files to your Angular project:**

   ```bash
   cp dist-i18n/*.xlf your-angular-project/src/locale/
   ```

You normally never need the individual step commands: they exist for recovery when something fails. See [Manual Steps (Recovery)](#manual-steps-recovery).

### Re-running

`npm run translate` reuses a batch only after checking its IDs, context, content format, message structure, output digest and cache fingerprint. Changes to source/context, seeded target cells, language, model, API base URL, effective system prompt or request options invalidate the cache. Legacy caches without valid metadata, corrupt outputs and structurally invalid translations are re-translated automatically.

Use `npm run translate -- --force` to re-translate even valid caches. Before a replacement request, its cache metadata is invalidated; if that request fails, a subsequent merge cannot resurrect the old result. If the CSV shrinks, only manifest-owned obsolete batch files are removed. API keys are not included in cache identity or ownership metadata.

## Commands

| Command | Description |
|---------|-------------|
| `npm run init` | Interactive configuration wizard (first time only) |
| `npm run translate` | **Full pipeline (recommended)**: XLF to CSV, split, translate, merge, CSV to XLF |
| `npm run validate` | Validate the translated CSV; warnings alone pass |
| `npm run validate -- --file review.csv --strict` | Validate another canonical CSV; warnings also fail |
| `npm run clean -- --dry-run` | Preview owned-file cleanup without deletion |
| `npm run clean` | Remove selected manifest-owned artifacts; preserve foreign files |
| `npm test` | Run the automated test suite |

Global options: `--quiet`, `--verbose`, `--version`, `--help`.

## Manual Steps (Recovery)

The pipeline reports failures with exit code 1 while preserving salvageable results. To inspect or repeat a single step, use these commands in order:

| Command | Step | Description |
|---------|------|-------------|
| `npm run xlf-to-csv` | 1 | Convert the XLF file to CSV |
| `npm run translate:split` | 2 | Split the CSV into batches |
| `npm run translate:run` | 3 | Translate batches with the LLM (`-- --force` to re-translate) |
| `npm run translate:merge` | 4 | Merge translated batches into `messages.translated.csv` |
| `npm run csv-to-xlf` | 5 | Convert the translated CSV to one XLF per language |

A partial merge writes every configured target column, including languages with no successful batches, and leaves missing targets empty. It never fills them from the source. `translate:merge` exits 1 for missing coverage; review and repair those cells before exporting. `csv-to-xlf` validates all requested languages before writing, so an invalid/missing target prevents that command's export.

The full `translate` command validates each language separately and can export complete languages despite other failures. Files already on disk for a skipped language are **old outputs**, not results of the current run; the CLI explicitly flags this. Do not copy all files blindly after a failed run.

Typical recovery flows:

```bash
# The LLM step failed (e.g. rate limit). Fix the cause and resume:
npm run translate:run     # skips batches already translated
npm run translate:merge
npm run csv-to-xlf

# Or simply re-run the pipeline; it resumes where it left off:
npm run translate
```

## Recommended Setup: DeepSeek

The DeepSeek recipe used for this project's audit is `deepseek-v4-flash` with thinking explicitly disabled. Version 2.0 verification uses fixtures and local mock HTTP servers; it does **not** call a live provider, spend tokens or establish a translation-quality/performance benchmark. Confirm model availability and provider-specific options for your account before a real run:

```json
{
  "llm": {
    "baseURL": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "apiKey": "${LLM_API_KEY}",
    "requestExtra": { "thinking": { "type": "disabled" } }
  }
}
```

The `init` wizard applies the thinking-disabled setting when you select DeepSeek. Timing and token consumption vary by provider/model and batch; no fresh live-API measurements are claimed for this release.

## Other LLM Providers

Any provider implementing the OpenAI chat completions format works (`POST {baseURL}/chat/completions` with Bearer auth):

| Provider | baseURL |
|----------|---------|
| DeepSeek | `https://api.deepseek.com` |
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama (local) | `http://localhost:11434/v1` |

> Anthropic's native API is **not** OpenAI-compatible and is not supported directly; use an OpenAI-compatible gateway if needed.

## Manual Editing

The CSV is designed to be edited by hand at any point:

- `messages.csv` is generated from the XLF with every language column pre-filled with the source text. Edit it before translating if you want to fix source strings.
- `messages.translated.csv` contains the merged translations. Edit it freely, then run `npm run csv-to-xlf` to regenerate the XLF files.
- Quoting is standard RFC 4180: fields containing commas, quotes, or newlines are quoted, and embedded quotes are doubled (`""`).

Every row must retain `__content_format=xliff-fragment-v1`. The `source` and language cells are **XML fragments**, not arbitrary raw text:

- Literal ampersands and angle brackets must be XML-escaped: `Fish &amp; chips`, `&lt;x&gt;`.
- Real inline placeholders remain markup: `<x id="INTERPOLATION" equiv-text="{{name}}"/>`.
- CDATA input is canonicalized to escaped text; it does not become inline markup.
- Keep placeholder attributes, multiplicity and nesting intact. Unknown inline elements, DOCTYPE and custom entities are rejected.
- XML entity escaping is distinct from CSV quoting: quotes inside a CSV field still use standard doubled quotes.

Source-identical targets are review **warnings**, not missing translations: product names and loanwords can legitimately stay unchanged. Normal validation/export accepts warnings; `validate --strict` fails on them. An empty target for a non-empty source is an **error**, and there is no source fallback.

## Migrating from 1.x

Version 2.0 is a breaking CSV and runtime change. Unmarked 1.x CSV cannot distinguish literal `<x>` text from real markup, so the tool does not infer or auto-migrate it. Unknown or mixed format markers are also rejected. Do **not** simply add the marker to an old CSV.

1. Preserve the original XLF, existing CSV, batches and exported XLF in a separate backup location before regenerating anything. Safe cleanup does not recognize unregistered 1.x artifacts.
2. Install a supported Node version and dependencies, then configure distinct, safe output paths.
3. Regenerate a canonical CSV from the original XLIFF 1.2 source using `npm run xlf-to-csv`.
4. Reapply reviewed translations by ID into the regenerated target cells, escaping literal text and preserving actual placeholders. Keep originals for comparison; ambiguity needs manual review.
5. Run `npm run validate -- --file messages.csv` (optionally `--strict`) to check the reviewed canonical input. For automatic translation, split/run/merge fresh batches, then validate the default translated CSV before export.

There is no migration command or legacy-inference flag. Old batch CSV/metadata are not valid 2.0 caches.

## Safe Cleanup

```bash
npm run clean -- --dry-run   # inspect the complete plan first
npm run clean               # delete only selected owned artifacts
```

Generated file ownership is recorded in `.i18n-artifacts.json` under the working project root as `{ "version": 1, "files": [...] }`. It stores relative paths only, not configuration or API keys. Cleanup selects registered files below batch `pending`/`translated` and the configured output directory, plus the exact main/translated CSV paths. It removes directories only when they become empty after owned-file deletion; it never recursively removes a directory or deletes foreign contents.

All configured targets and manifest entries are checked before any deletion. Root/ancestor paths, traversal/escapes, protected source/config/environment/package/code/docs paths and symlink/junction ancestors are rejected. A missing manifest preserves existing artifacts and warns that older files require manual review/cleanup. A malformed or malicious manifest fails without deleting any target. Registered-but-missing files are harmless and produce a warning. Untouched empty directories are preserved.

The `clean` command requires valid configuration but does not make an LLM request. Preserve the ownership manifest when moving generated artifacts; do not treat it as authorization to register arbitrary personal files.

## Validation

`npm run validate` checks the translated CSV and reports, per language:

- **Canonical format and CSV headers**: known format marker on every row; no duplicate/empty headers or missing required target columns
- **Interpolations**: exact multiplicity of `{{variable}}` occurrences in text and attributes
- **Inline placeholders**: element names, attributes, multiplicity and ancestor nesting
- **ICU structure**: nested variables/types, `other`, exact numeric/select cases and valid locale-dependent plural categories
- **IDs**: non-empty and unique, with physical CSV line locations (including multiline fields)
- **Coverage**: missing targets are errors; identical targets are warnings and count as populated

Validation defaults to the derived translated CSV, never the source-seeded CSV:

```bash
npm run validate
npm run validate -- --file messages.csv
npm run validate -- --strict
```

Exit status is 1 for errors, or also warnings with `--strict`; otherwise it is 0. Validation is structural, not a guarantee of linguistic correctness. Review identical targets and translation quality before deployment.

## Security

> **NEVER** commit the `.env` file or hardcode API keys in `i18n.config.json` if you version that file.

- `.env` is excluded from Git via `.gitignore`
- Reference variables in config with the `${LLM_API_KEY}` syntax
- Rotate any key that was committed by accident
- Use API keys with the minimum required permissions

## Development

```bash
npm test
```

The test suite (`test/`) runs with `node --test` and covers the XLF/CSV round-trip, batch processing against a mock LLM server, configuration loading, validation rules, and the CLI end-to-end (no network access required).

The core modules are importable ES modules decoupled from the CLI. Generation/cleanup callers must pass the intended project root explicitly and protect the original source/config paths. The synchronous converter APIs use synchronous artifact registration.

The Angular compiler dependency is pinned to `22.1.4`. Its XML/ICU parser is accessed only through the shared message-content boundary; it is an experimental API dependency, not a promise of support for every ICU dialect. It adds approximately 5 MB of installed runtime package footprint and drives the Node engine requirement. Review upgrades with nested-ICU/placeholder regression tests.

Architecture decisions: [canonical XLIFF fragments](<docs/adr/ADR-0001-canonical-xliff-fragments.md>) and [Angular ICU parser](<docs/adr/ADR-0002-use-angular-icu-parser.md>). Release history: [changelog](<docs/CHANGELOG.md>).

## Troubleshooting

### Error: "Unresolved environment variables"

A `${VAR}` placeholder in `i18n.config.json` has no value. Create/complete your `.env` file (see `.env.example`).

### Error: "Configuration validation failed"

The message lists every invalid field with its path (e.g. `sourceLanguage: ...`). Fix the reported fields in `i18n.config.json`.

### Error: "XLIFF 2.0 files are not supported"

Re-extract with the Angular CLI default format: `ng extract-i18n --format xlf`.

### Error: "Invalid XML in XLF content"

The XLF file is malformed. Regenerate it with `ng extract-i18n`; the tool refuses to process broken XML to avoid corrupt output.

### Error: "API error 401"

Invalid or expired API key. Check `.env`.

### Error: "Rate limit o cuota excedida" (429)

Too many concurrent requests. Reduce `llm.concurrency` or `llm.batchSize`. The tool honors `Retry-After` automatically.

### Error: "Request timeout"

Increase `llm.timeoutMs`. Reasoning models on large batches can need several minutes; consider disabling thinking mode (DeepSeek) or reducing `batchSize`.

### Error: "LLM response is missing N record(s)"

The model dropped rows. Invalid CSV/row/message responses are retried within the bounded retry budget; if they remain invalid, the batch fails without corrupting other records. Extra/duplicate IDs, changed source/context and altered placeholders also fail response validation. Re-run `translate:run` (only verified current caches are skipped) or review the model and prompt.

### Translations lose interpolations or placeholders

Run `npm run validate` to get the exact rows, fix them in `messages.translated.csv`, and regenerate with `npm run csv-to-xlf`.

### Batches are not being processed

```bash
npm run translate:run -- --force   # re-translate everything
npm run clean -- --dry-run          # preview owned artifacts before resetting
npm run clean                      # preserve foreign/legacy artifacts; remove owned files
```

> When passing flags through npm, use `--` before the flag: `npm run translate:run -- --force`.

---

## License

MIT License - Free for personal and commercial projects.

# Angular i18n Translator

Node.js CLI tool for managing i18n translation workflows in Angular projects using LLMs (Large Language Models).

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Commands](#commands)
- [Workflow](#workflow)
- [Recommended Setup: DeepSeek](#recommended-setup-deepseek)
- [Other LLM Providers](#other-llm-providers)
- [Manual Editing](#manual-editing)
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
- **Placeholder-safe round-trip**: inline placeholders (`<x id="..."/>`, `<g>`, ...) and ICU formats survive the full pipeline as real markup, never as escaped text
- **Strict input handling**: malformed XML, XLIFF 2.0 files, and empty files fail fast with clear errors instead of producing corrupt output
- **LLM translation** through any OpenAI-compatible API, with retries and exponential backoff
- **Batch processing** with configurable size and concurrency; languages are processed sequentially, batches in parallel
- **Id-based result matching**: translations are matched back to records by `id`, so rows dropped or reordered by the model are reported as failures instead of silently corrupting other records
- **Resume support**: already translated batches are skipped unless `--force` is used
- **Honest reporting**: the exit code reflects real failures, and untranslated rows are listed explicitly
- **Validation** of interpolations `{{var}}`, inline placeholders, ICU structure, duplicate IDs, and translation coverage

## Prerequisites

- **Node.js** >= 18.0.0 (requires native `fetch`)
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

> **Note on `requestExtra`**: it is merged verbatim into the request body. Use it for provider-specific options such as DeepSeek's thinking mode (see below). Most other providers need no extra fields.

## Commands

| Command | Description |
|---------|-------------|
| `npm run init` | Interactive configuration wizard |
| `npm run xlf-to-csv` | Convert the XLF file to CSV |
| `npm run translate:split` | Split the CSV into batches |
| `npm run translate:run` | Translate batches with the LLM (`--force` to re-translate) |
| `npm run translate:merge` | Merge translated batches into `messages.translated.csv` |
| `npm run translate:all` | Full pipeline: all of the above plus `csv-to-xlf` |
| `npm run csv-to-xlf` | Convert the translated CSV to one XLF per language |
| `npm run validate` | Validate the translated CSV |
| `npm run clean` | Remove batches, output directory, and CSV files |
| `npm test` | Run the automated test suite |

Global options: `--quiet`, `--verbose`, `--version`, `--help`.

## Workflow

### Step 1: Extract i18n strings from Angular

```bash
ng extract-i18n --output-path src/locale --out-file messages.xlf
```

Copy the generated `messages.xlf` into this tool's directory. Only **XLIFF 1.2** is supported (the Angular CLI default); XLIFF 2.0 files are rejected with a clear error.

### Step 2: Run the full pipeline

```bash
npm run translate:all
```

This runs: XLF to CSV, batch splitting, LLM translation (languages sequentially, batches in parallel), merge, and CSV to XLF. If some batches fail, the pipeline continues for the successful languages and exits with a non-zero code.

### Step 3: Review and validate

```bash
npm run validate
```

### Step 4: Copy translated files to your Angular project

```bash
cp dist-i18n/*.xlf your-angular-project/src/locale/
```

### Re-running

`translate:run` skips batches that already have a translation, so it is safe to re-run after fixing individual failures. Use `--force` to re-translate everything. If the source CSV shrinks between runs, stale batch files are removed automatically by `translate:split`.

## Recommended Setup: DeepSeek

DeepSeek's V4 models use **thinking mode by default**: for a 50-record batch, reasoning can consume ~20k extra tokens and several minutes per request. Translation does not need it, so disable it:

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

Measured impact on a 49-record batch with `deepseek-v4-flash`:

| Setting | Time | Total tokens |
|---------|------|--------------|
| thinking enabled (default) | ~150 s | ~23,800 |
| thinking disabled | ~10 s | ~4,000 |

The `init` wizard applies this setting automatically when you select DeepSeek.

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

Rows whose translation is identical to the source are flagged by `validate` and by the merge step, so loanwords and genuinely identical translations never hide silently.

## Validation

`npm run validate` checks the translated CSV and reports, per language:

- **Interpolations**: `{{variable}}` present in the source must appear in the translation
- **Inline placeholders**: `<x id="..."/>`, `<g>`, etc. must be preserved
- **ICU formats**: `{var, plural, ...}` structure and brace balance
- **Duplicate IDs**
- **Coverage**: rows that are empty or identical to the source are reported as untranslated

The exit code is non-zero when errors are found, so it can be used in CI.

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

The core modules (`csv-converter.js`, `batch-manager.js`, `llm-client.js`, `config.js`, `validator.js`) are plain importable ES modules decoupled from the CLI, so they can be reused from other frontends.

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

The model dropped rows. The batch is retried automatically; if it keeps failing, the batch fails without corrupting other records. Re-run `translate:run` (translated batches are skipped) or use a more capable model.

### Translations lose interpolations or placeholders

Run `npm run validate` to get the exact rows, fix them in `messages.translated.csv`, and regenerate with `npm run csv-to-xlf`.

### Batches are not being processed

```bash
npm run translate:run -- --force   # re-translate everything
npm run clean                      # or start from scratch
```

> When passing flags through npm, use `--` before the flag: `npm run translate:run -- --force`.

---

## License

MIT License - Free for personal and commercial projects.

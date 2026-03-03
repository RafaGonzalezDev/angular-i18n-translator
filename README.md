# Angular i18n Translator

Node.js CLI tool for managing i18n translation workflow in Angular projects using LLM (Large Language Models).

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Commands](#commands)
- [Workflow](#workflow)
- [Supported LLM Providers](#supported-llm-providers)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## Description

**Angular i18n Translator** is a command-line tool that automates the translation process of XLF (XLIFF) files used in Angular's internationalization system. It uses OpenAI-compatible LLM language models to perform high-quality translations while respecting interpolations, placeholders, and ICU formats.

### Workflow

```
messages.xlf --> messages.csv --> batches/*.csv --> LLM Translation --> batches/translated/*.csv --> messages.translated.csv --> dist-i18n/*.xlf
```

---

## Features

- **XLF to CSV Conversion**: Transforms Angular XLF files to CSV format for easier editing and translation
- **LLM Translation**: Integration with multiple LLM providers (DeepSeek, OpenAI, Azure, Ollama, etc.)
- **Batch Processing**: Splits large translations into configurable batches to optimize API usage
- **Sequential Language Processing**: Languages are processed **sequentially** (one at a time) to avoid file conflicts between translated batches
- **Parallel Batch Processing**: Within each language, batches are processed in parallel according to the `concurrency` parameter
- **Complete Validation**: Verifies interpolations, duplicate IDs, and translation coverage
- **Automatic Retries**: Exponential backoff system to handle network errors and rate limiting
- **Structure Preservation**: Keeps interpolations `{{variable}}`, placeholders `<x id="..."/>` and ICU formats intact

---

## Prerequisites

- **Node.js** >= 18.0.0 (requires native `fetch`)
- **API Key** from a compatible LLM provider (DeepSeek, OpenAI, Azure OpenAI, etc.)
- **Angular CLI** (to extract i18n strings with `ng extract-i18n`)

---

## Installation

### 1. Clone or download the project

```bash
cd angular-i18n-translator
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
# Copy the example file
cp .env.example .env

# Edit .env and add your API key
# LLM_API_KEY=your-api-key-here
```

### 4. Configure languages

Edit `i18n.config.json` as needed (see [Configuration](#configuration) section).

---

## Project Structure

```
angular-i18n-translator/
├── src/
│   ├── index.js          # CLI entry point and command handlers
│   ├── config.js         # Configuration loading and validation
│   ├── xlf-parser.js    # XLF file parser and generator
│   ├── csv-converter.js  # Conversion between XLF and CSV
│   ├── batch-manager.js  # Batch management for translation
│   ├── llm-client.js    # HTTP client for LLM APIs
│   ├── validator.js     # CSV validation (interpolations, IDs, coverage)
│   └── cleaner.js       # Cleanup of generated directories
├── batches/
│   ├── pending/          # Batches pending translation
│   └── translated/      # Already translated batches
├── dist-i18n/           # Translated XLF files (output)
├── .env.example         # Environment variables template
├── .env                 # Environment variables (DO NOT version)
├── .gitignore           # Files excluded from Git
├── i18n.config.json     # Main configuration
├── messages.xlf         # Source XLF file (from Angular)
├── messages.csv         # Intermediate CSV
├── messages.translated.csv # CSV with translations
├── package.json         # npm dependencies and scripts
└── README.md            # This documentation
```

---

## Configuration

### `i18n.config.json` file

```json
{
  "languages": [
    { "code": "en", "name": "English", "file": "messages.en.xlf" },
    { "code": "es", "name": "Spanish", "file": "messages.es.xlf" },
    { "code": "fr", "name": "French", "file": "messages.fr.xlf" }
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
    "systemPrompt": "You are a professional translator..."
  }
}
```

### Field Description

| Field | Type | Description |
|-------|------|-------------|
| `languages` | Array | List of supported languages with code, name, and output file |
| `sourceLanguage` | String | Source language code (must be in `languages`) |
| `sourceFile` | String | Source XLF file name extracted from Angular |
| `csvOutput` | String | Intermediate CSV file name |
| `outputDir` | String | Directory where translated XLF files are saved |
| `batchDir` | String | Directory for storing translation batches |
| `llm.baseURL` | String | Base URL of the LLM provider API (use `${LLM_BASE_URL}` for environment variable) |
| `llm.apiKey` | String | API key (use `${LLM_API_KEY}` for environment variable) |
| `llm.model` | String | Model name to use (use `${LLM_MODEL}` for environment variable) |
| `llm.batchSize` | Number | Records per batch (default: 50) |
| `llm.concurrency` | Number | Simultaneous batches per language (default: 5) |
| `llm.systemPrompt` | String | System prompt for the LLM (optional) |

---

## Commands

### Main Commands

| Command | Description |
|---------|-------------|
| `npm run extract` | Shows the command to extract i18n strings from Angular |
| `npm run xlf-to-csv` | Converts XLF file to CSV format |
| `npm run csv-to-xlf` | Converts translated CSV to XLF files per language |
| `npm run translate:split` | Splits CSV into batches for translation |
| `npm run translate:run` | Executes translation with LLM (languages in sequence, batches in parallel) |
| `npm run translate:merge` | Merges translated batches into a final CSV |
| `npm run translate:all` | Executes the complete translation pipeline |
| `npm run validate` | Validates CSV consistency |
| `npm run clean` | Cleans all generated files |

### Additional Options

```bash
# Force re-translation of already translated batches
npm run translate:run -- --force

# Clean only CSV files
node src/index.js clean --csv-only

# Clean only batch directories
node src/index.js clean --batches-only

# Clean only output directory
node src/index.js clean --output-only

# Clean batches and output, keep CSV
node src/index.js clean --keep-csv
```

---

## Workflow

### Step 1: Extract i18n strings from Angular

```bash
# From your Angular project
ng extract-i18n --output-path src/locale --out-file messages.xlf

# Or for Angular 17+ with esbuild
ng extract-i18n --format xlf2 --output-path src/locale
```

Copy the generated `messages.xlf` file to this tool's directory.

### Step 2: Convert XLF to CSV

```bash
npm run xlf-to-csv
```

This generates `messages.csv` with columns for each target language.

### Step 3: Run complete translation (recommended)

```bash
npm run translate:all
```

This command automatically executes:
1. XLF to CSV
2. Batch splitting
3. LLM translation (languages processed **sequentially**, batches in parallel)
4. Batch merging
5. CSV to XLF

> **Important Note**: Languages are processed sequentially (one after another) to avoid conflicts in translated batch files. Within each language, batches are processed in parallel according to the `concurrency` parameter.

### Alternative: Execute steps individually

```bash
# 1. Split into batches
npm run translate:split

# 2. Run translation
npm run translate:run

# 3. Merge results
npm run translate:merge

# 4. Generate final XLF files
npm run csv-to-xlf
```

### Step 4: Validate translations

```bash
npm run validate
```

### Step 5: Copy translated files

The translated XLF files are in `dist-i18n/`. Copy them to your Angular project:

```bash
cp dist-i18n/*.xlf your-angular-project/src/locale/
```

---

## Supported LLM Providers

The tool is compatible with any API following the OpenAI format:

### DeepSeek (recommended for cost)

```json
{
  "llm": {
    "baseURL": "${LLM_BASE_URL}",
    "model": "${LLM_MODEL}",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### OpenAI

```json
{
  "llm": {
    "baseURL": "${LLM_BASE_URL}",
    "model": "${LLM_MODEL}",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### Azure OpenAI

```json
{
  "llm": {
    "baseURL": "${LLM_BASE_URL}",
    "model": "${LLM_MODEL}",
    "apiKey": "${LLM_API_KEY}"
  }
}
```

### Ollama (local)

```json
{
  "llm": {
    "baseURL": "${LLM_BASE_URL}",
    "model": "${LLM_MODEL}",
    "apiKey": "ollama"
  }
}
```

### Other compatible providers

- **Groq**: `https://api.groq.com/openai/v1`
- **Anthropic** (via compatible proxy)
- **OpenRouter**: `https://openrouter.ai/api/v1`
- Any OpenAI-compatible API

---

## Security

### Important Warnings

> **NEVER** commit the `.env` file or any file containing API keys.
>
> The `.env` file is excluded from Git via `.gitignore`, but you must verify it is never accidentally included.

> **NEVER** hardcode API keys directly in `i18n.config.json` if you plan to version that file.

### Best Practices

1. **Use environment variables**: The `.env` file is excluded from Git via `.gitignore`

2. **Reference variables in config**: Use the `${LLM_API_KEY}` syntax in `i18n.config.json`:
   ```json
   {
     "llm": {
       "apiKey": "${LLM_API_KEY}"
     }
   }
   ```

3. **Verify before commit**: Make sure `.env` is not included:
   ```bash
   git status
   # .env should NOT appear in the list of files to commit
   ```

4. **Rotate compromised keys**: If you accidentally commit a key, rotate it immediately from the provider's dashboard.

5. **Use keys with minimum permissions**: Limit API keys to only the necessary permissions.

6. **Review .gitignore**: Make sure your `.gitignore` includes:
   ```gitignore
   # Environment variables (SECURITY - Never commit these!)
   .env
   .env.local
   .env.*.local
   ```

---

## Troubleshooting

### Error: "Configuration file not found"

**Cause**: `i18n.config.json` does not exist in the root directory.

**Solution**: Create the configuration file:
```bash
# Make sure you are in the correct directory
ls i18n.config.json
```

### Error: "LLM_API_KEY is not set" or "apiKey is empty"

**Cause**: The environment variable is not set or the `.env` file does not exist.

**Solution**:
```bash
# Verify that .env exists and contains the key
cat .env
# Should show: LLM_API_KEY=your-key-here

# If it doesn't exist, create it:
cp .env.example .env
# Then edit .env with your real key
```

### Error: "API error 401"

**Cause**: Invalid or expired API key.

**Solution**: Verify that the API key is correct and has funds/credit.

### Error: "API error 429 - Rate limit"

**Cause**: Too many requests in a short time.

**Solution**:
- Reduce `concurrency` in the configuration
- Increase `batchSize` to make fewer calls
- Wait a few minutes before retrying

### Error: "Request timeout"

**Cause**: The API takes too long to respond.

**Solution**:
- Timeout is set to 60 seconds
- Check your internet connection
- Try with a faster model

### Translations lose interpolations

**Cause**: The LLM does not follow instructions correctly.

**Solution**:
- Verify that the `systemPrompt` includes instructions about interpolations
- Try with a more capable model (check your provider's available models)
- Check the validation report: `npm run validate`

### XLF files are not generated correctly

**Cause**: The translated CSV has incorrect format.

**Solution**:
1. Run validation: `npm run validate`
2. Manually review `messages.translated.csv`
3. Make sure all language columns have content

### Error: "CSV file not found"

**Cause**: Need to run `xlf-to-csv` before other commands.

**Solution**:
```bash
npm run xlf-to-csv
npm run translate:all
```

### Batches are not being processed

**Cause**: No pending batches or they are already translated.

**Solution**:
```bash
# Force re-processing
npm run translate:run -- --force

# Or clean and start over
npm run clean
npm run translate:all
```

### Error: "XLF file not found"

**Cause**: The `messages.xlf` file does not exist in the directory.

**Solution**:
```bash
# Verify the file exists
ls messages.xlf

# If it doesn't exist, extract it from your Angular project
ng extract-i18n --output-path . --out-file messages.xlf
```

### Error: "Invalid JSON" in configuration

**Cause**: The `i18n.config.json` file has JSON syntax errors.

**Solution**:
- Validate the JSON in an online linter
- Make sure all commas and quotes are correct
- Verify there are no comments (JSON does not support comments)

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@xmldom/xmldom` | ^0.8.10 | XML parser for XLF files |
| `csv-parse` | ^5.5.6 | CSV file reading |
| `csv-stringify` | ^6.5.1 | CSV file writing |
| `dotenv` | ^16.6.1 | Environment variable loading |

---

## License

MIT License - Free for personal and commercial projects.

---

## Contributions

Contributions are welcome. Please open an issue or pull request to suggest improvements or report bugs.

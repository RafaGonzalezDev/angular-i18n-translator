# Angular i18n Translator

CLI tool for Angular XLF translation workflows using OpenAI-compatible LLM providers.

## Quick start

```bash
npm install
npm run init
npm run doctor
```

## Core commands

```bash
# Full pipeline
node src/index.js translate run

# Plan-only execution (no writes)
node src/index.js translate run --dry-run

# Run one step
node src/index.js translate step xlf-to-csv
node src/index.js translate step split
node src/index.js translate step run --resume
node src/index.js translate step merge
node src/index.js translate step csv-to-xlf
```

## Setup and diagnostics

```bash
node src/index.js init
node src/index.js doctor
node src/index.js doctor --json
```

`doctor` validates:
- `.env` presence
- `i18n.config.json` presence/parsing
- source XLF path
- LLM credentials completeness

## Other commands

```bash
node src/index.js validate
node src/index.js clean
node src/index.js extract
```

## Global flags

- `--help`, `-h`: Show help
- `--json`: JSON output mode for CI
- `--dry-run`: Plan execution without writing files
- `--resume`: Skip already translated batches
- `--overwrite`: Re-translate existing translated batches

## Exit codes

- `0`: Success
- `2`: Configuration/setup error
- `3`: Input/file error
- `4`: LLM/network error
- `5`: Validation error

## Scripts

```bash
npm run translate
npm run validate
npm run doctor
npm run init
npm test
```

## Project docs

- Overview: `docs/cli-modernization.md`
- ADRs: `docs/adr/`

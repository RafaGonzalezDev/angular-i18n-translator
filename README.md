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
npm run translate

# Plan-only execution (no writes)
npm run cli -- translate run --dry-run

# Run one step
npm run cli -- translate step xlf-to-csv
npm run cli -- translate step split
npm run cli -- translate step run --resume
npm run cli -- translate step merge
npm run cli -- translate step csv-to-xlf
```

## Setup and diagnostics

```bash
npm run init
npm run doctor
npm run doctor -- --json
```

`doctor` validates:
- `.env` presence
- `i18n.config.json` presence/parsing
- source XLF path
- LLM credentials completeness

## Other commands

```bash
npm run validate
npm run clean
npm run extract
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

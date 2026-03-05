# CLI Modernization Overview

## What changed

The CLI was redesigned around a layered architecture:

- CLI Application Layer: command parsing, contextual help, output mode, and stable exit codes.
- Use Case Layer: pipeline orchestration (`translate run`, `translate step`), setup checks (`doctor`), bootstrap (`init`), validation and cleanup.
- Infrastructure Layer: file-system adapters, batch repository, translation provider implementation.
- Domain/Validation Layer: interpolation and coverage validation.

## Where it was changed

- Entry point: `src/index.js`
- Argument parser: `src/cli/arg-parser.js`
- Output contract: `src/services/output-service.js`
- Config contract: `src/services/config-service.js`
- Batch infrastructure: `src/repositories/batch-repository.js`
- Translation provider contract: `src/providers/translation-provider.js`
- Batch orchestration: `src/batch-manager.js`
- XLF/CSV adapter simplification: `src/csv-converter.js`
- Exit codes: `src/constants/exit-codes.js`
- Tests: `test/*.test.js`, `test/fixtures/*`

## Why

- Improve onboarding and reduce failure ambiguity for general developers.
- Support CI-friendly output and deterministic exit codes.
- Enforce separation of concerns and remove duplicated XML conversion logic.
- Add automated safeguards for critical behavior.

## New CLI contract

### Commands

- `npm run translate`
- `npm run cli -- translate run [--dry-run] [--resume] [--overwrite] [--json]`
- `npm run cli -- translate step <xlf-to-csv|split|run|merge|csv-to-xlf> [--dry-run] [--json]`
- `npm run doctor [-- --json]`
- `npm run init`
- `npm run validate [-- --json]`
- `npm run clean [-- --csv-only|--batches-only|--output-only|--keep-csv]`

### Exit codes

- `0`: success
- `2`: configuration/setup error
- `3`: input/file error
- `4`: LLM/network error
- `5`: validation error

### Output modes

- Human mode (default): short action-oriented logs + summary.
- JSON mode (`--json`): event log + summary for CI integrations.

## Maintenance notes

- Legacy `src/config.js` was removed after introducing `ConfigService` in `src/services/config-service.js`.
- Keep command examples npm-first to avoid coupling docs to file entrypoint paths.

# Changelog

All notable changes to this project will be documented in this file.

## [1.3.1] - 2026-08-16

### Changed
- **Simplified flow**: `npm run translate` is now the single recommended command (full pipeline). `translate:all` is kept as an alias; the individual step commands remain available for manual recovery
- README restructured around a Quick Start (init -> translate -> validate -> copy); manual steps documented as recovery-only
- Removed dead `npm run extract` script (the command did not exist)

### Fixed
- `translate:merge` with no translated batches now fails with an actionable message pointing to `translate:run` and likely causes (API key, rate limit), instead of letting later steps crash on a missing `messages.translated.csv`
- `csv-to-xlf`, `xlf-to-csv` and `validate` now check that their input files exist before starting and explain which command generates them, so editors no longer show "Unable to open" for files that were never created

---

## [1.3.0] - 2026-08-15

### Fixed
- **Placeholder corruption (critical)** - Generated XLF files escaped inline placeholders (`<x id="..."/>`, `<g>`, ...) into literal text. Content is now written keeping inline XLIFF markup intact; only free text is escaped, and every unit is checked for well-formedness before writing
- **Cross-record assignment (critical)** - LLM responses are now matched back by record `id` instead of row index; rows dropped or reordered by the model fail the batch instead of silently corrupting other records
- **Silent malformed XML (critical)** - Broken XML now fails fast with a clear error instead of producing garbage CSV with exit 0
- **Silent XLIFF 2.0 / empty files (critical)** - XLIFF 2.0 and unit-less files are rejected with actionable errors
- **Unusable timeout for reasoning models** - Timeout raised to 300 s and configurable via `llm.timeoutMs` (deepseek-v4-flash needs minutes per batch with thinking enabled)
- **Languages now processed sequentially** - Matches the documented behavior; batches within a language still run in parallel, keeping API load bounded
- **`--force` now works** - Already translated batches are skipped by default (real `skipped` accounting); `--force` re-translates them
- **Honest exit codes** - `translate-run` exits non-zero when any batch fails; `translate-all` finishes salvageable work but reports failure
- **Merge reports untranslated records** - Records still identical to source are listed per language instead of disappearing silently
- **Stale batch cleanup** - `translate-split` removes obsolete `batch-N.csv` files from previous bigger runs
- **Zod v4 compatibility** - Configuration errors show readable field paths and messages instead of `TypeError: Cannot read properties of undefined`
- **Unresolved `${VAR}` placeholders** - Missing environment variables are detected and named explicitly
- **Validator coverage** - Now checks inline placeholders and ICU structure in addition to `{{var}}` interpolations; coverage no longer counts source-seeded cells as translated
- **LLM response validation** - Uses a real CSV parser (quoted fields with commas/newlines no longer break validation)
- **Version consistency** - `--version` reads package.json (1.3.0 everywhere); lockfile resynced

### Added
- `llm.timeoutMs` and `llm.requestExtra` config options (DeepSeek recipe: disable thinking mode for ~15x faster and ~6x cheaper translation)
- Source-language-agnostic built-in system prompt; user prompt explicitly names the target language and row-preservation rules
- Automated test suite (`npm test`, node --test): converter round-trips, batch processing against a mock LLM server, config loading, validator rules, CLI end-to-end
- `I18N_CONFIG_PATH` env var to point the CLI at an alternative config file
- `clean` reports removed items; `clean` on an empty project is a no-op

### Removed
- Dead `src/xlf-parser.js` module (duplicated, unused) and unused `cleanBatches`
- `clean` flags (`--csv-only`, `--batches-only`, `--output-only`, `--keep-csv`): single full clean
- Bundled custom default system prompt from the init wizard (the built-in CSV-aware prompt is used instead)

### Changed
- Simpler result reporting in split/merge/run handlers
- `csv-to-xlf` honors `languages[].file` output names
- README rewritten to match actual behavior, with DeepSeek setup guide and manual-editing section

---

## [1.2.0] - 2026-03-05

### Added
- **Individual language spinners** - Replaced cli-progress MultiBar with ora spinners per language in parallel translation
- **Information accumulation system** - batch-manager.js accumulates operations internally and reports summary at the end when verbose mode is active
- **Grouped verbose output** - Logs organized by category instead of per-operation (e.g., "Created 5 directories: fi, fr, de, ko, es")
- **Sobria color palette** - Professional and understated colors for verbose mode

### Changed
- **Reduced verbosity in normal mode** - Removed all [Batch] prefixed logs, replaced with minimal spinners
- **Simplified verbose mode** - Grouped logs by category with summarized reporting
- **Improved parallel translation UX** - Clear per-language status messages with individual spinners

### Fixed
- **Promise.allSettled results handling** - Fixed bug in processing settled promise results
- **Spinner initialization race condition** - Fixed race condition during parallel spinner setup
- **Spinner visual corruption in parallel translation** - Replaced multiple concurrent spinners with single global spinner
  - Eliminated visual artifacts caused by cursor manipulation conflicts
  - Simplified UI to show one spinner for all languages: "Translating N languages..."
  - Status now tracked internally and shown in final report only

### Removed
- **cli-progress dependency** - Removed cli-progress MultiBar in favor of individual ora spinners
- **Verbose [Batch] logs** - Eliminated per-operation batch logging in normal mode

---

## [1.1.0] - 2026-03-05

### Added
- **Interactive init command** - Guided setup wizard for configuration (`node src/index.js init`)
- **Modern CLI framework** - Commander.js with auto-generated help
- **Visual feedback** - Spinners and progress bars for long operations
- **Color-coded output** - Semantic colors for errors, warnings, success
- **Global options** - `--quiet` and `--verbose` flags for output control
- **Enhanced validation** - Line numbers, severity levels, and suggestions
- **Structured errors** - HTTP error classification with retry logic
- **Jitter in retries** - Prevents thundering herd on rate limits

### Changed
- Refactored CLI with Commander.js for better argument parsing
- Improved error messages with actionable suggestions
- Enhanced validator output with severity and context

### Dependencies
- Added: `commander` ^14.0.0 - CLI argument parsing
- Added: `chalk` ^5.6.0 - Terminal colors and styling
- Added: `ora` ^9.0.0 - Spinners for long operations
- Added: `cli-progress` ^3.12.0 - Progress bars
- Added: `inquirer` ^13.0.0 - Interactive prompts
- Added: `zod` ^4.0.0 - Schema validation

---

## [1.0.0] - Initial Release

### Added
- XLF to CSV conversion
- CSV to XLF conversion
- LLM-based translation with batch processing
- Support for multiple LLM providers (DeepSeek, OpenAI, Azure, Ollama)
- Validation of interpolations, duplicate IDs, and coverage
- Automatic retries with exponential backoff
- Structure preservation (interpolations, placeholders, ICU formats)

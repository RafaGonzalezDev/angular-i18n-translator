# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-10-04

### Breaking changes
- Require Node.js `^24.15.0 || >=26.0.0`; older runtimes and Node 25 are unsupported.
- Require `__content_format=xliff-fragment-v1` on every persisted CSV row. Source/target cells are canonical XML fragments: literal text is entity-escaped, real inline XLIFF placeholders remain markup, and CDATA becomes escaped text. Unmarked, unknown or mixed formats are rejected without inference. Preserve 1.x originals, regenerate from the original XLF and manually reapply reviewed translations; adding a marker to old ambiguous content is not migration.
- Reject missing target columns/cells for non-empty source messages; merge tracks every configured target language and leaves missing targets empty instead of falling back to source. Identical targets are review warnings, accepted by default but rejected by strict validation.
- Cleanup no longer recursively removes configured directories or unregistered legacy artifacts. Only selected manifest-owned files may be deleted; foreign contents and untouched empty directories survive.

### Added
- Shared canonical XML/message validation for conversion, LLM response acceptance, cache verification and CSV validation; structural checks cover placeholder multiplicity/attributes/nesting, interpolation multiplicity and nested ICU variables/types/selectors.
- Pinned `@angular/compiler` `22.1.4` for ICU parsing behind the message-content boundary, with an experimental API dependency and approximately 5 MB installed runtime footprint. See [ADR-0001](<adr/ADR-0001-canonical-xliff-fragments.md>) and [ADR-0002](<adr/ADR-0002-use-angular-icu-parser.md>).
- `validate --file <path>` to inspect another canonical CSV and `validate --strict` to fail on warnings; default validation uses the derived translated CSV.
- `clean --dry-run`, versioned project-root `.i18n-artifacts.json`, synchronous ownership registration and atomic manifest updates. Path-only metadata excludes API keys; preflight checks all paths before deletion and rejects root/ancestors, escapes/traversal, protected paths and symlinks/junctions.
- Versioned batch cache identity, current-input/request fingerprint, output digest and structural verification before reuse; changes to source/context/target cells, language or effective request settings invalidate caches.

### Fixed
- Strict CSV parsing detects duplicate/empty headers and preserves physical record locations, including multiline fields; IDs must be non-empty/unique and LLM responses must contain exactly the original ID set and unchanged source/context.
- Malformed XML, invalid characters/entities, unsupported inline elements and DOCTYPE/custom entities fail closed; literal placeholder-looking text no longer becomes markup.
- Partial pipeline recovery exports complete valid languages while reporting failure with exit 1. Skipped languages' existing XLF files are explicitly flagged as old outputs; merge never hides entirely absent languages.
- Forced or stale-cache retranslation invalidates metadata before requesting replacement; a failed retry cannot resurrect an old result in merge.
- Request timeout spans response body consumption; bounded retries distinguish retryable HTTP/network/validation failures, honor `Retry-After` and protect configured `model`/generated `messages` from provider extras.

### Documentation and verification
- Updated migration, validation, safe-cleanup, recovery and cache guidance in the [README](<../README.md>); retained previous release history below.
- The DeepSeek recipe remains `deepseek-v4-flash` with thinking disabled. This release's audit/tests use local mocks, not live APIs or fresh provider benchmarks; no keys or token spending are required for the test suite.

---

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

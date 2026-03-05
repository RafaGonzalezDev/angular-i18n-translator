# Changelog

All notable changes to this project will be documented in this file.

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

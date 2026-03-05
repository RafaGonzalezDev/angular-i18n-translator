# Changelog

All notable changes to this project will be documented in this file.

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

/**
 * Centralized UI module for CLI interactions
 * 
 * Provides consistent styling, spinners, and progress bars across all commands.
 * Uses chalk for colors, ora for spinners, and cli-progress for progress bars.
 */

import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';

// ============================================================================
// SEMANTIC COLORS
// ============================================================================

/**
 * Color definitions for consistent semantic styling
 */
export const colors = {
  /** Error messages - red, bold */
  error: chalk.red.bold,
  
  /** Success messages - green */
  success: chalk.green,
  
  /** Warning messages - yellow */
  warning: chalk.yellow,
  
  /** Informational messages - blue */
  info: chalk.blue,
  
  /** Highlighted text - cyan, bold */
  highlight: chalk.cyan.bold,
  
  /** Dimmed/subtle text - gray */
  dim: chalk.gray,
  
  /** Primary branding - magenta */
  brand: chalk.magenta,
  
  /** File paths - cyan */
  path: chalk.cyan,
  
  /** Numbers/statistics - yellow */
  number: chalk.yellow,
  
  /** Bold text without color change */
  bold: chalk.bold,
};

// ============================================================================
// SPINNER HELPERS
// ============================================================================

/**
 * Creates a new ora spinner with consistent styling
 * 
 * @param {string} text - The spinner text to display
 * @param {object} options - Additional ora options
 * @returns {import('ora').Ora} - Configured spinner instance
 * 
 * @example
 * const spinner = createSpinner('Translating...');
 * spinner.start();
 * // ... do work
 * spinner.succeed('Translation complete!');
 */
export function createSpinner(text, options = {}) {
  return ora({
    text,
    spinner: 'dots',
    color: 'cyan',
    ...options,
  });
}

/**
 * Creates a spinner specifically for loading operations
 * 
 * @param {string} resourceName - Name of what's being loaded
 * @returns {import('ora').Ora} - Configured spinner instance
 */
export function createLoadingSpinner(resourceName) {
  return createSpinner(`Loading ${resourceName}...`, {
    spinner: 'bounce',
    color: 'blue',
  });
}

// ============================================================================
// PROGRESS BAR HELPERS
// ============================================================================

/**
 * Format for multi-batch progress bars
 * Shows: bar, percentage, batches completed, ETA
 */
const BATCH_PROGRESS_FORMAT = 
  `[{bar}] {percentage}% | {value}/{total} batches | ETA: {eta_formatted}`;

/**
 * Format for single progress bars
 * Shows: bar, percentage, items completed, ETA
 */
const SINGLE_PROGRESS_FORMAT = 
  `[{bar}] {percentage}% | {value}/{total} items | ETA: {eta_formatted}`;

/**
 * Progress bar color scheme
 * Uses different colors based on completion percentage
 */
const PROGRESS_BAR_COLORS = {
  complete: 'green',
  incomplete: 'gray',
};

/**
 * Creates a multi-bar container for tracking multiple concurrent operations
 * 
 * @returns {cliProgress.MultiBar} - Multi-bar instance
 * 
 * @example
 * const multiBar = createMultiBar();
 * const bar1 = multiBar.create(100, 0, { task: 'Task 1' });
 * const bar2 = multiBar.create(50, 0, { task: 'Task 2' });
 * // ... update bars
 * multiBar.stop();
 */
export function createMultiBar() {
  return new cliProgress.MultiBar({
    format: BATCH_PROGRESS_FORMAT,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    clearOnComplete: false,
    stopOnComplete: true,
    barsize: 30,
    etaBuffer: 10,
  }, cliProgress.Presets.shades_classic);
}

/**
 * Creates a single progress bar for tracking one operation
 * 
 * @param {number} total - Total number of items to process
 * @param {object} options - Additional options
 * @returns {cliProgress.SingleBar} - Single bar instance
 * 
 * @example
 * const bar = createSingleBar(100);
 * bar.start(100, 0);
 * // ... update progress
 * bar.update(50);
 * bar.stop();
 */
export function createSingleBar(total, options = {}) {
  const bar = new cliProgress.SingleBar({
    format: SINGLE_PROGRESS_FORMAT,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    clearOnComplete: false,
    stopOnComplete: true,
    barsize: 40,
    etaBuffer: 10,
    ...options,
  }, cliProgress.Presets.shades_classic);
  
  return bar;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Formats a duration in seconds to a human-readable string
 * 
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration (e.g., "2m 30s" or "45s")
 */
export function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats a number with locale-specific thousands separators
 * 
 * @param {number} num - Number to format
 * @returns {string} - Formatted number
 */
export function formatNumber(num) {
  return num.toLocaleString();
}

/**
 * Prints a section header with consistent styling
 * 
 * @param {string} title - Section title
 */
export function printHeader(title) {
  console.log();
  console.log(colors.highlight(`━━━ ${title} ━━━`));
  console.log();
}

/**
 * Prints a summary line with label and value
 * 
 * @param {string} label - Label text
 * @param {string|number} value - Value to display
 * @param {string} [valueColor='number'] - Color key for the value
 */
export function printSummaryLine(label, value, valueColor = 'number') {
  const colorFn = colors[valueColor] || colors.number;
  console.log(`${colors.dim(label)}: ${colorFn(value)}`);
}

/**
 * Clears the current line and writes new content
 * Useful for updating status without creating new lines
 * 
 * @param {string} text - Text to write
 */
export function updateLine(text) {
  process.stdout.write(`\r${text}`);
}

/**
 * Clears the current line
 */
export function clearLine() {
  process.stdout.write('\r\x1b[K');
}

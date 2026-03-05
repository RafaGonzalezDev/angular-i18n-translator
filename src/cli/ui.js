/**
 * Centralized UI module for CLI interactions
 * 
 * Provides consistent styling and spinners across all commands.
 * Uses chalk for colors and ora for spinners.
 */

import chalk from 'chalk';
import ora from 'ora';

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

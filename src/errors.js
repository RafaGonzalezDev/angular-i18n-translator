/**
 * Custom error classes for the i18n translator CLI
 * 
 * Provides typed errors with user-friendly messages and actionable suggestions.
 */

import { colors } from './cli/ui.js';

// ============================================================================
// BASE ERROR CLASS
// ============================================================================

/**
 * Base class for all i18n-translator errors
 */
export class I18nTranslatorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'I18nTranslatorError';
  }
}

// ============================================================================
// CONFIG ERROR
// ============================================================================

/**
 * Error thrown when configuration is invalid or missing
 * 
 * Used for:
 * - Missing configuration file
 * - Invalid JSON in configuration
 * - Missing required fields
 * - Invalid field values
 */
export class ConfigError extends I18nTranslatorError {
  /**
   * @param {string} message - User-friendly error message
   * @param {string} [suggestion] - Optional suggestion for fixing the error
   */
  constructor(message, suggestion = null) {
    super(message);
    this.name = 'ConfigError';
    this.suggestion = suggestion;
  }
}

// ============================================================================
// API ERROR
// ============================================================================

/**
 * Error thrown when LLM API requests fail
 * 
 * Includes metadata for retry logic and user guidance.
 */
export class APIError extends I18nTranslatorError {
  /**
   * @param {string} message - User-friendly error message
   * @param {object} options - Additional error options
   * @param {number} [options.statusCode] - HTTP status code (if applicable)
   * @param {boolean} [options.retryable] - Whether the operation can be retried
   * @param {string} [options.suggestion] - Suggestion for fixing the error
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'APIError';
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.suggestion = options.suggestion ?? null;
  }
  
  /**
   * Creates an APIError from an HTTP response
   * 
   * @param {number} statusCode - HTTP status code
   * @param {string} [body] - Response body text
   * @returns {APIError}
   */
  static fromResponse(statusCode, body = '') {
    const retryable = [408, 429, 500, 502, 503, 504].includes(statusCode);
    
    let message;
    let suggestion;
    
    switch (statusCode) {
      case 401:
        message = 'Authentication failed - invalid API key';
        suggestion = 'Check that your API key is correct and has not expired';
        break;
      case 403:
        message = 'Access forbidden - insufficient permissions';
        suggestion = 'Verify your API key has the required permissions';
        break;
      case 404:
        message = 'Resource not found - check the API endpoint';
        suggestion = 'Verify the baseURL and model name are correct';
        break;
      case 429:
        message = 'Rate limit exceeded';
        suggestion = 'Wait a moment and try again, or reduce concurrency';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        message = 'Server error - the API is temporarily unavailable';
        suggestion = 'Wait a moment and try again';
        break;
      default:
        message = `API request failed with status ${statusCode}`;
        suggestion = body ? `Response: ${body.substring(0, 200)}` : 'Check your network connection';
    }
    
    return new APIError(message, { statusCode, retryable, suggestion });
  }
}

// ============================================================================
// VALIDATION ERROR
// ============================================================================

/**
 * Error thrown when input validation fails
 * 
 * Wraps Zod validation errors with user-friendly formatting.
 */
export class ValidationError extends I18nTranslatorError {
  /**
   * @param {string} message - User-friendly error message
   * @param {Array<{path: string, message: string}>} [issues] - List of validation issues
   */
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
  
  /**
   * Creates a ValidationError from a Zod error
   * 
   * @param {import('zod').ZodError} zodError - The Zod validation error
   * @returns {ValidationError}
   */
  static fromZodError(zodError) {
    const issues = zodError.errors.map(err => ({
      path: err.path.join('.'),
      message: err.message,
    }));
    
    const message = `Validation failed:\n${issues.map(i => `  • ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`;
    
    return new ValidationError(message, issues);
  }
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

/**
 * Formats an error for display to the user
 * 
 * @param {Error} error - The error to format
 * @returns {string} - Formatted error message with colors
 */
export function formatError(error) {
  let output = '';
  
  // Error header
  const errorType = error.name || 'Error';
  output += colors.error(`✖ ${errorType}`) + '\n';
  output += colors.error('  └─ ') + colors.error(error.message) + '\n';
  
  // Add suggestion if available
  if (error.suggestion) {
    output += '\n' + colors.info('💡 Suggestion: ') + colors.dim(error.suggestion) + '\n';
  }
  
  // Add validation issues if available
  if (error.issues && error.issues.length > 0) {
    output += '\n' + colors.warning('Issues found:') + '\n';
    for (const issue of error.issues) {
      const path = issue.path ? colors.path(issue.path) + ': ' : '';
      output += `  • ${path}${colors.dim(issue.message)}\n`;
    }
  }
  
  // Add retry information for API errors
  if (error instanceof APIError && error.retryable) {
    output += '\n' + colors.warning('⟳ This error is retryable. You can try again.') + '\n';
  }
  
  return output;
}

/**
 * Prints a formatted error to the console
 * 
 * @param {Error} error - The error to print
 * @param {boolean} [exit=false] - Whether to exit the process after printing
 */
export function printError(error, exit = false) {
  console.error();
  console.error(formatError(error));
  console.error();
  
  if (exit) {
    process.exit(1);
  }
}

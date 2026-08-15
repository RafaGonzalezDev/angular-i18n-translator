/**
 * Configuration schema validation using Zod
 *
 * Defines the structure and validation rules for i18n.config.json files.
 */

import { z } from 'zod';

// ============================================================================
// LANGUAGE SCHEMA
// ============================================================================

/**
 * Schema for a single language configuration
 */
export const LanguageSchema = z.object({
  /** ISO language code (e.g., 'en', 'es', 'fr') */
  code: z.string()
    .min(2, 'Language code must be at least 2 characters')
    .max(10, 'Language code must be at most 10 characters'),

  /** Human-readable language name (e.g., 'English', 'Spanish') */
  name: z.string()
    .min(1, 'Language name is required'),

  /** Output file name for this language (e.g., 'messages.es.xlf') */
  file: z.string()
    .min(1, 'Language file name is required'),
});

// ============================================================================
// LLM CONFIGURATION SCHEMA
// ============================================================================

/**
 * Schema for LLM provider configuration
 */
export const LLMConfigSchema = z.object({
  /** Base URL for the LLM API (e.g., 'https://api.deepseek.com') */
  baseURL: z.string()
    .url('llm.baseURL must be a valid URL'),

  /** API key for authentication */
  apiKey: z.string()
    .min(1, 'llm.apiKey is required'),

  /** Model identifier to use for translations */
  model: z.string()
    .min(1, 'llm.model is required'),

  /** Number of translation units per API batch */
  batchSize: z.number()
    .int('batchSize must be an integer')
    .positive('batchSize must be positive')
    .default(50),

  /** Number of concurrent API requests per language */
  concurrency: z.number()
    .int('concurrency must be an integer')
    .positive('concurrency must be positive')
    .default(5),

  /** Request timeout in milliseconds (default: 300000) */
  timeoutMs: z.number()
    .int('timeoutMs must be an integer')
    .positive('timeoutMs must be positive')
    .optional(),

  /**
   * Extra provider-specific fields merged into the request body.
   * Example for DeepSeek: { "thinking": { "type": "disabled" } }
   */
  requestExtra: z.record(z.string(), z.unknown()).optional(),

  /** Custom system prompt for the LLM (optional) */
  systemPrompt: z.string()
    .optional(),
});

// ============================================================================
// MAIN CONFIGURATION SCHEMA
// ============================================================================

/**
 * Main schema for i18n.config.json
 */
export const I18nConfigSchema = z.object({
  /** Array of supported languages - must include the source language */
  languages: z.array(LanguageSchema)
    .min(1, 'At least one language must be configured'),

  /** ISO code of the source language for translations */
  sourceLanguage: z.string()
    .min(1, 'Source language code is required'),

  /** Path to the source XLF file extracted by Angular */
  sourceFile: z.string()
    .default('messages.xlf'),

  /** Path for the generated CSV file */
  csvOutput: z.string()
    .default('messages.csv'),

  /** Directory for generated translation files */
  outputDir: z.string()
    .default('dist-i18n'),

  /** Directory for storing batch files during translation */
  batchDir: z.string()
    .default('batches'),

  /** LLM provider configuration */
  llm: LLMConfigSchema,
})
.superRefine((config, ctx) => {
  // Language codes must be unique
  const seenCodes = new Set();
  config.languages.forEach((lang, index) => {
    if (seenCodes.has(lang.code)) {
      ctx.addIssue({
        code: "custom",
        path: ['languages', index, 'code'],
        message: `Duplicate language code "${lang.code}"`,
      });
    }
    seenCodes.add(lang.code);
  });

  // Output file names must be unique
  const seenFiles = new Set();
  config.languages.forEach((lang, index) => {
    if (seenFiles.has(lang.file)) {
      ctx.addIssue({
        code: "custom",
        path: ['languages', index, 'file'],
        message: `Duplicate language file name "${lang.file}"`,
      });
    }
    seenFiles.add(lang.file);
  });
});

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Normalizes Zod issues into plain { path, message } objects.
 */
function normalizeIssues(zodError) {
  return zodError.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Full validation including custom rules.
 *
 * @param {unknown} data - Raw configuration data to validate
 * @returns {Object} Validated configuration
 * @throws {Error} With a readable message if validation fails
 */
export function validateConfig(data) {
  const result = safeValidateConfig(data);
  if (!result.success) {
    const lines = result.issues.map(
      issue => `  - ${issue.path ? `${issue.path}: ` : ''}${issue.message}`
    );
    throw new Error(`Configuration validation failed:\n${lines.join('\n')}`);
  }
  return result.data;
}

/**
 * Safe validation that returns a result object instead of throwing.
 *
 * @param {unknown} data - Raw configuration data to validate
 * @returns {{success: boolean, data?: Object, issues?: Array<{path: string, message: string}>}}
 */
export function safeValidateConfig(data) {
  const result = I18nConfigSchema.safeParse(data);

  if (!result.success) {
    return { success: false, issues: normalizeIssues(result.error) };
  }

  // Source language must be one of the configured languages
  const codes = result.data.languages.map(lang => lang.code);
  if (!codes.includes(result.data.sourceLanguage)) {
    return {
      success: false,
      issues: [{
        path: 'sourceLanguage',
        message: `Source language "${result.data.sourceLanguage}" must be one of the configured language codes: ${codes.join(', ')}`,
      }],
    };
  }

  return { success: true, data: result.data };
}

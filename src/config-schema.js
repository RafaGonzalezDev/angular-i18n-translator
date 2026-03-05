/**
 * Configuration schema validation using Zod
 * 
 * Defines the structure and validation rules for i18n.config.json files.
 * Provides type inference for use throughout the application.
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
  /** Base URL for the LLM API (e.g., 'https://api.openai.com/v1') */
  baseURL: z.string()
    .url('LLM baseURL must be a valid URL'),
  
  /** API key for authentication */
  apiKey: z.string()
    .min(1, 'LLM API key is required'),
  
  /** Model identifier to use for translations */
  model: z.string()
    .min(1, 'LLM model name is required'),
  
  /** Number of translation units per API batch */
  batchSize: z.number()
    .int('Batch size must be an integer')
    .positive('Batch size must be positive')
    .default(50),
  
  /** Number of concurrent API requests */
  concurrency: z.number()
    .int('Concurrency must be an integer')
    .positive('Concurrency must be positive')
    .default(5),
  
  /** Custom system prompt for the LLM (optional) */
  systemPrompt: z.string()
    .optional(),
});

// ============================================================================
// MAIN CONFIGURATION SCHEMA
// ============================================================================

/**
 * Main schema for i18n.config.json
 * 
 * @example
 * // Valid configuration structure:
 * {
 *   "languages": [
 *     { "code": "en", "name": "English", "file": "messages.en.xlf" },
 *     { "code": "es", "name": "Spanish", "file": "messages.es.xlf" }
 *   ],
 *   "sourceLanguage": "en",
 *   "sourceFile": "messages.xlf",
 *   "csvOutput": "messages.csv",
 *   "outputDir": "dist-i18n",
 *   "batchDir": "batches",
 *   "llm": {
 *     "baseURL": "https://api.openai.com/v1",
 *     "apiKey": "sk-...",
 *     "model": "gpt-4",
 *     "batchSize": 50,
 *     "concurrency": 5
 *   }
 * }
 */
export const I18nConfigSchema = z.object({
  /** Array of supported languages - must include at least the source language */
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
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

/**
 * Inferred TypeScript type for a single language configuration
 * @typedef {z.infer<typeof LanguageSchema>} Language
 */
export const Language = LanguageSchema;

/**
 * Inferred TypeScript type for LLM configuration
 * @typedef {z.infer<typeof LLMConfigSchema>} LLMConfig
 */
export const LLMConfig = LLMConfigSchema;

/**
 * Inferred TypeScript type for the full i18n configuration
 * @typedef {z.infer<typeof I18nConfigSchema>} I18nConfig
 */
export const I18nConfig = I18nConfigSchema;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validates that the source language exists in the languages array
 * 
 * @param {I18nConfig} config - The configuration to validate
 * @throws {z.ZodError} - If source language is not in languages array
 */
export function validateSourceLanguage(config) {
  const languageCodes = config.languages.map(lang => lang.code);
  if (!languageCodes.includes(config.sourceLanguage)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['sourceLanguage'],
        message: `Source language "${config.sourceLanguage}" must be one of the configured language codes: ${languageCodes.join(', ')}`,
      },
    ]);
  }
  return config;
}

/**
 * Full validation including custom rules
 * 
 * @param {unknown} data - Raw configuration data to validate
 * @returns {I18nConfig} - Validated configuration
 * @throws {z.ZodError} - If validation fails
 */
export function validateConfig(data) {
  const config = I18nConfigSchema.parse(data);
  validateSourceLanguage(config);
  return config;
}

/**
 * Safe validation that returns a result object instead of throwing
 * 
 * @param {unknown} data - Raw configuration data to validate
 * @returns {{ success: boolean, data?: I18nConfig, error?: z.ZodError }}
 */
export function safeValidateConfig(data) {
  const result = I18nConfigSchema.safeParse(data);
  
  if (!result.success) {
    return { success: false, error: result.error };
  }
  
  // Check source language exists in languages array
  try {
    validateSourceLanguage(result.data);
    return { success: true, data: result.data };
  } catch (error) {
    return { success: false, error };
  }
}

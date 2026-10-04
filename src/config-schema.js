/**
 * Configuration schema validation using Zod
 *
 * Defines the structure and validation rules for i18n.config.json files.
 */

import { z } from 'zod';
import { posix } from 'node:path';
import { getTranslatedCsvPath } from './paths.js';

const LANGUAGE_CODE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const normalizePath = value => posix.normalize(value.replace(/\\/g, '/')).toLowerCase();
const inside = (dir, file) => file === dir || file.startsWith(`${dir}/`);
const safeDirectory = value => {
  const normalized = normalizePath(value);
  return value.trim().length > 0 && !/[\x00-\x1f]/.test(value)
    && !value.split(/[\\/]/).includes('..')
    && !['.', '/', ''].includes(normalized) && !/^[a-z]:\/?$/i.test(normalized)
    && !normalized.split('/').some(part => ['.git', 'node_modules', 'src', 'test', 'tests', 'docs', 'source', 'config'].includes(part));
};

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
    .max(63, 'Language code must be at most 63 characters')
    .regex(LANGUAGE_CODE_RE, 'Language code must be a BCP47-like code without path separators')
    .refine(code => !['id', 'source', 'note', 'meaning'].includes(code.toLowerCase()), 'Language code conflicts with a reserved CSV column'),

  /** Human-readable language name (e.g., 'English', 'Spanish') */
  name: z.string()
    .min(1, 'Language name is required'),

  /** Output file name for this language (e.g., 'messages.es.xlf') */
  file: z.string()
    .min(1, 'Language file name is required')
    .regex(/^[^\\/:\x00-\x1f]+\.xlf$/i, 'Language file must be a basename with an .xlf extension')
    .refine(file => !file.includes('..') && !/[. ]$/.test(file), 'Language file must not contain traversal'),
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
    .max(2147483647, 'timeoutMs exceeds the Node timer limit')
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
    .min(1, 'Source language code is required')
    .regex(LANGUAGE_CODE_RE, 'Source language must be a BCP47-like code'),

  /** Path to the source XLF file extracted by Angular */
  sourceFile: z.string()
    .default('messages.xlf'),

  /** Path for the generated CSV file */
  csvOutput: z.string()
    .default('messages.csv'),

  /** Directory for generated translation files */
  outputDir: z.string()
    .refine(safeDirectory, 'outputDir must be a non-root, non-protected directory without traversal')
    .default('dist-i18n'),

  /** Directory for storing batch files during translation */
  batchDir: z.string()
    .refine(safeDirectory, 'batchDir must be a non-root, non-protected directory without traversal')
    .default('batches'),

  /** LLM provider configuration */
  llm: LLMConfigSchema,
})
.superRefine((config, ctx) => {
  const issue = (field, message) => ctx.addIssue({ code: 'custom', path: [field], message });
  const source = normalizePath(config.sourceFile);
  const csv = normalizePath(config.csvOutput);
  const translated = config.csvOutput ? normalizePath(getTranslatedCsvPath(config.csvOutput)) : '';
  const output = normalizePath(config.outputDir);
  const batch = normalizePath(config.batchDir);
  if (source === csv || source === translated) issue('csvOutput', 'CSV output must not overwrite the source file');
  if (inside(output, batch) || inside(batch, output)) issue('batchDir', 'Batch and output directories must not overlap');
  for (const [field, dir] of [['outputDir', output], ['batchDir', batch]]) {
    if ([source, csv, translated].some(file => inside(dir, file) || inside(file, dir))) {
      issue(field, 'Generated directories must not overlap source or CSV paths');
    }
  }
  for (const [field, value] of [['sourceFile', config.sourceFile], ['csvOutput', config.csvOutput]]) {
    if (!value.trim() || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).includes('..')) {
      issue(field, 'File path must not be empty or contain traversal');
    }
  }
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
    if (seenFiles.has(lang.file.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        path: ['languages', index, 'file'],
        message: `Duplicate language file name "${lang.file}"`,
      });
    }
    seenFiles.add(lang.file.toLowerCase());
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

import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeValidateConfig } from './config-schema.js';
import { ConfigError, ValidationError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// Configuration file path (project root)
const configPath = resolve(__dirname, '..', 'i18n.config.json');

// Internal state for lazy loading
let config = null;
let configLoadAttempted = false;
let configLoadError = null;

/**
 * Recursively replaces environment variable placeholders in a value
 * @param {any} value - The value to process (string, object, array, or primitive)
 * @returns {any} - The processed value with env vars replaced
 */
export function replaceEnvVariables(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (match, envVarName) => {
      if (process.env[envVarName] === undefined) {
        // Return original placeholder if env var is not set
        return match;
      }
      return process.env[envVarName];
    });
  }
  
  if (Array.isArray(value)) {
    return value.map(item => replaceEnvVariables(item));
  }
  
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = replaceEnvVariables(val);
    }
    return result;
  }
  
  return value;
}

/**
 * Validates the configuration object using Zod schema
 * Reuses safeValidateConfig from config-schema.js to avoid duplication
 * @param {Object} rawConfig - The configuration object to validate
 * @throws {ValidationError} - Throws descriptive error if validation fails
 * @returns {Object} - The validated configuration with defaults applied
 */
function validateConfig(rawConfig) {
  const result = safeValidateConfig(rawConfig);
  
  if (!result.success) {
    // Convert Zod errors to user-friendly format
    const issues = result.error.errors.map(err => ({
      path: err.path.join('.'),
      message: err.message,
    }));
    
    throw new ValidationError(
      `Configuration validation failed:\n${issues.map(i => `  • ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`,
      issues
    );
  }
  
  return result.data;
}

/**
 * Loads and validates the configuration file
 * @throws {ConfigError|ValidationError} - Throws if config file is missing, invalid, or validation fails
 */
function doLoadConfig() {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Configuration file not found: ${configPath}`,
      'Create an i18n.config.json file in the project root directory with your translation settings.'
    );
  }

  let fileContent;
  try {
    fileContent = readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigError(
      `Failed to read configuration file: ${error.message}`,
      'Check file permissions and ensure the path is correct.'
    );
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(fileContent);
  } catch (error) {
    throw new ConfigError(
      `Failed to parse i18n.config.json: ${error.message}`,
      'Ensure the configuration file contains valid JSON. Use a JSON validator to check for syntax errors.'
    );
  }

  // Replace environment variable placeholders
  const processedConfig = replaceEnvVariables(rawConfig);

  // Validate the configuration using Zod schema
  const validatedConfig = validateConfig(processedConfig);

  return validatedConfig;
}

/**
 * Gets the loaded configuration, triggering load if not yet loaded
 * @returns {Object} - The loaded configuration object
 * @throws {Error} - Throws if config hasn't been loaded and fails to load
 */
function getConfig() {
  if (config === null) {
    loadConfig();
  }
  return config;
}

/**
 * Explicitly loads the configuration file
 * @returns {Object} - The loaded configuration object
 * @throws {Error} - Throws if config file is missing, invalid, or validation fails
 */
function loadConfig() {
  if (configLoadAttempted && config !== null) {
    return config;
  }

  configLoadAttempted = true;
  
  try {
    config = doLoadConfig();
    configLoadError = null;
  } catch (error) {
    configLoadError = error;
    throw error;
  }
  
  return config;
}

/**
 * Checks whether the configuration has been loaded
 * @returns {boolean} - True if config is loaded, false otherwise
 */
function isConfigLoaded() {
  return config !== null;
}

/**
 * Gets the configuration object for a specific language
 * @param {string} code - The language code (e.g., 'en', 'es', 'fr')
 * @returns {Object|undefined} - The language configuration object or undefined if not found
 */
function getLanguageConfig(code) {
  const cfg = getConfig();
  return cfg.languages.find(lang => lang.code === code);
}

/**
 * Gets the list of target languages (all languages except the source language)
 * @returns {Array} - Array of language configuration objects for target languages
 */
function getTargetLanguages() {
  const cfg = getConfig();
  return cfg.languages.filter(lang => lang.code !== cfg.sourceLanguage);
}

export default {
  get config() {
    return getConfig();
  }
};

export { 
  loadConfig, 
  isConfigLoaded, 
  getLanguageConfig, 
  getTargetLanguages
};

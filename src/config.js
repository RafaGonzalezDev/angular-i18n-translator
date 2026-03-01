import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
function replaceEnvVariables(value) {
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
 * Validates the configuration object
 * @param {Object} config - The configuration object to validate
 * @throws {Error} - Throws descriptive error if validation fails
 */
function validateConfig(config) {
  const requiredFields = ['sourceLanguage', 'languages', 'llm'];
  const missingFields = requiredFields.filter(field => !(field in config));
  
  if (missingFields.length > 0) {
    throw new Error(
      `Missing required configuration fields: ${missingFields.join(', ')}\n` +
      `Please ensure i18n.config.json contains all required fields: ${requiredFields.join(', ')}`
    );
  }
  
  if (!Array.isArray(config.languages) || config.languages.length === 0) {
    throw new Error(
      'Invalid configuration: "languages" must be a non-empty array\n' +
      'Please provide at least one language in the languages array.'
    );
  }
  
  const languageCodes = config.languages.map(lang => lang.code);
  if (!config.sourceLanguage || !languageCodes.includes(config.sourceLanguage)) {
    throw new Error(
      `Invalid sourceLanguage: "${config.sourceLanguage}"\n` +
      `sourceLanguage must be one of the language codes: ${languageCodes.join(', ')}`
    );
  }
  
  const llmRequiredFields = ['baseURL', 'apiKey', 'model'];
  const missingLlmFields = llmRequiredFields.filter(field => !(field in config.llm));
  
  if (missingLlmFields.length > 0) {
    throw new Error(
      `Missing required LLM configuration fields: ${missingLlmFields.join(', ')}\n` +
      `Please ensure the llm object contains: ${llmRequiredFields.join(', ')}`
    );
  }
  
  if (!config.llm.apiKey || config.llm.apiKey.trim() === '') {
    throw new Error(
      'Invalid LLM configuration: apiKey is empty\n' +
      'Please provide a valid API key in the llm.apiKey field or set the LLM_API_KEY environment variable.'
    );
  }
}

/**
 * Loads and validates the configuration file
 * @throws {Error} - Throws if config file is missing, invalid, or validation fails
 */
function doLoadConfig() {
  if (!existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${configPath}\n` +
      'Please create an i18n.config.json file in the project root directory.'
    );
  }

  let fileContent;
  try {
    fileContent = readFileSync(configPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read configuration file: ${error.message}\n` +
      'Please check file permissions and path.'
    );
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(
      `Failed to parse i18n.config.json: ${error.message}\n` +
      'Please ensure the configuration file contains valid JSON.'
    );
  }

  // Replace environment variable placeholders
  const processedConfig = replaceEnvVariables(rawConfig);

  // Validate the configuration
  validateConfig(processedConfig);

  return processedConfig;
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
  getTargetLanguages,
  replaceEnvVariables 
};

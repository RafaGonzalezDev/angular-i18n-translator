/**
 * Configuration loading.
 *
 * Loads i18n.config.json from the project root, resolves ${ENV_VAR}
 * placeholders from the environment, and validates the result.
 *
 * The pure loader `loadConfigFromPath` is exported separately so the core
 * can be reused from tests or a future web frontend without touching the
 * module-level cache.
 */

import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeValidateConfig } from './config-schema.js';
import { ConfigError, ValidationError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = resolve(__dirname, '..');

// Load .env from project root
dotenv.config({ path: resolve(PROJECT_ROOT, '.env') });

/**
 * Default configuration file path. Can be overridden with the
 * I18N_CONFIG_PATH environment variable (used by tests and tooling).
 */
const DEFAULT_CONFIG_PATH = process.env.I18N_CONFIG_PATH
  ? resolve(process.env.I18N_CONFIG_PATH)
  : resolve(PROJECT_ROOT, 'i18n.config.json');

const PLACEHOLDER_RE = /\$\{(\w+)\}/g;

/**
 * Recursively replaces ${ENV_VAR} placeholders with environment values.
 * Placeholders whose variable is not set are left untouched.
 * @param {any} value
 * @returns {any}
 */
export function replaceEnvVariables(value) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (match, envVarName) => {
      if (process.env[envVarName] === undefined) {
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
 * Collects the names of ${ENV_VAR} placeholders still present in a value.
 * @param {any} value
 * @returns {string[]} Unique unresolved variable names
 */
export function findUnresolvedVariables(value) {
  const found = new Set();

  const walk = (node) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(PLACEHOLDER_RE)) {
        found.add(match[1]);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };

  walk(value);
  return [...found];
}

/**
 * Loads, resolves and validates a configuration file. Pure function: no
 * caching, no reliance on module state.
 *
 * @param {string} configPath - Path to i18n.config.json
 * @returns {Object} Validated configuration with defaults applied
 * @throws {ConfigError|ValidationError}
 */
export function loadConfigFromPath(configPath) {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Configuration file not found: ${configPath}`,
      'Create an i18n.config.json file in the project root directory, or run "npm run init".'
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

  const processedConfig = replaceEnvVariables(rawConfig);

  const unresolved = findUnresolvedVariables(processedConfig);
  if (unresolved.length > 0) {
    throw new ConfigError(
      `Unresolved environment variables in i18n.config.json: ${unresolved.map(name => `\${${name}}`).join(', ')}`,
      'Define the missing variables in the .env file (see .env.example), e.g. LLM_API_KEY=your-key'
    );
  }

  const result = safeValidateConfig(processedConfig);

  if (!result.success) {
    throw new ValidationError(
      `Configuration validation failed:\n${result.issues.map(i => `  - ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`,
      result.issues
    );
  }

  return result.data;
}

// ============================================================================
// MODULE-LEVEL CACHED LOADER (CLI convenience)
// ============================================================================

let config = null;

/**
 * Gets the loaded configuration, triggering load on first access.
 * @returns {Object} The loaded configuration object
 * @throws {ConfigError|ValidationError}
 */
function getConfig() {
  if (config === null) {
    config = loadConfigFromPath(DEFAULT_CONFIG_PATH);
  }
  return config;
}

/**
 * Checks whether the configuration has been loaded.
 * @returns {boolean}
 */
function isConfigLoaded() {
  return config !== null;
}

/**
 * Gets the configuration entry for a specific language.
 * @param {string} code - Language code (e.g., 'en', 'es')
 * @returns {Object|undefined}
 */
function getLanguageConfig(code) {
  return getConfig().languages.find(lang => lang.code === code);
}

/**
 * Gets the list of target languages (all languages except the source).
 * @returns {Array}
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
  getConfig,
  isConfigLoaded,
  getLanguageConfig,
  getTargetLanguages,
  DEFAULT_CONFIG_PATH,
};

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '..', '..', '.env') });

const CONFIG_PATH = resolve(__dirname, '..', '..', 'i18n.config.json');

const CONFIG_REQUIREMENTS = {
  default: ['sourceLanguage', 'languages'],
  doctor: [],
  init: [],
  'xlf-to-csv': ['sourceLanguage', 'languages', 'sourceFile', 'csvOutput'],
  'csv-to-xlf': ['sourceLanguage', 'languages', 'csvOutput', 'outputDir'],
  'translate-split': ['csvOutput', 'batchDir', 'llm.batchSize'],
  'translate-run': ['languages', 'sourceLanguage', 'batchDir', 'llm.baseURL', 'llm.model', 'llm.apiKey'],
  'translate-run-dry': ['languages', 'sourceLanguage', 'batchDir'],
  'translate-merge': ['csvOutput', 'batchDir'],
  'translate-all': ['sourceLanguage', 'languages', 'sourceFile', 'csvOutput', 'outputDir', 'batchDir', 'llm.baseURL', 'llm.model', 'llm.apiKey'],
  validate: ['csvOutput', 'languages', 'sourceLanguage'],
  clean: []
};

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function replaceEnvVariables(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (match, envVarName) => {
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

function isEffectivelyEmpty(value) {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '' || value.includes('${');
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

export class ConfigService {
  constructor(configPath = CONFIG_PATH) {
    this.configPath = configPath;
    this._config = null;
  }

  exists() {
    return existsSync(this.configPath);
  }

  load() {
    if (this._config !== null) {
      return this._config;
    }

    if (!this.exists()) {
      throw new Error(`Configuration file not found: ${this.configPath}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to parse i18n.config.json: ${error.message}`);
    }

    this._config = replaceEnvVariables(parsed);
    return this._config;
  }

  validateFor(command) {
    const config = this.load();
    const requiredFields = CONFIG_REQUIREMENTS[command] ?? CONFIG_REQUIREMENTS.default;

    const missingFields = requiredFields.filter(path => isEffectivelyEmpty(getNestedValue(config, path)));
    if (missingFields.length > 0) {
      throw new Error(`Configuration for "${command}" is incomplete. Missing: ${missingFields.join(', ')}`);
    }

    if (Array.isArray(config.languages) && config.languages.length > 0) {
      const codes = config.languages.map(lang => lang.code).filter(Boolean);
      if (config.sourceLanguage && !codes.includes(config.sourceLanguage)) {
        throw new Error(`sourceLanguage "${config.sourceLanguage}" must be present in languages: ${codes.join(', ')}`);
      }
    }

    return config;
  }

  getTargetLanguages(config = null) {
    const cfg = config ?? this.load();
    return (cfg.languages || []).filter(lang => lang.code !== cfg.sourceLanguage);
  }
}

export default ConfigService;

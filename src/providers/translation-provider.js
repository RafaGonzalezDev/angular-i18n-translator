import { translateBatch } from '../llm-client.js';

/**
 * TranslationProvider contract:
 * - translateBatch(csvContent, targetLanguage, config, options) => Promise<string>
 */
export class TranslationProvider {
  async translateBatch(csvContent, targetLanguage, config, options = {}) {
    return translateBatch(csvContent, targetLanguage, config, options);
  }
}

export default TranslationProvider;

/**
 * Centralized Language Mapping Module
 * 
 * Single source of truth for language code to name mappings.
 * Used by init wizard, LLM client, and other modules.
 */

// ============================================================================
// LANGUAGE DEFINITIONS
// ============================================================================

/**
 * Language code to name mapping
 * Simple name for use in prompts and general display
 */
export const LANGUAGES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese Simplified',
  'zh-TW': 'Chinese Traditional',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  ms: 'Malay',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  ro: 'Romanian',
  hu: 'Hungarian',
  el: 'Greek',
  he: 'Hebrew',
  uk: 'Ukrainian',
};

/**
 * Extended display names with native language names
 * Used for CLI selections and user-facing displays
 */
const LANGUAGE_DISPLAY_NAMES = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
  it: 'Italian (Italiano)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  zh: 'Chinese Simplified (简体中文)',
  'zh-TW': 'Chinese Traditional (繁體中文)',
  ru: 'Russian (Русский)',
  ar: 'Arabic (العربية)',
  hi: 'Hindi (हिन्दी)',
  nl: 'Dutch (Nederlands)',
  pl: 'Polish (Polski)',
  tr: 'Turkish (Türkçe)',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ไทย)',
  id: 'Indonesian (Bahasa Indonesia)',
  ms: 'Malay (Bahasa Melayu)',
  sv: 'Swedish (Svenska)',
  da: 'Danish (Dansk)',
  no: 'Norwegian (Norsk)',
  fi: 'Finnish (Suomi)',
  cs: 'Czech (Čeština)',
  ro: 'Romanian (Română)',
  hu: 'Hungarian (Magyar)',
  el: 'Greek (Ελληνικά)',
  he: 'Hebrew (עברית)',
  uk: 'Ukrainian (Українська)',
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get language name from code (simple name)
 * @param {string} code - Language code (e.g., 'en', 'es')
 * @returns {string} Language name or the code if not found
 */
export function getLanguageName(code) {
  return LANGUAGES[code] || code;
}

/**
 * Get language display name from code (with native name)
 * @param {string} code - Language code (e.g., 'en', 'es')
 * @returns {string} Language display name or the code if not found
 */
export function getLanguageDisplayName(code) {
  return LANGUAGE_DISPLAY_NAMES[code] || code;
}

/**
 * Get all language codes
 * @returns {string[]} Array of language codes
 */
export function getLanguageCodes() {
  return Object.keys(LANGUAGES);
}

/**
 * Get language options for inquirer select/checkbox
 * @returns {Array<{name: string, value: string}>}
 */
export function getLanguageChoices() {
  return Object.entries(LANGUAGE_DISPLAY_NAMES)
    .map(([code, name]) => ({
      name,
      value: code,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

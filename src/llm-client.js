/**
 * LLM Client Module
 * Handles communication with OpenAI-compatible LLM APIs for CSV translation
 */

const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 60000; // 60 seconds timeout

/**
 * Builds the system prompt for translation
 * @param {string} targetLanguage - Target language code
 * @param {string} customPrompt - Optional custom prompt from config
 * @returns {string} - Complete system prompt
 */
// Language names mapping for better prompts
const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'zh': 'Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'ru': 'Russian',
  'ar': 'Arabic',
  'nl': 'Dutch',
  'pl': 'Polish',
  'tr': 'Turkish',
  'vi': 'Vietnamese',
  'th': 'Thai',
  'sv': 'Swedish',
  'da': 'Danish',
  'fi': 'Finnish',
  'no': 'Norwegian',
  'cs': 'Czech',
  'el': 'Greek',
  'he': 'Hebrew',
  'id': 'Indonesian',
  'ms': 'Malay',
  'ro': 'Romanian',
  'uk': 'Ukrainian',
  'hu': 'Hungarian'
};

function buildSystemPrompt(targetLanguage, customPrompt) {
  const languageName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
  
  const basePrompt = customPrompt || `You are a professional translator specializing in software localization. Your task is to translate CSV content from English to ${languageName} (${targetLanguage}).

IMPORTANT INSTRUCTIONS:
1. The CSV contains a column "${targetLanguage}" that needs to be translated from the "source" column
2. Preserve all interpolations like {{variable}} exactly as they are - do NOT translate the variables
3. Preserve all ICU message format like {count, plural, =0 {...} other {...}} - translate only the text inside the braces
4. Preserve all placeholders like <x id="..."/> exactly as they are
5. Do NOT translate the translation unit IDs in the "id" column
6. Return ONLY the CSV content, no additional text or explanations
7. Keep the exact same CSV format with columns: id,source,note,meaning,${targetLanguage}
8. The ${targetLanguage} column currently contains English text as placeholders - translate them to ${languageName}`;

  return basePrompt;
}

/**
 * Extracts CSV content from LLM response
 * Handles cases where response might have extra text around CSV
 * @param {string} responseText - Raw response text from LLM
 * @returns {string} - Extracted CSV content
 */
function extractCSVContent(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    throw new Error('Invalid response: response is not a valid string');
  }

  // Try to find CSV content between markdown code blocks
  const codeBlockMatch = responseText.match(/```(?:csv)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find CSV content between triple quotes
  const tripleQuoteMatch = responseText.match(/"""([\s\S]*?)"""/);
  if (tripleQuoteMatch) {
    return tripleQuoteMatch[1].trim();
  }

  // Check if the entire response looks like CSV (starts with id or has comma-separated first line)
  const lines = responseText.trim().split('\n');
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    // If it looks like CSV (has commas or starts with ID)
    if (firstLine.includes(',') || firstLine.toLowerCase().startsWith('id')) {
      return responseText.trim();
    }
  }

  // If no clear CSV found, try to extract lines that look like CSV
  const csvLines = lines.filter(line => {
    const trimmed = line.trim();
    // Keep lines that contain commas and don't look like explanations
    return trimmed.includes(',') && !trimmed.match(/^(here is|here's|here's the|translated|sure|of course)/i);
  });

  if (csvLines.length > 0) {
    return csvLines.join('\n');
  }

  throw new Error('Could not extract CSV content from response');
}

/**
 * Sends a request to the LLM API with exponential backoff retry
 * @param {string} csvContent - CSV content to translate
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration (baseURL, model, apiKey, systemPrompt)
 * @param {Object} options - Options (force, onProgress, currentBatch, totalBatches)
 * @returns {Promise<string>} - Translated CSV content
 */
async function translateBatch(csvContent, targetLanguage, config, options = {}) {
  const { force = false, onProgress, currentBatch = 1, totalBatches = 1 } = options;

  const { baseURL, model, apiKey, systemPrompt } = config;

  // Log progress
  const logProgress = (status) => {
    console.log(`[LLM] Batch ${currentBatch}/${totalBatches}: ${status}`);
    if (onProgress) {
      onProgress(currentBatch, totalBatches, status);
    }
  };

  logProgress('Starting translation...');

  // Build the user prompt with CSV content
  const userPrompt = `Translate the following CSV content to ${targetLanguage}:\n\n${csvContent}`;

  // Build the full system prompt
  const fullSystemPrompt = buildSystemPrompt(targetLanguage, systemPrompt);

  // Prepare request body
  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: fullSystemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  // Exponential backoff retry logic
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      logProgress(`Attempt ${attempt + 1}/${MAX_RETRIES + 1}...`);

      const response = await makeRequestWithTimeout(baseURL, apiKey, requestBody, REQUEST_TIMEOUT);

      // Check for HTTP errors
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API error ${response.status}: ${response.statusText} - ${errorBody}`);
      }

      // Parse JSON response
      let data;
      try {
        const responseText = await response.text();
        data = JSON.parse(responseText);
      } catch (parseError) {
        throw new Error(`Invalid JSON response from API: ${parseError.message}`);
      }

      // Extract content from response
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid response structure: missing choices or message');
      }

      const content = data.choices[0].message.content;

      if (!content) {
        throw new Error('Empty response content from API');
      }

      // Extract CSV from response
      const translatedCSV = extractCSVContent(content);

      logProgress('Translation completed successfully');
      return translatedCSV;

    } catch (error) {
      lastError = error;
      const isRetryable = isErrorRetryable(error);

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`[LLM] Retryable error: ${error.message}. Waiting ${delay}ms before retry...`);
        await sleep(delay);
      } else {
        logProgress(`Failed: ${error.message}`);
        throw error;
      }
    }
  }

  // This should never be reached, but just in case
  logProgress(`Failed after ${MAX_RETRIES + 1} attempts`);
  throw lastError;
}

/**
 * Makes HTTP request with timeout
 * @param {string} baseURL - API base URL
 * @param {string} apiKey - API key
 * @param {Object} body - Request body
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Response>} - Fetch response
 */
async function makeRequestWithTimeout(baseURL, apiKey, body, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determines if an error is retryable
 * @param {Error} error - The error to check
 * @returns {boolean} - True if the error is retryable
 */
function isErrorRetryable(error) {
  const message = error.message.toLowerCase();

  // Network errors
  if (message.includes('fetch') && (message.includes('network') || message.includes('failed to fetch') || message.includes('econnrefused') || message.includes('enotfound'))) {
    return true;
  }

  // Timeout errors
  if (message.includes('timeout')) {
    return true;
  }

  // Server errors (5xx)
  if (message.includes('api error 5')) {
    return true;
  }

  // Rate limiting
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }

  // Service unavailable
  if (message.includes('503') || message.includes('service unavailable')) {
    return true;
  }

  return false;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export {
  translateBatch,
  buildSystemPrompt,
  extractCSVContent,
  makeRequestWithTimeout,
  isErrorRetryable,
  RETRY_DELAYS,
  MAX_RETRIES,
  REQUEST_TIMEOUT
};

/**
 * LLM Client Module
 * Handles communication with OpenAI-compatible LLM APIs for CSV translation
 */

import { parse as csvParseSync } from 'csv-parse/sync';
import { APIError } from './errors.js';
import { getLanguageName } from './languages.js';

const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
const MAX_RETRIES = 3;
// Reasoning models on large batches can take minutes; see llm.timeoutMs
const DEFAULT_TIMEOUT = 300000;
const MAX_ERROR_BODY_LENGTH = 500; // Max characters to show from error body

/**
 * Builds the system prompt for translation
 * @param {string} targetLanguage - Target language code
 * @param {string} customPrompt - Optional custom prompt from config
 * @returns {string} - Complete system prompt
 */

/**
 * Classifies HTTP errors by status code and creates appropriate APIError
 * @param {number} status - HTTP status code
 * @param {string} statusText - HTTP status text
 * @param {string} body - Response body (will be truncated)
 * @param {Object} options - Additional options
 * @param {string} [options.retryAfter] - Value of Retry-After header (in seconds)
 * @returns {APIError} - Classified error with appropriate properties
 */
function classifyHttpError(status, statusText, body, options = {}) {
  const truncatedBody = body ? body.substring(0, MAX_ERROR_BODY_LENGTH) : '';
  const { retryAfter } = options;

  let message;
  let retryable;
  let suggestion;

  switch (status) {
    case 401:
      message = 'API key inválida o expirada. Verifica tu archivo .env';
      retryable = false;
      suggestion = 'Check your API key in the .env file and ensure it has not expired';
      break;

    case 402:
    case 429:
      message = 'Rate limit o cuota excedida. Espera antes de reintentar';
      retryable = true;
      suggestion = retryAfter
        ? `Wait ${retryAfter} seconds before retrying (from Retry-After header)`
        : 'Wait a moment before retrying, or reduce request frequency';
      break;

    case 400:
      message = 'Solicitud inválida. Revisa el modelo y parámetros';
      retryable = false;
      suggestion = truncatedBody
        ? `Check the request parameters. Response: ${truncatedBody}`
        : 'Verify the model name and request parameters are correct';
      break;

    case 500:
    case 502:
    case 503:
    case 504:
      message = 'Error temporal del servidor. Reintentando...';
      retryable = true;
      suggestion = retryAfter
        ? `Server temporarily unavailable. Wait ${retryAfter} seconds (from Retry-After header)`
        : 'Server error is usually temporary. The request will be retried automatically';
      break;

    default:
      message = `HTTP error ${status}: ${statusText}`;
      retryable = status >= 500; // Server errors are generally retryable
      suggestion = truncatedBody
        ? `Response body: ${truncatedBody}`
        : 'Check your network connection and API configuration';
  }

  return new APIError(message, { statusCode: status, retryable, suggestion });
}

function buildSystemPrompt(targetLanguage, customPrompt) {
  const languageName = getLanguageName(targetLanguage);
  
  const basePrompt = customPrompt || `You are a professional translator specializing in software localization. Your task is to translate CSV content from the source language (the "source" column) to ${languageName} (${targetLanguage}), whatever the source language is.

IMPORTANT INSTRUCTIONS:
1. The CSV contains a column "${targetLanguage}" that needs to be translated from the "source" column
2. Preserve all interpolations like {{variable}} exactly as they are - do NOT translate the variables
3. Preserve all ICU message format like {count, plural, =0 {...} other {...}} - translate only the text inside the braces
4. Preserve all placeholders like <x id="..."/> exactly as they are
5. Do NOT translate the translation unit IDs in the "id" column
6. Return ONLY the CSV content, no additional text or explanations
7. Keep the exact same CSV format with columns: id,source,note,meaning,${targetLanguage}
8. The ${targetLanguage} column currently contains the source text as a placeholder - replace it with the ${languageName} translation
9. Return EVERY row with the same ids and in the same order; never drop or reorder rows`;

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
 * Parses CSV content into records, tolerating ragged rows from LLM output.
 * @param {string} csv - CSV content
 * @returns {Array<Object>} Parsed records
 */
function parseCsvRecords(csv) {
  return csvParseSync(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

/**
 * Validates that the translation was performed, comparing records by id.
 *
 * Checks:
 * - Both CSVs parse and contain an `id` column
 * - Every source id is present in the translation
 * - No more than 90% of translatable rows are identical to the source
 *
 * @param {string} sourceCSV - Original CSV content
 * @param {string} translatedCSV - Translated CSV content
 * @param {string} targetLanguage - Target language code
 * @returns {{isValid: boolean, reason?: string, untranslatedCount?: number}}
 */
function validateTranslation(sourceCSV, translatedCSV, targetLanguage) {
  let sourceRecords;
  let translatedRecords;

  try {
    sourceRecords = parseCsvRecords(sourceCSV);
  } catch (error) {
    return { isValid: false, reason: `Could not parse batch CSV: ${error.message}` };
  }

  try {
    translatedRecords = parseCsvRecords(translatedCSV);
  } catch (error) {
    return { isValid: false, reason: `Could not parse LLM response as CSV: ${error.message}` };
  }

  if (sourceRecords.length === 0 || !('id' in (sourceRecords[0] || {}))) {
    return { isValid: false, reason: 'Batch CSV has no rows or no "id" column' };
  }
  if (translatedRecords.length === 0 || !('id' in (translatedRecords[0] || {}))) {
    return {
      isValid: false,
      reason: 'LLM response has no rows or no "id" column; the model did not return the expected CSV',
    };
  }

  const translatedById = new Map();
  for (const record of translatedRecords) {
    if (record.id) {
      translatedById.set(record.id, record);
    }
  }

  const missingIds = sourceRecords
    .map(record => record.id)
    .filter(id => id && !translatedById.has(id));

  if (missingIds.length > 0) {
    const shown = missingIds.slice(0, 5).join(', ');
    const more = missingIds.length > 5 ? ` (+${missingIds.length - 5} more)` : '';
    return {
      isValid: false,
      reason: `LLM response is missing ${missingIds.length} row(s): ${shown}${more}`,
    };
  }

  let identicalCount = 0;
  let totalTranslatable = 0;

  for (const record of sourceRecords) {
    const sourceText = (record.source || '').trim();
    const targetText = ((translatedById.get(record.id) || {})[targetLanguage] || '').trim();

    // Skip empty sources or sources that are only markup/placeholder noise
    if (!sourceText || /^[\s{<\[\(]+$/.test(sourceText)) {
      continue;
    }

    totalTranslatable++;

    if (sourceText.toLowerCase() === targetText.toLowerCase()) {
      identicalCount++;
    }
  }

  // If more than 90% are identical, likely no translation occurred
  if (totalTranslatable > 0) {
    const identicalPercentage = (identicalCount / totalTranslatable) * 100;
    if (identicalPercentage > 90) {
      return {
        isValid: false,
        reason: `No translation detected: ${identicalCount}/${totalTranslatable} (${identicalPercentage.toFixed(1)}%) entries are identical to source`,
        untranslatedCount: identicalCount,
      };
    }
  }

  return { isValid: true };
}

/**
 * Sends a request to the LLM API with exponential backoff retry
 * @param {string} csvContent - CSV content to translate
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration (baseURL, model, apiKey, systemPrompt)
 * @param {Object} options - Options (force, onProgress, currentBatch, totalBatches, timeout, verbose)
 * @returns {Promise<string>} - Translated CSV content
 */
async function translateBatch(csvContent, targetLanguage, config, options = {}) {
  const {
    force = false,
    onProgress,
    currentBatch = 1,
    totalBatches = 1,
    verbose = false
  } = options;

  const { baseURL, model, apiKey, systemPrompt, requestExtra } = config;
  const timeout = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT;

  // Progress tracking for ETA calculation
  const startTime = Date.now();
  const batchTimes = [];

  // Log progress with enhanced information
  const logProgress = (status) => {
    const elapsedTime = Date.now() - startTime;

    // Calculate simple ETA based on average batch time
    let eta = null;
    if (batchTimes.length > 0 && currentBatch < totalBatches) {
      const avgBatchTime = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
      const remainingBatches = totalBatches - currentBatch;
      eta = Math.round(avgBatchTime * remainingBatches);
    }

    if (options.verbose) {
      console.log(`[LLM] Batch ${currentBatch}/${totalBatches}: ${status} (${elapsedTime}ms elapsed${eta ? `, ETA: ${eta}ms` : ''})`);
    }

    if (onProgress) {
      onProgress(currentBatch, totalBatches, status, { startTime, elapsedTime, eta });
    }
  };

  if (options.verbose) {
    logProgress('Starting translation...');
  }

  // Build the user prompt with CSV content
  const languageName = getLanguageName(targetLanguage);
  const userPrompt =
    `Translate the following CSV to ${languageName} (${targetLanguage}). ` +
    `Translate ONLY the "${targetLanguage}" column. ` +
    `Return ALL rows with the same ids, the same order, and the same CSV header.\n\n` +
    csvContent;

  // Build the full system prompt
  const fullSystemPrompt = buildSystemPrompt(targetLanguage, systemPrompt);

  // Prepare request body (requestExtra allows provider-specific options such
  // as DeepSeek's {"thinking": {"type": "disabled"}})
  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: fullSystemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  if (requestExtra && typeof requestExtra === 'object') {
    Object.assign(requestBody, requestExtra);
  }

  // Exponential backoff retry logic
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (options.verbose) {
        logProgress(`Attempt ${attempt + 1}/${MAX_RETRIES + 1}...`);
      }

      const response = await makeRequestWithTimeout(baseURL, apiKey, requestBody, timeout);

      // Check for HTTP errors
      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfter = response.headers.get('Retry-After');
        throw classifyHttpError(response.status, response.statusText, errorBody, { retryAfter });
      }

      // Parse JSON response
      let data;
      try {
        const responseText = await response.text();
        data = JSON.parse(responseText);
      } catch (parseError) {
        throw new APIError(`Invalid JSON response from API: ${parseError.message}`, {
          retryable: false,
          suggestion: 'The API returned malformed JSON. Check the API endpoint.'
        });
      }

      // Extract content from response
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new APIError('Invalid response structure: missing choices or message', {
          retryable: false,
          suggestion: 'The API response format is unexpected. Verify the API compatibility.'
        });
      }

      const content = data.choices[0].message.content;

      if (!content) {
        throw new APIError('Empty response content from API', {
          retryable: false,
          suggestion: 'The API returned an empty response. Try with different content.'
        });
      }

      // Extract CSV from response
      const translatedCSV = extractCSVContent(content);

      // Validate that translation actually occurred
      const validation = validateTranslation(csvContent, translatedCSV, targetLanguage);
      if (!validation.isValid) {
        throw new APIError(`Translation validation failed: ${validation.reason}`, {
          retryable: true,
          suggestion: 'The model returned source text instead of translation. Will retry with stronger instructions.'
        });
      }

      // Record batch time for ETA calculation
      batchTimes.push(Date.now() - startTime);

      logProgress('Translation completed successfully');
      return translatedCSV;

    } catch (error) {
      lastError = error;
      const isRetryable = isErrorRetryable(error);

      if (attempt < MAX_RETRIES && isRetryable) {
        // Calculate delay with jitter: base * (0.5 + random)
        const baseDelay = RETRY_DELAYS[attempt];
        const jitter = 0.5 + Math.random(); // Random between 0.5 and 1.5
        let delay = Math.round(baseDelay * jitter);

        // Respect Retry-After header if present (in seconds)
        if (error instanceof APIError) {
          const retryAfterMatch = error.suggestion?.match(/Wait (\d+) seconds/);
          if (retryAfterMatch) {
            const retryAfterMs = parseInt(retryAfterMatch[1], 10) * 1000;
            delay = Math.max(delay, retryAfterMs);
          }
        }

        if (verbose) {
          console.log(`[LLM] Retryable error: ${error.message}. Waiting ${delay}ms before retry...`);
        }
        await sleep(delay);
      } else {
        if (verbose) {
          logProgress(`Failed: ${error.message}`);
        }
        throw error;
      }
    }
  }

  // This should never be reached, but just in case
  if (verbose) {
    logProgress(`Failed after ${MAX_RETRIES + 1} attempts`);
  }
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
  // Check if it's an APIError with retryable property
  if (error instanceof APIError) {
    return error.retryable;
  }

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
  validateTranslation,
  makeRequestWithTimeout,
  classifyHttpError,
  isErrorRetryable,
  RETRY_DELAYS,
  MAX_RETRIES,
  DEFAULT_TIMEOUT,
  MAX_ERROR_BODY_LENGTH
};

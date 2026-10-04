/** OpenAI-compatible CSV translation client. */
import { APIError } from './errors.js';
import { getLanguageName } from './languages.js';
import { parseCsvRecords, assertUniqueIds } from './csv-records.js';
import { validateMessage, isMissingTranslation } from './message-content.js';

const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 300000;
const MAX_ERROR_BODY_LENGTH = 500;
const MAX_TIMER_DELAY = 2147483647;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const delay = Number(text) * 1000;
    return Number.isFinite(delay) ? delay : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function classifyHttpError(status, statusText, body, options = {}) {
  const retryAfterMs = parseRetryAfter(options.retryAfter);
  const numericRetryAfter = typeof options.retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(options.retryAfter.trim());
  const excessiveWait = retryAfterMs > MAX_TIMER_DELAY || (numericRetryAfter && retryAfterMs === null);
  const retryable = !excessiveWait && (status === 408 || status === 429 || status >= 500);
  const messages = {
    400: 'Solicitud inválida. Revisa el modelo y parámetros',
    401: 'API key inválida o expirada. Verifica tu archivo .env',
    402: 'Cuota o saldo insuficiente. Revisa la facturación del proveedor',
    429: 'Rate limit excedido. Espera antes de reintentar',
  };
  const error = new APIError(messages[status] || `HTTP error ${status}: ${statusText}`, {
    statusCode: status,
    retryable,
    suggestion: excessiveWait ? 'Retry-After exceeds the supported automatic wait; retry manually later' : retryAfterMs !== null
      ? `Wait ${retryAfterMs / 1000} seconds before retrying (from Retry-After header)`
      : (body ? `Response: ${body.substring(0, MAX_ERROR_BODY_LENGTH)}` : 'Check your API configuration'),
  });
  error.retryAfter = options.retryAfter ?? null;
  error.retryAfterMs = retryAfterMs;
  error.code = 'HTTP_ERROR';
  return error;
}

function buildSystemPrompt(targetLanguage, customPrompt) {
  return customPrompt || `You are a professional software localization translator. Translate the source language to ${getLanguageName(targetLanguage)} (${targetLanguage}).
Return ONLY raw CSV with the exact columns id,source,note,meaning,${targetLanguage}.
Translate ONLY the "${targetLanguage}" column. Preserve id, source, note and meaning byte-for-byte after CSV decoding.
Preserve XML fragment structure, placeholder attributes, interpolations and ICU variables, types and selectors; translate only text.
Return EVERY row exactly once with the same ids. Do not add rows or columns, explanations or code fences.`;
}

function extractCSVContent(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    throw new Error('Invalid response: response is not a valid string');
  }
  const codeBlockMatch = responseText.match(/```(?:csv)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const trimmed = responseText.trim();
  if (/^"id,/.test(trimmed) && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim();
  // Strip explanatory prefixes without reconstructing CSV lines (multiline fields).
  const header = /^(?:"id"|id),/m.exec(trimmed);
  return header ? trimmed.slice(header.index) : trimmed;
}

/** Strict response validation; row order is deliberately irrelevant. */
function validateTranslation(sourceCSV, translatedCSV, targetLanguage) {
  try {
    const source = parseCsvRecords(sourceCSV, { requiredColumns: ['id', 'source', targetLanguage] });
    const translated = parseCsvRecords(translatedCSV, { requiredColumns: source.columns });
    assertUniqueIds(source.records, source.lines);
    assertUniqueIds(translated.records, translated.lines);
    if (!source.records.length) throw new Error('Batch CSV has no rows');
    if (translated.columns.length !== source.columns.length || translated.columns.some(col => !source.columns.includes(col))) {
      throw new Error('LLM response has unexpected columns');
    }
    const sourceById = new Map(source.records.map(record => [record.id, record]));
    const translatedById = new Map(translated.records.map(record => [record.id, record]));
    const missing = source.records.filter(record => !translatedById.has(record.id));
    if (missing.length) throw new Error(`LLM response is missing ${missing.length} row(s): ${missing.map(record => record.id).join(', ')}`);
    const warnings = [];
    for (const record of translated.records) {
      const original = sourceById.get(record.id);
      if (!original) throw new Error(`LLM response has extra id: ${record.id}`);
      for (const column of source.columns.filter(column => column !== targetLanguage)) {
        if (record[column] !== original[column]) throw new Error(`LLM response modified ${column} for id ${record.id}`);
      }
      if (isMissingTranslation(original.source, record[targetLanguage])) throw new Error(`Empty target for id ${record.id}`);
      const errors = validateMessage(original.source, record[targetLanguage]);
      if (errors.length) throw new Error(`Invalid message for id ${record.id}: ${errors.join('; ')}`);
      if (original.source && original.source === record[targetLanguage]) warnings.push(`Target identical to source for id ${record.id}`);
    }
    return { isValid: true, warnings, untranslatedCount: warnings.length };
  } catch (error) {
    return { isValid: false, reason: error.message };
  }
}

function isErrorRetryable(error) {
  if (error instanceof APIError) return error.retryable;
  let cause = error;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (NETWORK_CODES.has(cause.code) || cause.name === 'AbortError' || cause.name === 'TimeoutError') return true;
    cause = cause.cause;
  }
  return error instanceof TypeError && /fetch failed|failed to fetch/i.test(error.message);
}

/** Timeout covers connection, headers AND complete body consumption. */
async function makeRequestWithTimeout(baseURL, apiKey, body, timeout = DEFAULT_TIMEOUT) {
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_DELAY) {
    throw new APIError('Invalid request timeout: expected 1..2147483647 milliseconds', { retryable: false });
  }
  const controller = new AbortController();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const error = new APIError(`Request timeout after ${timeout}ms`, { retryable: true });
      error.code = 'REQUEST_TIMEOUT';
      reject(error);
    }, timeout);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const bodyText = await response.text();
        return { ok: response.ok, status: response.status, statusText: response.statusText, headers: response.headers, bodyText };
      })(),
      timeoutPromise,
    ]);
  } catch (cause) {
    if (cause instanceof APIError) throw cause;
    const error = new APIError(cause.message, { retryable: isErrorRetryable(cause) });
    error.code = cause.code || cause.cause?.code || 'REQUEST_FAILED';
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function translateBatch(csvContent, targetLanguage, config, options = {}) {
  const { baseURL, model, apiKey, systemPrompt, requestExtra } = config;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const requestBody = {
    ...(requestExtra && typeof requestExtra === 'object' ? requestExtra : {}),
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(targetLanguage, systemPrompt) },
      { role: 'user', content: `Translate ONLY the "${targetLanguage}" column to ${getLanguageName(targetLanguage)} (${targetLanguage}). Preserve all other columns and return every id exactly once.\n\n${csvContent}` },
    ],
  };
  const startTime = Date.now();
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await makeRequestWithTimeout(baseURL, apiKey, requestBody, timeout);
      if (!response.ok) throw classifyHttpError(response.status, response.statusText, response.bodyText, { retryAfter: response.headers.get('Retry-After') });
      let data;
      try { data = JSON.parse(response.bodyText); }
      catch (cause) { throw new APIError(`Invalid JSON response from API: ${cause.message}`, { retryable: false }); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) throw new APIError('Invalid response structure or empty response content from API', { retryable: false });
      const translatedCSV = extractCSVContent(content);
      const validation = validateTranslation(csvContent, translatedCSV, targetLanguage);
      if (!validation.isValid) throw new APIError(`Translation validation failed: ${validation.reason}`, { retryable: true });
      options.onProgress?.(options.currentBatch || 1, options.totalBatches || 1, 'completed', { elapsedTime: Date.now() - startTime, warnings: validation.warnings });
      return translatedCSV;
    } catch (error) {
      if (attempt >= maxRetries || !isErrorRetryable(error)) throw error;
      const delays = options.retryDelays || RETRY_DELAYS;
      const delay = Math.max(Math.round((delays[Math.min(attempt, delays.length - 1)] || 0) * (0.5 + Math.random())), error.retryAfterMs || 0);
      if (!Number.isFinite(delay) || delay > MAX_TIMER_DELAY) throw new APIError('Retry delay exceeds the supported automatic wait; retry manually later', { retryable: false });
      if (options.verbose) console.log(`[LLM] ${error.message}. Retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export { translateBatch, buildSystemPrompt, extractCSVContent, validateTranslation, makeRequestWithTimeout, classifyHttpError, isErrorRetryable, parseRetryAfter, RETRY_DELAYS, MAX_RETRIES, DEFAULT_TIMEOUT, MAX_ERROR_BODY_LENGTH };

/**
 * Tests for src/llm-client.js (pure helpers; network paths are covered by
 * the batch-manager tests).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCSVContent,
  validateTranslation,
  classifyHttpError,
  isErrorRetryable,
  buildSystemPrompt,
} from '../src/llm-client.js';

// ============================================================================
// extractCSVContent
// ============================================================================

test('extractCSVContent returns plain CSV untouched', () => {
  const csv = 'id,source,es\na,Hello,Hola';
  assert.equal(extractCSVContent(csv), csv);
});

test('extractCSVContent unwraps markdown code blocks', () => {
  const csv = 'id,source,es\na,Hello,Hola';
  const response = `Here is the translation:\n\`\`\`csv\n${csv}\n\`\`\`\nDone!`;
  assert.equal(extractCSVContent(response), csv);
});

test('extractCSVContent unwraps triple-quoted blocks', () => {
  const csv = 'id,source,es\na,Hello,Hola';
  const response = `Sure! """${csv}"""`;
  assert.equal(extractCSVContent(response), csv);
});

test('extractCSVContent filters explanation lines when needed', () => {
  const response = 'Here is the translated CSV:\nid,source,es\na,Hello,Hola';
  assert.equal(extractCSVContent(response), 'id,source,es\na,Hello,Hola');
});

test('extractCSVContent rejects non-string input', () => {
  assert.throws(() => extractCSVContent(null), /not a valid string/);
});

// ============================================================================
// validateTranslation
// ============================================================================

const SOURCE_CSV = 'id,source,es\na,"Hello, world","Hello, world"\nb,Goodbye,Goodbye\nc,Thanks,Thanks';

test('validateTranslation accepts a proper translation', () => {
  const translated = 'id,source,es\na,"Hello, world","Hola, mundo"\nb,Goodbye,Adiós\nc,Thanks,Gracias';
  const result = validateTranslation(SOURCE_CSV, translated, 'es');
  assert.equal(result.isValid, true);
});

test('validateTranslation handles quoted fields with commas', () => {
  // The old comma-split implementation broke here
  const translated = 'id,source,es\na,"Hello, world","Hola, mundo"\nb,Goodbye,Adiós\nc,Thanks,Gracias';
  const result = validateTranslation(SOURCE_CSV, translated, 'es');
  assert.equal(result.isValid, true);
});

test('validateTranslation rejects when rows are missing', () => {
  const translated = 'id,source,es\na,"Hello, world","Hola, mundo"\nc,Thanks,Gracias';
  const result = validateTranslation(SOURCE_CSV, translated, 'es');
  assert.equal(result.isValid, false);
  assert.match(result.reason, /missing 1 row/);
});

test('validateTranslation rejects when nothing was translated', () => {
  const result = validateTranslation(SOURCE_CSV, SOURCE_CSV, 'es');
  assert.equal(result.isValid, false);
  assert.match(result.reason, /No translation detected/);
});

test('validateTranslation rejects unparseable LLM output', () => {
  const result = validateTranslation(SOURCE_CSV, 'I cannot translate this, sorry!', 'es');
  assert.equal(result.isValid, false);
});

test('validateTranslation matches by id regardless of row order', () => {
  const translated = 'id,source,es\nc,Thanks,Gracias\nb,Goodbye,Adiós\na,"Hello, world","Hola, mundo"';
  const result = validateTranslation(SOURCE_CSV, translated, 'es');
  assert.equal(result.isValid, true);
});

// ============================================================================
// Error classification
// ============================================================================

test('classifyHttpError marks 429 and 5xx as retryable, 401 as not', () => {
  assert.equal(classifyHttpError(429, 'Too Many Requests', '').retryable, true);
  assert.equal(classifyHttpError(503, 'Service Unavailable', '').retryable, true);
  assert.equal(classifyHttpError(401, 'Unauthorized', '').retryable, false);
  assert.equal(classifyHttpError(400, 'Bad Request', '').retryable, false);
});

test('classifyHttpError respects Retry-After header', () => {
  const error = classifyHttpError(429, 'Too Many Requests', '', { retryAfter: '30' });
  assert.match(error.suggestion, /30 seconds/);
});

test('isErrorRetryable detects timeouts and network errors', () => {
  assert.equal(isErrorRetryable(new Error('Request timeout after 300000ms')), true);
  assert.equal(isErrorRetryable(new Error('fetch failed: ECONNREFUSED')), true);
  assert.equal(isErrorRetryable(new Error('Something else')), false);
});

// ============================================================================
// buildSystemPrompt
// ============================================================================

test('buildSystemPrompt names the target language and is source-agnostic', () => {
  const prompt = buildSystemPrompt('de');
  assert.ok(prompt.includes('German (de)'));
  assert.ok(!prompt.includes('from English'));
});

test('buildSystemPrompt uses the custom prompt when provided', () => {
  const prompt = buildSystemPrompt('de', 'CUSTOM PROMPT');
  assert.equal(prompt, 'CUSTOM PROMPT');
});

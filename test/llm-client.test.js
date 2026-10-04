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
  makeRequestWithTimeout,
  translateBatch,
  parseRetryAfter,
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

test('extractCSVContent keeps legitimate CSV whose fields contain doubled quotes', () => {
  // A field ending in doubled quotes plus its closing quote produces """;
  // that must NOT be treated as a wrapper.
  const csv = 'id,source,es\na,"Say ""hi""","Di ""hola"""';
  assert.equal(extractCSVContent(csv), csv);
});

test('extractCSVContent unwraps a CSV wrapped in one pair of double quotes', () => {
  const csv = 'id,source,es\na,"Hello, world","Hola, mundo"';
  const response = `"${csv}"`;
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

test('validateTranslation warns, without rejecting identical targets', () => {
  const result = validateTranslation(SOURCE_CSV, SOURCE_CSV, 'es');
  assert.equal(result.isValid, true);
  assert.equal(result.warnings.length, 3);
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
  assert.equal(isErrorRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isErrorRetryable(new TypeError('fetch failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) })), true);
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

for (const [name, csv] of [
  ['duplicate ids', 'id,source,es\na,Hello,Hola\na,Hello,Hola\nb,Goodbye,Adiós\nc,Thanks,Gracias'],
  ['extra ids', 'id,source,es\na,"Hello, world",Hola\nb,Goodbye,Adiós\nc,Thanks,Gracias\nx,Extra,Extra'],
  ['extra columns', 'id,source,es,unexpected\na,"Hello, world",Hola,x\nb,Goodbye,Adiós,x\nc,Thanks,Gracias,x'],
  ['missing target column', 'id,source\na,"Hello, world"\nb,Goodbye\nc,Thanks'],
  ['ragged rows', 'id,source,es\na,"Hello, world",Hola,extra\nb,Goodbye,Adiós\nc,Thanks,Gracias'],
  ['empty targets', 'id,source,es\na,"Hello, world",\nb,Goodbye,Adiós\nc,Thanks,Gracias'],
  ['modified source', 'id,source,es\na,Changed,Hola\nb,Goodbye,Adiós\nc,Thanks,Gracias'],
]) {
  test(`validateTranslation rejects ${name}`, () => assert.equal(validateTranslation(SOURCE_CSV, csv, 'es').isValid, false));
}

test('validateTranslation preserves exact whitespace, context and multiline fields', () => {
  const source = 'id,source,note,meaning,es\na," Hello\nworld "," note ",context,x';
  const translated = 'id,source,note,meaning,es\na," Hello\nworld "," note ",context," Hola\nmundo "';
  assert.equal(validateTranslation(source, translated, 'es').isValid, true);
  assert.equal(validateTranslation(source, translated.replace(' note ', 'note'), 'es').isValid, false);
  assert.equal(validateTranslation(source, translated.replace(',context,', ',changed,'), 'es').isValid, false);
});

test('validateTranslation permits an empty target only for an empty source', () => {
  assert.equal(validateTranslation('id,source,es\na,,', 'id,source,es\na,,', 'es').isValid, true);
});

test('validateTranslation rejects broken XML and missing interpolations', () => {
  assert.equal(validateTranslation('id,source,es\na,Hello {{name}},x', 'id,source,es\na,Hello {{name}},Hola', 'es').isValid, false);
  const source = 'id,source,es\na,"Hello <x id=""PH""/>",x';
  assert.equal(validateTranslation(source, 'id,source,es\na,"Hello <x id=""PH""/>","Hola <g>"', 'es').isValid, false);
});

test('402 is not retried and Retry-After supports dates and seconds', () => {
  assert.equal(classifyHttpError(402, 'Payment Required', '').retryable, false);
  assert.equal(classifyHttpError(429, '', '', { retryAfter: '2' }).retryAfterMs, 2000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000), 9000);
  assert.equal(parseRetryAfter('invalid'), null);
});

test('makeRequestWithTimeout materializes body and normalizes endpoint slashes', async t => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://example.invalid/v1/chat/completions');
    return new Response('materialized', { status: 200 });
  });
  const response = await makeRequestWithTimeout('https://example.invalid/v1///', 'test-key', {}, 500);
  assert.deepEqual(Object.keys(response).sort(), ['bodyText', 'headers', 'ok', 'status', 'statusText']);
  assert.equal(response.bodyText, 'materialized');
});

test('makeRequestWithTimeout remains active after headers while body is stalled', async t => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
  });
  await assert.rejects(makeRequestWithTimeout('https://example.invalid', 'test-key', {}, 15), error => error.code === 'REQUEST_TIMEOUT' && error.retryable);
  assert.equal(signal.aborted, true);
});

test('makeRequestWithTimeout classifies typed network failures', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) }); });
  await assert.rejects(makeRequestWithTimeout('https://example.invalid', 'test-key', {}, 100), error => error.retryable && error.code === 'UND_ERR_SOCKET' && error.cause instanceof TypeError);
});

test('translateBatch retries network and transient HTTP but protects model and messages', async t => {
  let attempts = 0;
  const csv = 'id,source,es\na,Hello,Hola';
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    attempts++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'safe-model');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.temperature, 0);
    if (attempts === 1) throw new TypeError('fetch failed');
    if (attempts === 2) return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: csv } }] }));
  });
  assert.equal(await translateBatch('id,source,es\na,Hello,Hello', 'es', { baseURL: 'https://example.invalid', model: 'safe-model', apiKey: 'test-key', requestExtra: { model: 'bad', messages: [], temperature: 0 } }, { retryDelays: [0, 0, 0] }), csv);
  assert.equal(attempts, 3);
});

for (const status of [400, 401, 402]) {
  test(`translateBatch never retries HTTP ${status}`, async t => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('rejected', { status }); });
    await assert.rejects(translateBatch('id,source,es\na,Hello,Hello', 'es', { baseURL: 'https://example.invalid', model: 'test', apiKey: 'test-key' }, { retryDelays: [0] }), error => error.statusCode === status);
    assert.equal(attempts, 1);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecords } from '../src/validator.js';
import { validateMessage } from '../src/message-content.js';
import { validateTranslation, parseRetryAfter, classifyHttpError, makeRequestWithTimeout } from '../src/llm-client.js';
import { safeValidateConfig } from '../src/config-schema.js';
import { makeConfig } from './helpers.js';

test('timer overflow is rejected before requesting and never becomes a 1ms retry', async () => {
  for (const timeout of [2147483648, Infinity, 0, -1, 1.5]) {
    await assert.rejects(() => makeRequestWithTimeout('http://127.0.0.1:9', 'dummy', {}, timeout), /Invalid request timeout/);
  }
  assert.equal(parseRetryAfter('9'.repeat(400)), null);
  assert.equal(classifyHttpError(429, 'Rate limit', '', { retryAfter: '9'.repeat(400) }).retryable, false);
  assert.equal(classifyHttpError(429, 'Rate limit', '', { retryAfter: '2147484' }).retryable, false);
  const cfg = makeConfig({ baseURL: 'https://api.example.com', llm: { timeoutMs: 2147483648 } });
  assert.equal(safeValidateConfig(cfg).success, false);
});

test('language codes cannot overwrite reserved CSV columns', () => {
  for (const code of ['id', 'source', 'note', 'meaning']) {
    assert.equal(safeValidateConfig(makeConfig({ baseURL: 'https://api.example.com', languages: ['en', code] })).success, false);
  }
});

test('large valid CSV record collections do not overflow spread argument limits', () => {
  const records = Array.from({ length: 150000 }, (_, index) => ({ id: String(index), source: 'OK', es: 'OK' }));
  const report = validateRecords(records, ['es']);
  assert.equal(report.summary.allValid, true);
  assert.equal(report.summary.warnings, records.length);
});

test('whitespace-only source still requires a target but can retain intentional whitespace', () => {
  assert.equal(validateRecords([{ id: 'a', source: ' ', es: '' }], ['es']).summary.allValid, false);
  assert.equal(validateRecords([{ id: 'a', source: ' ', es: ' ' }], ['es']).summary.allValid, true);
  assert.equal(validateTranslation('id,source,es\na, , \n', 'id,source,es\na, ,\n', 'es').isValid, false);
  assert.equal(validateTranslation('id,source,es\na, , \n', 'id,source,es\na, , \n', 'es').isValid, true);
});

test('paired placeholder families and code content stay intact while named interpolations are not tag pairs', () => {
  const interpolation = '<x id="START_DATE" equiv-text="{{date}}"/>';
  assert.deepEqual(validateMessage(interpolation, interpolation), []);
  const source = '<bpt id="1">&lt;b&gt;</bpt>hello<ept id="1">&lt;/b&gt;</ept>';
  assert.deepEqual(validateMessage(source, source.replace('hello', 'hola')), []);
  assert.ok(validateMessage(source, source.replace('&lt;b&gt;', '&lt;i&gt;')).length);
  assert.ok(validateMessage('<bx id="1" rid="r"/><ept id="2" rid="r"/>', '<bx id="1" rid="r"/><ept id="2" rid="r"/>').length);
  assert.deepEqual(validateMessage('<ph id="1">code<sub>hello</sub></ph>', '<ph id="1">code<sub>hola</sub></ph>'), []);
});

test('locale plural additions repeat placeholders only within equivalent branches', () => {
  const source = '{n, plural, other {<x id="PH"/> {{name}} items}}';
  const target = '{n, plural, one {<x id="PH"/> {{name}} artículo} other {<x id="PH"/> {{name}} artículos}}';
  assert.deepEqual(validateMessage(source, target), []);
  assert.ok(validateMessage(source, target.replace('<x id="PH"/> {{name}} artículo', 'artículo')).length);
  assert.ok(validateMessage('<g id="a">{n, plural, other {items}}</g>', '<g id="a"/>{n, plural, other {artículos}}').length);
});

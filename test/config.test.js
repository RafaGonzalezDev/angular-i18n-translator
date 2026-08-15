/**
 * Tests for src/config.js and src/config-schema.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfigFromPath, replaceEnvVariables, findUnresolvedVariables } from '../src/config.js';
import { safeValidateConfig } from '../src/config-schema.js';
import { ConfigError, ValidationError } from '../src/errors.js';
import { makeTempDir, writeFixture, makeConfig } from './helpers.js';

function writeConfig(dir, configObj) {
  return writeFixture(dir, 'i18n.config.json', JSON.stringify(configObj, null, 2));
}

test('loadConfigFromPath loads a valid config and applies defaults', () => {
  const dir = makeTempDir();
  const path = writeConfig(dir, makeConfig({ baseURL: 'https://api.example.com' }));

  const config = loadConfigFromPath(path);

  assert.equal(config.languages.length, 2);
  assert.equal(config.llm.batchSize, 50);
  assert.equal(config.llm.concurrency, 2); // from fixture, not default
});

test('loadConfigFromPath throws ConfigError for a missing file', () => {
  assert.throws(
    () => loadConfigFromPath('/nonexistent/i18n.config.json'),
    (err) => err instanceof ConfigError && /not found/.test(err.message)
  );
});

test('loadConfigFromPath throws ConfigError for invalid JSON', () => {
  const dir = makeTempDir();
  const path = writeFixture(dir, 'i18n.config.json', '{ broken json');

  assert.throws(
    () => loadConfigFromPath(path),
    (err) => err instanceof ConfigError && /Failed to parse/.test(err.message)
  );
});

test('loadConfigFromPath lists unresolved environment variables', () => {
  const dir = makeTempDir();
  delete process.env.I18N_TEST_MISSING_KEY;
  const config = makeConfig({ baseURL: 'https://api.example.com' });
  config.llm.apiKey = '${I18N_TEST_MISSING_KEY}';
  const path = writeConfig(dir, config);

  assert.throws(
    () => loadConfigFromPath(path),
    (err) => err instanceof ConfigError && err.message.includes('I18N_TEST_MISSING_KEY')
  );
});

test('loadConfigFromPath resolves environment variables', () => {
  const dir = makeTempDir();
  process.env.I18N_TEST_API_KEY = 'secret-key';
  const config = makeConfig({ baseURL: 'https://api.example.com' });
  config.llm.apiKey = '${I18N_TEST_API_KEY}';
  const path = writeConfig(dir, config);

  try {
    const loaded = loadConfigFromPath(path);
    assert.equal(loaded.llm.apiKey, 'secret-key');
  } finally {
    delete process.env.I18N_TEST_API_KEY;
  }
});

test('loadConfigFromPath throws ValidationError with readable issues', () => {
  const dir = makeTempDir();
  const config = makeConfig({ baseURL: 'https://api.example.com' });
  config.sourceLanguage = 'de'; // not in languages
  const path = writeConfig(dir, config);

  assert.throws(
    () => loadConfigFromPath(path),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /sourceLanguage/);
      assert.match(err.message, /must be one of the configured language codes/);
      return true;
    }
  );
});

test('loadConfigFromPath rejects invalid baseURL with a clear message', () => {
  const dir = makeTempDir();
  const config = makeConfig({ baseURL: 'not-a-url' });
  const path = writeConfig(dir, config);

  assert.throws(
    () => loadConfigFromPath(path),
    (err) => err instanceof ValidationError && /baseURL/.test(err.message)
  );
});

test('safeValidateConfig rejects duplicate language codes', () => {
  const config = makeConfig({ baseURL: 'https://api.example.com', languages: ['en', 'en'] });
  const result = safeValidateConfig(config);
  assert.equal(result.success, false);
  assert.match(result.issues[0].message, /Duplicate language code/);
});

test('replaceEnvVariables and findUnresolvedVariables behave consistently', () => {
  process.env.I18N_SET = 'value';
  const input = { a: '${I18N_SET}', b: '${I18N_NOT_SET}', c: ['${I18N_SET}'], d: 5 };

  const replaced = replaceEnvVariables(input);
  assert.equal(replaced.a, 'value');
  assert.equal(replaced.b, '${I18N_NOT_SET}');
  assert.deepEqual(replaced.c, ['value']);
  assert.equal(replaced.d, 5);

  assert.deepEqual(findUnresolvedVariables(replaced), ['I18N_NOT_SET']);
  delete process.env.I18N_SET;
});

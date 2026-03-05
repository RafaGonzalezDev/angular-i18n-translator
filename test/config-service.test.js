import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '../src/services/config-service.js';

function createTempConfig(config) {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-config-test-'));
  const path = join(dir, 'i18n.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
  return { dir, path };
}

test('validateFor xlf-to-csv does not require llm credentials', () => {
  const temp = createTempConfig({
    languages: [{ code: 'en' }, { code: 'es' }],
    sourceLanguage: 'en',
    sourceFile: 'messages.xlf',
    csvOutput: 'messages.csv',
    outputDir: 'dist-i18n',
    batchDir: 'batches',
    llm: {}
  });

  try {
    const service = new ConfigService(temp.path);
    const cfg = service.validateFor('xlf-to-csv');
    assert.equal(cfg.sourceLanguage, 'en');
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test('validateFor translate-run requires llm credentials', () => {
  const temp = createTempConfig({
    languages: [{ code: 'en' }, { code: 'es' }],
    sourceLanguage: 'en',
    sourceFile: 'messages.xlf',
    csvOutput: 'messages.csv',
    outputDir: 'dist-i18n',
    batchDir: 'batches',
    llm: {}
  });

  try {
    const service = new ConfigService(temp.path);
    assert.throws(() => service.validateFor('translate-run'));
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

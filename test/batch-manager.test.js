/**
 * Tests for src/batch-manager.js
 *
 * Uses a local HTTP server that mimics the OpenAI chat/completions API to
 * exercise the real translation path: skip logic, id-based matching,
 * failure handling, stale batch cleanup and merge reporting.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { join } from 'path';

import { splitBatches, runBatches, mergeBatches } from '../src/batch-manager.js';
import { registerArtifacts } from '../src/artifacts.js';
import { makeTempDir, writeFixture } from './helpers.js';

// ============================================================================
// MOCK LLM SERVER
// ============================================================================

/**
 * Starts a mock OpenAI-compatible server.
 * @param {(csv: string) => string} translate - Turns the request CSV into the response CSV
 * @returns {Promise<{baseURL: string, close: () => Promise<void>, calls: () => number}>}
 */
function startMockLLM(translate) {
  let callCount = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      callCount++;
      const request = JSON.parse(body);
      const userContent = request.messages.find(m => m.role === 'user').content;
      const csv = userContent.split('\n\n').slice(1).join('\n\n');

      let responseCsv;
      try {
        responseCsv = translate(csv);
      } catch (error) {
        res.writeHead(500).end(JSON.stringify({ error: { message: error.message } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: responseCsv } }] }));
    });
  });

  return new Promise(resolvePromise => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({
        baseURL: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(done)),
        calls: () => callCount,
      });
    });
  });
}

/** Word map used to simulate translation */
const WORDS = {
  One: 'Uno', Two: 'Dos', Three: 'Tres', Four: 'Cuatro', Five: 'Cinco',
};

/**
 * Translates a batch CSV by mapping known English words in the last column.
 */
function translateCsv(csv) {
  const lines = csv.trim().split('\n');
  const translated = lines.map((line, index) => {
    if (index === 0) return line;
    let out = line;
    for (const [en, es] of Object.entries(WORDS)) {
      out = out.replace(new RegExp(`,${en}$`), `,${es}`);
    }
    return out;
  });
  return translated.join('\n');
}

// ============================================================================
// FIXTURES
// ============================================================================

function makeSourceCsv(dir, rows = 5) {
  const header = '"id","source","note","meaning","es","__content_format"';
  const names = ['One', 'Two', 'Three', 'Four', 'Five'];
  const lines = [header];
  for (let i = 0; i < rows; i++) {
    const word = names[i % names.length];
    lines.push(`"id.${i + 1}","${word}","","","${word}","xliff-fragment-v1"`);
  }
  return writeFixture(dir, 'messages.csv', lines.join('\n') + '\n');
}

const llmConfig = baseURL => ({
  baseURL,
  apiKey: 'test-key',
  model: 'test-model',
  concurrency: 2,
});

// ============================================================================
// TESTS
// ============================================================================

test('splitBatches creates batches, reports records and removes stale files', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 5);

  const result = await splitBatches(csvPath, 2, join(dir, 'batches'));

  assert.equal(result.batchCount, 3);
  assert.equal(result.recordCount, 5);
  assert.ok(existsSync(join(dir, 'batches/pending/batch-3.csv')));

  // Simulate leftovers from a bigger previous run
  writeFileSync(join(dir, 'batches/pending/batch-9.csv'), 'stale');
  mkdirSync(join(dir, 'batches/translated/es'), { recursive: true });
  writeFileSync(join(dir, 'batches/translated/es/batch-7.csv'), 'stale');
  registerArtifacts([join(dir, 'batches/pending/batch-9.csv'), join(dir, 'batches/translated/es/batch-7.csv')], { projectRoot: dir });
  writeFileSync(join(dir, 'batches/translated/es/batch-99.csv'), 'foreign');

  const second = await splitBatches(csvPath, 2, join(dir, 'batches'));
  assert.equal(second.removedStale.length, 2);
  assert.ok(!existsSync(join(dir, 'batches/pending/batch-9.csv')));
  assert.ok(!existsSync(join(dir, 'batches/translated/es/batch-7.csv')));
  assert.ok(existsSync(join(dir, 'batches/translated/es/batch-99.csv')), 'foreign numbered files are not deleted');
});

test('runBatches translates correctly, then skips without force', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 5);
  const batchDir = join(dir, 'batches');

  await splitBatches(csvPath, 2, batchDir);

  const mock = await startMockLLM(translateCsv);
  try {
    const first = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 2 });
    assert.deepEqual(
      { processed: first.processed, skipped: first.skipped, failed: first.failed },
      { processed: 3, skipped: 0, failed: 0 }
    );
    assert.equal(mock.calls(), 3);

    // Translations matched by id
    const batch1 = readFileSync(join(batchDir, 'translated/es/batch-1.csv'), 'utf-8');
    assert.ok(batch1.includes('id.1,One,,,Uno'));
    assert.ok(batch1.includes('id.2,Two,,,Dos'));

    // Second run: everything skipped, no extra API calls
    const second = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 2 });
    assert.deepEqual(
      { processed: second.processed, skipped: second.skipped, failed: second.failed },
      { processed: 0, skipped: 3, failed: 0 }
    );
    assert.equal(mock.calls(), 3);

    // Force re-translates
    const third = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 2, force: true });
    assert.equal(third.processed, 3);
    assert.equal(mock.calls(), 6);
  } finally {
    await mock.close();
  }
});

test('runBatches fails a batch when the LLM drops rows (no cross-assignment)', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 5);
  const batchDir = join(dir, 'batches');

  await splitBatches(csvPath, 3, batchDir); // batch-1: 3 rows, batch-2: 2 rows

  const dropFirstRow = (csv) => {
    const lines = csv.trim().split('\n');
    return [lines[0], ...lines.slice(2)].join('\n');
  };

  const mock = await startMockLLM(dropFirstRow);
  try {
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1, maxRetries: 0 });

    assert.equal(summary.failed, 2);
    assert.equal(summary.processed, 0);
    assert.ok(summary.errors.every(e => e.error.includes('missing')));

    // Nothing corrupted was written
    assert.ok(!existsSync(join(batchDir, 'translated/es/batch-1.csv')));
    assert.ok(!existsSync(join(batchDir, 'translated/es/batch-2.csv')));
  } finally {
    await mock.close();
  }
});

test('runBatches accepts identical text and reports warnings', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 3);
  const batchDir = join(dir, 'batches');

  await splitBatches(csvPath, 5, batchDir);

  const mock = await startMockLLM(csv => csv); // identity = no translation
  try {
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1, maxRetries: 0 });

    assert.equal(summary.processed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.warnings.length, 3);
    assert.ok(existsSync(join(batchDir, 'translated/es/batch-1.csv')));
  } finally {
    await mock.close();
  }
});

test('mergeBatches merges translations and reports missing records', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 5);
  const batchDir = join(dir, 'batches');

  await splitBatches(csvPath, 3, batchDir);

  // Translate only batch-1 (ids 1..3); batch-2 stays untranslated
  const mock = await startMockLLM((csv) => {
    if (csv.includes('id.4')) throw new Error('refuse batch 2');
    return translateCsv(csv);
  });
  try {
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1, maxRetries: 0 });
    assert.equal(summary.failed, 1);
  } finally {
    await mock.close();
  }

  const result = await mergeBatches(csvPath, batchDir);

  assert.ok(existsSync(result.outputFile));
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].lang, 'es');
  assert.deepEqual(result.missing[0].ids, ['id.4', 'id.5']);

  const merged = readFileSync(result.outputFile, 'utf-8');
  assert.ok(merged.includes('id.1,One,,,Uno'));
  assert.ok(merged.includes('id.4,Four,,,,xliff-fragment-v1'), 'missing targets stay empty');
});

test('mergeBatches fails clearly when there is nothing to merge', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 3);

  await assert.rejects(
    () => mergeBatches(csvPath, join(dir, 'batches')),
    /No translated batches/
  );
});

test('splitBatches requires format marker and removes all numbered caches for empty input', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 1, batchDir);
  writeFixture(dir, 'batches/translated/es/batch-1.csv', 'stale');
  writeFixture(dir, 'batches/translated/es/batch-1.csv.meta.json', '{}');
  writeFixture(dir, 'batches/translated/es/keep.txt', 'keep');
  registerArtifacts([join(batchDir, 'translated/es/batch-1.csv'), join(batchDir, 'translated/es/batch-1.csv.meta.json')], { projectRoot: dir });
  writeFileSync(csvPath, 'id,source,es,__content_format\n');
  const result = await splitBatches(csvPath, 1, batchDir);
  assert.equal(result.batchCount, 0);
  assert.equal(result.removedStale.length, 4);
  assert.ok(existsSync(join(batchDir, 'translated/es/keep.txt')));
  writeFileSync(csvPath, 'id,source,es\na,Hello,Hello\n');
  await assert.rejects(splitBatches(csvPath, 1, batchDir), /format/i);
});

test('runBatches projection omits marker and reordered rows preserve original context', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 3);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 3, batchDir);
  const mock = await startMockLLM(csv => {
    assert.ok(!csv.includes('__content_format'));
    const records = parse(translateCsv(csv), { columns: true });
    return stringify(records.reverse(), { header: true, columns: ['id', 'source', 'note', 'meaning', 'es'] });
  });
  try {
    assert.equal((await runBatches(batchDir, 'es', llmConfig(mock.baseURL))).processed, 1);
    const records = parse(readFileSync(join(batchDir, 'translated/es/batch-1.csv'), 'utf8'), { columns: true });
    assert.deepEqual(records.map(record => record.id), ['id.1', 'id.2', 'id.3']);
    assert.deepEqual(records.map(record => record.source), ['One', 'Two', 'Three']);
    assert.ok(records.every(record => record.__content_format === 'xliff-fragment-v1'));
  } finally { await mock.close(); }
});

test('caches require metadata, intact output, current inputs and model context, but not apiKey', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  const mock = await startMockLLM(translateCsv);
  const config = llmConfig(mock.baseURL);
  const output = join(batchDir, 'translated/es/batch-1.csv');
  try {
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1);
    assert.ok(!readFileSync(`${output}.meta.json`, 'utf8').includes('test-key'));
    assert.equal((await runBatches(batchDir, 'es', { ...config, apiKey: 'different-test-key' })).skipped, 1);
    unlinkSync(`${output}.meta.json`);
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1, 'legacy CSV alone is not reusable');
    writeFileSync(output, 'corrupt');
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1, 'corrupt CSV is not reusable');
    assert.equal((await runBatches(batchDir, 'es', { ...config, model: 'new-model' })).processed, 1);
    assert.equal((await runBatches(batchDir, 'es', { ...config, systemPrompt: 'Translate faithfully.' })).processed, 1);
    const extraConfig = { ...config, requestExtra: { temperature: 0, thinking: { type: 'disabled' } } };
    assert.equal((await runBatches(batchDir, 'es', extraConfig)).processed, 1);
    assert.equal((await runBatches(batchDir, 'es', { ...config, requestExtra: { thinking: { type: 'disabled' }, temperature: 0 } })).skipped, 1, 'object key order does not invalidate cache');
    writeFileSync(csvPath, readFileSync(csvPath, 'utf8').replaceAll('One', 'Five'));
    await splitBatches(csvPath, 2, batchDir);
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1, 'modified pending invalidates fingerprint');
    const merged = await mergeBatches(csvPath, batchDir, { llm: config });
    assert.ok(readFileSync(merged.outputFile, 'utf8').includes('id.1,Five,,,Cinco'));
  } finally { await mock.close(); }
});

test('failed force run invalidates previous result and cannot merge stale translation', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  let fail = false;
  const mock = await startMockLLM(csv => fail ? 'id,source,note,meaning,es\n' : translateCsv(csv));
  try {
    const config = llmConfig(mock.baseURL);
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1);
    fail = true;
    assert.equal((await runBatches(batchDir, 'es', config, { force: true, maxRetries: 0 })).failed, 1);
    await assert.rejects(mergeBatches(csvPath, batchDir, { llm: config }), /metadata/);
    fail = false;
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1);
  } finally { await mock.close(); }
});

test('merge refuses corrupt batches, stale current source, metadata paths and configuration', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  const mock = await startMockLLM(translateCsv);
  try {
    const config = llmConfig(mock.baseURL);
    await runBatches(batchDir, 'es', config);
    await assert.rejects(mergeBatches(csvPath, batchDir, { llm: { ...config, model: 'different' } }), /fingerprint/);
    writeFileSync(csvPath, readFileSync(csvPath, 'utf8').replaceAll('One', 'Five'));
    await assert.rejects(mergeBatches(csvPath, batchDir), /context changed/);
    makeSourceCsv(dir, 2);
    const output = join(batchDir, 'translated/es/batch-1.csv');
    const metadata = JSON.parse(readFileSync(`${output}.meta.json`, 'utf8'));
    writeFileSync(`${output}.meta.json`, JSON.stringify({ ...metadata, outputPath: join(dir, 'outside.csv') }));
    await assert.rejects(mergeBatches(csvPath, batchDir), /metadata identity/);
    writeFileSync(`${output}.meta.json`, JSON.stringify(metadata));
    writeFileSync(output, 'broken csv');
    await assert.rejects(mergeBatches(csvPath, batchDir), /digest/);
  } finally { await mock.close(); }
});

test('merge expects absent languages and counts identical targets as present', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  const mock = await startMockLLM(csv => csv);
  try {
    await runBatches(batchDir, 'es', llmConfig(mock.baseURL));
    const result = await mergeBatches(csvPath, batchDir, { languages: ['es', 'fr'] });
    assert.deepEqual(result.missing, [{ lang: 'fr', ids: ['id.1', 'id.2'] }]);
    const records = parse(readFileSync(result.outputFile, 'utf8'), { columns: true });
    assert.ok(records.every(record => record.fr === '' && record.es === record.source));
  } finally { await mock.close(); }
});

test('merge reports invalid language batches without discarding other valid languages', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  let fail = false;
  const mock = await startMockLLM(csv => {
    if (fail) return csv.split('\n')[0];
    const records = parse(csv, { columns: true });
    const target = Object.keys(records[0]).at(-1);
    for (const record of records) record[target] = record.source;
    return stringify(records, { header: true });
  });
  try {
    const config = llmConfig(mock.baseURL);
    assert.equal((await runBatches(batchDir, 'es', config)).processed, 1);
    assert.equal((await runBatches(batchDir, 'fr', config)).processed, 1);
    fail = true;
    assert.equal((await runBatches(batchDir, 'fr', config, { force: true, maxRetries: 0 })).failed, 1);
    const result = await mergeBatches(csvPath, batchDir, { languages: ['es', 'fr'], llm: config });
    assert.deepEqual(result.missing, [{ lang: 'fr', ids: ['id.1', 'id.2'] }]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].lang, 'fr');
    assert.match(result.errors[0].error, /metadata/);
    const records = parse(readFileSync(result.outputFile, 'utf8'), { columns: true });
    assert.ok(records.every(record => record.fr === '' && record.es === record.source));
  } finally { await mock.close(); }
});

test('empty split validates unsafe destinations before creating or deleting files', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 0);
  await assert.rejects(splitBatches(csvPath, 2, join(dir, 'src'), { projectRoot: dir }), /Protected project path/);
  assert.ok(!existsSync(join(dir, 'src/pending')));
});

test('merge rejects batch IDs outside the current source and old caches without metadata', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 2);
  const batchDir = join(dir, 'batches');
  await splitBatches(csvPath, 2, batchDir);
  const mock = await startMockLLM(translateCsv);
  try {
    await runBatches(batchDir, 'es', llmConfig(mock.baseURL));
    makeSourceCsv(dir, 1);
    await assert.rejects(mergeBatches(csvPath, batchDir), /outside current source/);
    makeSourceCsv(dir, 2);
    unlinkSync(join(batchDir, 'translated/es/batch-1.csv.meta.json'));
    await assert.rejects(mergeBatches(csvPath, batchDir), /ENOENT/);
  } finally { await mock.close(); }
});

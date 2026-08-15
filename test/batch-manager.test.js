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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { splitBatches, runBatches, mergeBatches } from '../src/batch-manager.js';
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
  const header = '"id","source","note","meaning","es"';
  const names = ['One', 'Two', 'Three', 'Four', 'Five'];
  const lines = [header];
  for (let i = 0; i < rows; i++) {
    const word = names[i % names.length];
    lines.push(`"id.${i + 1}","${word}","","","${word}"`);
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

  const second = await splitBatches(csvPath, 2, join(dir, 'batches'));
  assert.equal(second.removedStale.length, 2);
  assert.ok(!existsSync(join(dir, 'batches/pending/batch-9.csv')));
  assert.ok(!existsSync(join(dir, 'batches/translated/es/batch-7.csv')));
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
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1 });

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

test('runBatches fails a batch when the LLM returns the text untranslated', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 3);
  const batchDir = join(dir, 'batches');

  await splitBatches(csvPath, 5, batchDir);

  const mock = await startMockLLM(csv => csv); // identity = no translation
  try {
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1 });

    assert.equal(summary.failed, 1);
    assert.ok(summary.errors[0].error.includes('Translation validation failed'));
    assert.ok(!existsSync(join(batchDir, 'translated/es/batch-1.csv')));
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
    const summary = await runBatches(batchDir, 'es', llmConfig(mock.baseURL), { concurrency: 1 });
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
  assert.ok(merged.includes('id.4,Four,,,Four'), 'untranslated rows keep source text');
});

test('mergeBatches fails clearly when there is nothing to merge', async () => {
  const dir = makeTempDir();
  const csvPath = makeSourceCsv(dir, 3);

  await assert.rejects(
    () => mergeBatches(csvPath, join(dir, 'batches')),
    /Translated batches directory not found/
  );
});

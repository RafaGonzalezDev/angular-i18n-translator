/**
 * End-to-end CLI tests against synthetic fixtures and a local mock API.
 * I18N_CONFIG_PATH isolates configuration; no real provider or API key is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { parseCsvRecords, CONTENT_FORMAT, FORMAT_COLUMN } from '../src/csv-records.js';
import { stringify } from 'csv-stringify/sync';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

import { FIXTURE_XLF, FIXTURE_XLF2, FIXTURE_XLF_BROKEN, makeTempDir, writeFixture, makeConfig } from './helpers.js';

const CLI_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));

/**
 * Runs the CLI in a working directory with an isolated config file.
 */
function runCli(args, cwd, configObj, env = {}) {
  const configPath = join(cwd, 'test.config.json');
  // Literal LLM values: no ${VAR} placeholders, so no .env dependency
  const config = configObj || makeConfig({ baseURL: 'http://127.0.0.1:9' });
  writeFixture(cwd, 'test.config.json', JSON.stringify(config, null, 2));

  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, I18N_CONFIG_PATH: configPath, ...env },
  });
  if (result.error) throw new Error(`Cannot start CLI: ${result.error.message}`, { cause: result.error });
  return result;
}

/** Async spawning keeps the in-process mock HTTP server responsive. */
function runCliAsync(args, cwd, configObj, env = {}) {
  const configPath = writeFixture(cwd, 'test.config.json', JSON.stringify(configObj, null, 2));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, I18N_CONFIG_PATH: configPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`CLI timed out after 30000ms: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, 30000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(new Error(`Cannot start CLI: ${error.message}`, { cause: error })));
    child.once('close', (status, signal) => finish(null, { status, signal, stdout, stderr }));
  });
}

function writeCanonicalCsv(dir, name, records, languages = ['es']) {
  const columns = ['id', 'source', 'note', 'meaning', FORMAT_COLUMN, ...languages];
  const formatted = records.map(record => ({ note: '', meaning: '', [FORMAT_COLUMN]: CONTENT_FORMAT, ...record }));
  return writeFixture(dir, name, stringify(formatted, { header: true, columns }));
}

async function startLocalLLM(t, translate) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.url, '/chat/completions');
        const payload = JSON.parse(body);
        const prompt = payload.messages.find(message => message.role === 'user').content;
        const csv = prompt.split('\n\n').slice(1).join('\n\n');
        const parsed = parseCsvRecords(csv);
        assert.ok(!parsed.columns.includes(FORMAT_COLUMN), 'projected CSV must omit format marker');
        const language = parsed.columns.at(-1);
        const output = translate(parsed, language);
        if (output === null) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Mock request rejected for this language' } }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('CLI reports the package version', () => {
  const dir = makeTempDir();
  const result = runCli(['--version'], dir);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'));
  assert.equal(result.stdout.trim(), pkg.version);
});

test('full pipeline without LLM: xlf-to-csv, split, manual translation, csv-to-xlf, validate', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);

  // Step 1: XLF -> CSV
  let result = runCli(['xlf-to-csv'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, 'messages.csv')));

  // Step 2: split
  result = runCli(['translate-split'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, 'batches/pending/batch-1.csv')));

  // Step 3: simulate a manual translation of the CSV (human edits the file)
  const parsed = parseCsvRecords(readFileSync(join(dir, 'messages.csv'), 'utf-8'), { requireFormat: true });
  for (const record of parsed.records) {
    record.es = record.source.replace('Hello world', 'Hola mundo').replace('Hello, ', 'Hola, ')
      .replace('Tom &amp; Jerry &lt;3 "quotes"', 'Tom y Jerry &lt;3 "comillas"');
  }
  writeFixture(dir, 'messages.translated.csv', stringify(parsed.records, { columns: parsed.columns, header: true }));

  // Step 4: CSV -> XLF
  result = runCli(['csv-to-xlf'], dir);
  assert.equal(result.status, 0, result.stderr);

  const xlf = readFileSync(join(dir, 'dist-i18n/messages.es.xlf'), 'utf-8');
  assert.ok(xlf.includes('<target>Hola mundo</target>'));
  // Inline placeholders must survive the whole CLI pipeline
  assert.ok(xlf.includes('<x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>'));
  assert.ok(!xlf.includes('&lt;x id='), 'placeholders must not be escaped to text');
  // Free text must be escaped
  assert.ok(xlf.includes('<target>Tom y Jerry &lt;3 "comillas"</target>'));

  // Step 5: validate the translated CSV
  result = runCli(['validate', '--quiet'], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('xlf-to-csv exits 1 with a clear error for XLIFF 2.0', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF2);

  const result = runCli(['xlf-to-csv'], dir);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /XLIFF 2\.0/);
});

test('xlf-to-csv exits 1 with a clear error for malformed XML', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF_BROKEN);

  const result = runCli(['xlf-to-csv'], dir);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Invalid XML/);
});

test('xlf-to-csv exits 1 when the XLF file is missing', () => {
  const dir = makeTempDir();
  const result = runCli(['xlf-to-csv'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /not found/);
  assert.match(result.stdout + result.stderr, /ng extract-i18n/);
});

test('translate-merge exits 1 with an actionable message when nothing was translated', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);

  let result = runCli(['xlf-to-csv'], dir);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(['translate-split'], dir);
  assert.equal(result.status, 0, result.stderr);

  result = runCli(['translate-merge'], dir);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /No translated batches/);
  assert.match(result.stdout + result.stderr, /translate:run/);
});

test('csv-to-xlf exits 1 with a hint when the translated CSV does not exist', () => {
  const dir = makeTempDir();
  const result = runCli(['csv-to-xlf'], dir);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Translated CSV not found/);
  assert.match(result.stdout + result.stderr, /npm run translate/);
});

test('validate exits 1 with a hint when the CSV does not exist', () => {
  const dir = makeTempDir();
  const result = runCli(['validate'], dir);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /--file|npm run translate/);
});

test('the translate command is registered (with translate-all alias)', () => {
  const dir = makeTempDir();
  const result = runCli(['--help'], dir);
  assert.match(result.stdout, /translate.*Run the full translation pipeline/);
  assert.match(result.stdout, /translate-all/);
});

test('clean removes generated artifacts', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);

  let result = runCli(['xlf-to-csv'], dir);
  assert.equal(result.status, 0);
  result = runCli(['translate-split'], dir);
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(dir, 'messages.csv')));
  assert.ok(existsSync(join(dir, 'batches/pending/batch-1.csv')));

  result = runCli(['clean'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(dir, 'messages.csv')));
  assert.ok(!existsSync(join(dir, 'batches/pending/batch-1.csv')));

  // Cleaning again is a no-op, not an error, and creates no directories
  result = runCli(['clean'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(dir, 'batches/pending')));
});

test('init rejects non-file secret destinations before requesting credentials', () => {
  const dir = makeTempDir();
  writeFixture(dir, '.env/sentinel', 'untouched');
  const result = runCli(['init'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regular file/);
  assert.equal(readFileSync(join(dir, '.env/sentinel'), 'utf8'), 'untouched');
  assert.ok(!existsSync(join(dir, 'i18n.config.json')));
});

test('unknown command exits 1', () => {
  const dir = makeTempDir();
  const result = runCli(['nonexistent-command'], dir);
  assert.equal(result.status, 1);
});

test('validate defaults to translated CSV, while --file explicitly selects the original', () => {
  const dir = makeTempDir();
  writeCanonicalCsv(dir, 'messages.csv', [{ id: 'a', source: 'Hello', es: 'Hola' }]);
  writeCanonicalCsv(dir, 'messages.translated.csv', [{ id: 'a', source: 'Hello', es: '' }]);
  const invalid = runCli(['validate'], dir);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout + invalid.stderr, /Missing translation/);
  const original = runCli(['validate', '--file', 'messages.csv'], dir);
  assert.equal(original.status, 0, original.stdout + original.stderr);
  assert.match(original.stdout, /Validation passed/);
});

test('validate --strict rejects identical-source warnings without rejecting them by default', () => {
  const dir = makeTempDir();
  writeCanonicalCsv(dir, 'messages.csv', [{ id: 'a', source: 'Brand', es: 'Brand' }]);
  const normal = runCli(['validate', '--file', 'messages.csv'], dir);
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.match(normal.stdout, /identical to source/);
  const strict = runCli(['validate', '--file', 'messages.csv', '--strict'], dir);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /Validation failed/);
});

test('--quiet suppresses command output and spinner control sequences', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  for (const args of [['--quiet', 'xlf-to-csv'], ['--quiet', 'translate-split']]) {
    const result = runCli(args, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  writeCanonicalCsv(dir, 'messages.translated.csv', [{ id: 'a', source: 'Hello', es: 'Hola' }]);
  for (const args of [['--quiet', 'validate'], ['--quiet', 'clean', '--dry-run']]) {
    const result = runCli(args, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('clean --dry-run preserves registered artifacts, source and foreign files', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  assert.equal(runCli(['xlf-to-csv'], dir).status, 0);
  assert.equal(runCli(['translate-split'], dir).status, 0);
  const paths = ['messages.xlf', 'messages.csv', 'batches/pending/batch-1.csv', '.i18n-artifacts.json', 'test.config.json'];
  writeFixture(dir, 'dist-i18n/foreign.txt', 'foreign-output');
  writeFixture(dir, 'batches/translated/es/batch-99.csv', 'foreign-batch');
  paths.push('dist-i18n/foreign.txt', 'batches/translated/es/batch-99.csv');
  const before = new Map(paths.map(path => [path, readFileSync(join(dir, path), 'utf8')]));
  const result = runCli(['clean', '--dry-run'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would remove:.*messages\.csv/);
  assert.ok(!result.stdout.includes('Would remove: ' + join(dir, 'dist-i18n/foreign.txt')));
  assert.ok(!result.stdout.includes('Would remove: ' + join(dir, 'messages.xlf')));
  for (const [path, content] of before) assert.equal(readFileSync(join(dir, path), 'utf8'), content, path);
});

test('clean without an ownership manifest preserves generated-looking files', () => {
  const dir = makeTempDir();
  const paths = ['messages.xlf', 'messages.csv', 'messages.translated.csv', 'batches/pending/batch-1.csv', 'dist-i18n/messages.es.xlf', 'dist-i18n/foreign.txt'];
  for (const path of paths) writeFixture(dir, path, `sentinel:${path}`);
  for (const args of [['clean', '--dry-run'], ['clean']]) {
    const result = runCli(args, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /No artifact manifest/);
    for (const path of paths) assert.equal(readFileSync(join(dir, path), 'utf8'), `sentinel:${path}`);
  }
});

test('clean rejects outputDir root without touching sentinel files', () => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  writeFixture(dir, 'sentinel.txt', 'must-survive');
  writeFixture(dir, 'batches/pending/batch-1.csv', 'must-survive-batch');
  const config = { ...makeConfig({ baseURL: 'http://127.0.0.1:9' }), outputDir: '.' };
  const result = runCli(['clean'], dir, config);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /outputDir|non-root|protected/);
  assert.equal(readFileSync(join(dir, 'sentinel.txt'), 'utf8'), 'must-survive');
  assert.equal(readFileSync(join(dir, 'batches/pending/batch-1.csv'), 'utf8'), 'must-survive-batch');
  assert.equal(readFileSync(join(dir, 'messages.xlf'), 'utf8'), FIXTURE_XLF);
});

test('translate exports a valid language after another language fails and preserves its old output', async t => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  const oldFrench = 'old-french-output-sentinel';
  writeFixture(dir, 'dist-i18n/messages.fr.xlf', oldFrench);
  const calls = { es: 0, fr: 0 };
  const baseURL = await startLocalLLM(t, (parsed, language) => {
    calls[language]++;
    if (language === 'fr') return null;
    assert.equal(language, 'es');
    for (const record of parsed.records) {
      record.es = record.source.replace('Hello world', 'Hola mundo').replace('Hello, ', 'Hola, ');
    }
    return stringify(parsed.records, { header: true, columns: parsed.columns });
  });
  const config = makeConfig({ baseURL, languages: ['en', 'es', 'fr'] });
  const result = await runCliAsync(['translate'], dir, config);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(calls.es, 1);
  assert.equal(calls.fr, 1, 'HTTP400 must not retry');
  const spanish = readFileSync(join(dir, 'dist-i18n/messages.es.xlf'), 'utf8');
  assert.match(spanish, /<target>Hola mundo<\/target>/);
  assert.ok(spanish.includes('<x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>'));
  assert.equal(readFileSync(join(dir, 'dist-i18n/messages.fr.xlf'), 'utf8'), oldFrench);
  assert.match(result.stdout, /Exported 1\/2 languages/);
  assert.match(result.stderr, /Not exported: fr/);
  assert.match(result.stderr, /old outputs, not results of this run/);
  assert.ok(!result.stdout.includes('All steps completed successfully'));
  const merged = parseCsvRecords(readFileSync(join(dir, 'messages.translated.csv'), 'utf8'), { requireFormat: true });
  assert.ok(merged.records.every(record => record.fr === ''));
  const original = parseCsvRecords(readFileSync(join(dir, 'messages.csv'), 'utf8'), { requireFormat: true });
  assert.deepEqual(merged.records.map(record => record.source), original.records.map(record => record.source));
  assert.ok(!existsSync(join(dir, 'dist-i18n/messages.en.xlf')));
});

test('translate --force failure excludes previous cached translations from merge', async t => {
  const dir = makeTempDir();
  writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  let rejectSpanish = false;
  const baseURL = await startLocalLLM(t, (parsed, language) => {
    if (language === 'es' && rejectSpanish) return null;
    for (const record of parsed.records) record[language] = record.source.replace('Hello world', language === 'es' ? 'Hola mundo' : 'Bonjour monde');
    return stringify(parsed.records, { header: true, columns: parsed.columns });
  });
  const config = makeConfig({ baseURL, languages: ['en', 'es', 'fr'] });
  const first = await runCliAsync(['translate'], dir, config);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const oldSpanish = readFileSync(join(dir, 'dist-i18n/messages.es.xlf'), 'utf8');
  rejectSpanish = true;
  const forced = await runCliAsync(['translate', '--force'], dir, config);
  assert.equal(forced.status, 1, forced.stdout + forced.stderr);
  assert.match(forced.stderr, /Not exported: es/);
  assert.equal(readFileSync(join(dir, 'dist-i18n/messages.es.xlf'), 'utf8'), oldSpanish);
  const merged = parseCsvRecords(readFileSync(join(dir, 'messages.translated.csv'), 'utf8'), { requireFormat: true });
  assert.ok(merged.records.every(record => record.es === '' && record.fr !== ''));
  assert.match(readFileSync(join(dir, 'dist-i18n/messages.fr.xlf'), 'utf8'), /Bonjour monde/);
});

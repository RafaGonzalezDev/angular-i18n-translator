/**
 * End-to-end CLI tests (no network): spawns the real CLI against synthetic
 * fixtures using I18N_CONFIG_PATH to isolate configuration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

import { FIXTURE_XLF, FIXTURE_XLF2, FIXTURE_XLF_BROKEN, makeTempDir, writeFixture, makeConfig } from './helpers.js';

const CLI_PATH = resolve(new URL('..', import.meta.url).pathname, 'src/index.js');

/**
 * Runs the CLI in a working directory with an isolated config file.
 */
function runCli(args, cwd, configObj, env = {}) {
  const configPath = join(cwd, 'test.config.json');
  // Literal LLM values: no ${VAR} placeholders, so no .env dependency
  const config = configObj || makeConfig({ baseURL: 'http://127.0.0.1:9' });
  writeFixture(cwd, 'test.config.json', JSON.stringify(config, null, 2));

  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, I18N_CONFIG_PATH: configPath, ...env },
  });
}

test('CLI reports the package version', () => {
  const dir = makeTempDir();
  const result = runCli(['--version'], dir);
  const pkg = JSON.parse(readFileSync(resolve(new URL('..', import.meta.url).pathname, 'package.json'), 'utf-8'));
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
  const csv = readFileSync(join(dir, 'messages.csv'), 'utf-8');
  const translated = csv
    .replaceAll('Hello world', 'Hola mundo')
    .replace(/Hello, /g, 'Hola, ')
    .replaceAll('Tom & Jerry <3 ""quotes""', 'Tom y Jerry <3 ""comillas""');
  writeFixture(dir, 'messages.translated.csv', translated);

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

test('unknown command exits 1', () => {
  const dir = makeTempDir();
  const result = runCli(['nonexistent-command'], dir);
  assert.equal(result.status, 1);
});

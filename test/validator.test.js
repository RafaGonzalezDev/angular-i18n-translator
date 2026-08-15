/**
 * Tests for src/validator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';

import { validateInterpolations, validateUniqueIds, validateCoverage, validate } from '../src/validator.js';
import { makeTempDir, writeFixture } from './helpers.js';

function makeCsv(dir, rows) {
  const header = '"id","source","note","meaning","es"';
  const lines = [header, ...rows.map(r =>
    `"${r.id}","${(r.source || '').replace(/"/g, '""')}","","","${(r.es || '').replace(/"/g, '""')}"`
  )];
  return writeFixture(dir, 'messages.csv', lines.join('\n') + '\n');
}

test('detects missing and extra interpolations', () => {
  const dir = makeTempDir();
  const csv = makeCsv(dir, [
    { id: 'missing', source: 'You have {{count}} items in {{place}}', es: 'Tienes artículos' },
    { id: 'extra', source: 'Simple text', es: 'Texto {{invented}}' },
    { id: 'ok', source: 'Hello {{name}}', es: 'Hola {{name}}' },
  ]);

  const { valid, issues } = validateInterpolations(csv, ['es']);

  assert.equal(valid, false);
  const errors = issues.filter(i => i.severity === 'error');
  assert.ok(errors.some(i => i.issue.includes('{{count}}')));
  assert.ok(errors.some(i => i.issue.includes('{{place}}')));
  assert.ok(issues.some(i => i.severity === 'warning' && i.issue.includes('{{invented}}')));
  assert.ok(!issues.some(i => i.id === 'ok'));
});

test('detects lost inline placeholders', () => {
  const dir = makeTempDir();
  const csv = makeCsv(dir, [
    { id: 'ph.lost', source: 'Save <x id="PH" type="fmt"/> now', es: 'Guardar ahora' },
    { id: 'ph.kept', source: 'Save <x id="PH" type="fmt"/> now', es: 'Guardar <x id="PH" type="fmt"/> ahora' },
  ]);

  const { valid, issues } = validateInterpolations(csv, ['es']);

  assert.equal(valid, false);
  assert.equal(issues.length, 1);
  assert.match(issues[0].issue, /Missing placeholder/);
});

test('detects broken ICU structures', () => {
  const dir = makeTempDir();
  const csv = makeCsv(dir, [
    { id: 'icu.lost', source: '{count, plural, =0 {None} other {# items}}', es: 'Artículos' },
    { id: 'icu.unbalanced', source: '{count, plural, =0 {None} other {# items}}', es: '{count, plural, =0 {Ninguno} other {# elementos}' },
    { id: 'icu.ok', source: '{count, plural, =0 {None} other {# items}}', es: '{count, plural, =0 {Ninguno} other {# elementos}}' },
  ]);

  const { valid, issues } = validateInterpolations(csv, ['es']);

  assert.equal(valid, false);
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('icu.lost'));
  assert.ok(ids.includes('icu.unbalanced'));
  assert.ok(!ids.includes('icu.ok'));
});

test('detects duplicate ids', () => {
  const dir = makeTempDir();
  const csv = makeCsv(dir, [
    { id: 'dup', source: 'First', es: 'Primero' },
    { id: 'dup', source: 'Second', es: 'Segundo' },
  ]);

  const { valid, duplicates } = validateUniqueIds(csv);

  assert.equal(valid, false);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].count, 2);
});

test('coverage treats rows identical to source as untranslated', () => {
  const dir = makeTempDir();
  const csv = makeCsv(dir, [
    { id: 'a', source: 'Hello', es: 'Hola' },
    { id: 'b', source: 'Login', es: 'Login' },   // identical to source
    { id: 'c', source: 'Bye', es: '' },           // empty
  ]);

  const coverage = validateCoverage(csv, ['es']);

  assert.equal(coverage.es.total, 3);
  assert.equal(coverage.es.translated, 1);
  assert.equal(coverage.es.identical, 1);
  assert.equal(coverage.es.missing, 2);
  assert.equal(coverage.es.percentage, 33);
  assert.equal(coverage.es.severity, 'error');
});

test('validate exit code reflects errors only', () => {
  const dir = makeTempDir();

  const good = makeCsv(dir, [{ id: 'a', source: 'Hello {{n}}', es: 'Hola {{n}}' }]);
  assert.equal(validate(join(dir, 'messages.csv'), ['es'], { verbose: false }), 0);

  const bad = makeCsv(dir, [{ id: 'a', source: 'Hello {{n}}', es: 'Hola' }]);
  assert.equal(validate(join(dir, 'messages.csv'), ['es'], { verbose: false }), 1);
});

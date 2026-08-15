/**
 * Tests for src/csv-converter.js
 *
 * Covers: placeholder preservation round-trip, XML escaping, strict XML
 * error handling, XLIFF 2.0 rejection, empty file rejection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as csvParseSync } from 'csv-parse/sync';
import { stringify as csvStringifySync } from 'csv-stringify/sync';

import { xlfToCsv, csvToXlf, parseXLFString, generateXLF } from '../src/csv-converter.js';
import { FIXTURE_XLF, FIXTURE_XLF2, FIXTURE_XLF_BROKEN, makeTempDir, writeFixture } from './helpers.js';

test('parseXLFString extracts units with raw inline markup', () => {
  const units = parseXLFString(FIXTURE_XLF);

  assert.equal(units.length, 6);

  const byId = Object.fromEntries(units.map(u => [u.id, u]));
  assert.equal(byId['plain.text'].source, 'Hello world');
  assert.equal(
    byId['interp.simple'].source,
    'Hello, <x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>!'
  );
  // Attribute entities are decoded on parse and re-escaped on serialize
  assert.ok(byId['interp.attr.special'].source.includes('disp="{{a &amp; b}}"'));
  // Text entities are decoded to raw text
  assert.equal(byId['special.chars'].source, 'Tom & Jerry <3 "quotes"');
  assert.equal(byId['icu.plural'].note, 'First note\nSecond note');
  assert.equal(byId['icu.plural'].meaning, 'items count');
});

test('parseXLFString rejects malformed XML', () => {
  assert.throws(() => parseXLFString(FIXTURE_XLF_BROKEN), /Invalid XML/);
});

test('parseXLFString rejects XLIFF 2.0 with a clear message', () => {
  assert.throws(() => parseXLFString(FIXTURE_XLF2), /XLIFF 2\.0.*not supported/);
});

test('parseXLFString rejects documents without translation units', () => {
  const empty = `<?xml version="1.0"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" original="messages"><body></body></file>
</xliff>`;
  assert.throws(() => parseXLFString(empty), /No translation units/);
});

test('xlfToCsv -> csvToXlf round-trip preserves placeholders', () => {
  const dir = makeTempDir();
  const xlfPath = writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  const csvPath = join(dir, 'messages.csv');

  xlfToCsv(xlfPath, csvPath, ['es'], { sourceLanguage: 'en' });

  const csv = readFileSync(csvPath, 'utf-8');
  assert.ok(csv.includes('<x id=""PH""'), 'CSV keeps raw inline markup (CSV-doubled quotes)');
  assert.ok(csv.includes('{count, plural,'), 'CSV keeps ICU text');

  // Simulate a translation that keeps placeholders intact
  const records = csvParseSync(csv, { columns: true });
  const translations = {
    'plain.text': 'Hola mundo',
    'interp.simple': 'Hola, <x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>!',
    'interp.attr.special': 'Valor <x id="PH" equiv="interpolation" type="fmt" disp="{{a &amp; b}}"/> fin',
    'special.chars': 'Tom y Jerry <3 "comillas"',
    'icu.plural': '{count, plural, =0 {Sin elementos} =1 {Un elemento} other {# elementos}}',
    'html.inline': 'Haz clic <g id="0" ctype="link">aquí</g> para continuar',
  };
  for (const record of records) {
    record.es = translations[record.id];
  }
  const translatedCsv = csvStringifySync(records, {
    columns: ['id', 'source', 'note', 'meaning', 'es'],
    header: true,
    quoted_string: true,
  });

  const translatedPath = join(dir, 'messages.translated.csv');
  writeFixture(dir, 'messages.translated.csv', translatedCsv);

  const { files, issues } = csvToXlf(translatedPath, join(dir, 'dist-i18n'), ['es'], {
    sourceLanguage: 'en',
    original: 'messages',
  });

  assert.ok(existsSync(files.es));

  const xlf = readFileSync(files.es, 'utf-8');

  // Placeholders must remain markup, not escaped text
  assert.ok(xlf.includes('<target>Hola, <x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>!</target>'));
  // Free text must be escaped
  assert.ok(xlf.includes('<source>Tom &amp; Jerry &lt;3 "quotes"</source>'));
  // Attribute entities survive the round-trip
  assert.ok(xlf.includes('disp="{{a &amp; b}}"'));
  // ICU preserved
  assert.ok(xlf.includes('{count, plural, =0 {No items}'));
  // No malformed-markup fallbacks expected
  assert.equal(issues.filter(i => i.includes('malformed')).length, 0);
});

test('generateXLF escapes malformed inline markup instead of writing broken XML', () => {
  const dir = makeTempDir();
  const outPath = join(dir, 'out.xlf');

  const { path, issues } = generateXLF(
    [{
      id: 'broken',
      source: 'ok <x id="PH"/> text',
      target: 'mal <x id="PH"> unbalanced',
    }],
    'es',
    outPath
  );

  const xlf = readFileSync(path, 'utf-8');
  // The malformed target must have been fully escaped (safe output)
  assert.ok(xlf.includes('&lt;x id="PH"&gt; unbalanced'));
  // The valid source keeps its placeholder
  assert.ok(xlf.includes('<source>ok <x id="PH"/> text</source>'));
  assert.ok(issues.some(i => i.includes('malformed inline markup')));
});

test('generateXLF falls back to source when target is empty and reports it', () => {
  const dir = makeTempDir();
  const outPath = join(dir, 'out.xlf');

  const { issues } = generateXLF(
    [{ id: 'no.target', source: 'Source text', target: '' }],
    'es',
    outPath
  );

  const xlf = readFileSync(outPath, 'utf-8');
  assert.ok(xlf.includes('<target>Source text</target>'));
  assert.ok(issues.some(i => i.includes('no translation')));
});

test('csvToXlf honors custom file names per language', () => {
  const dir = makeTempDir();
  const xlfPath = writeFixture(dir, 'messages.xlf', FIXTURE_XLF);
  const csvPath = join(dir, 'messages.csv');

  xlfToCsv(xlfPath, csvPath, ['es'], { sourceLanguage: 'en' });

  const { files } = csvToXlf(csvPath, join(dir, 'dist-i18n'), ['es'], {
    fileNames: { es: 'custom.es.xlf' },
  });

  assert.ok(files.es.endsWith('custom.es.xlf'));
  assert.ok(existsSync(files.es));
});

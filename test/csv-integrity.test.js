import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { makeTempDir, writeFixture } from './helpers.js';
import { parseXLFString, generateXLF, csvToXlf } from '../src/csv-converter.js';
import { validateAll, validate } from '../src/validator.js';
import { CONTENT_FORMAT, FORMAT_COLUMN, parseCsvRecords } from '../src/csv-records.js';

const canonical = records => stringify(records.map(row => ({ ...row, [FORMAT_COLUMN]: CONTENT_FORMAT })), { header: true });
const xlf = body => `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en" original="messages"><body>${body}</body></file></xliff>`;

test('literal tags and CDATA preserve characters without creating placeholders', () => {
  const input = xlf('<trans-unit id="a"><source>Show &lt;x id="FAKE"/&gt;</source></trans-unit><trans-unit id="b"><source><![CDATA[Hello <world> & all]]></source></trans-unit>');
  const units = parseXLFString(input);
  assert.equal(units[0].source, 'Show &lt;x id="FAKE"/&gt;');
  assert.equal(units[1].source, 'Hello &lt;world&gt; &amp; all');
  const dir = makeTempDir();
  const { path } = generateXLF(units.map(unit => ({ ...unit, target: unit.source })), 'es', join(dir, 'out.xlf'));
  const output = readFileSync(path, 'utf8');
  assert.ok(!output.includes('<x id="FAKE"/>'));
  assert.deepEqual(parseXLFString(output).map(unit => unit.source), units.map(unit => unit.source));
});

test('XLF IDs cannot be omitted or duplicated and Angular meaning notes are separate', () => {
  for (const body of ['<trans-unit><source>Text</source></trans-unit>', '<trans-unit id="a"><source>A</source></trans-unit><trans-unit id="a"><source>B</source></trans-unit>']) {
    assert.throws(() => parseXLFString(xlf(body)), /id/i);
  }
  const [unit] = parseXLFString(xlf('<trans-unit id="a"><source>Text</source><note from="meaning">button</note><note from="description">click</note></trans-unit>'));
  assert.equal(unit.meaning, 'button');
  assert.equal(unit.note, 'click');
});

test('CSV BOM, prototype-looking IDs and multiline physical positions work', () => {
  const dir = makeTempDir();
  const content = '\uFEFF' + canonical([{ id: 'toString', source: 'Hello\nthere', es: 'Hola\nahí' }, { id: '__proto__', source: '{{name}}', es: 'Hola' }, { id: 'constructor', source: 'OK', es: 'OK' }]);
  const path = writeFixture(dir, 'bom.csv', content);
  const report = validateAll(path, ['es']);
  assert.equal(report.validations.uniqueIds.valid, true);
  assert.equal(report.summary.allValid, false);
  // The first record spans three physical lines (multiline source and target).
  assert.equal(report.issues.find(issue => issue.id === '__proto__').line, 5);
  assert.ok(report.summary.errors > 0);
  const good = writeFixture(dir, 'good.csv', '\uFEFF' + canonical([{ id: 'toString', source: 'Hello', es: 'Hola' }]));
  assert.ok(existsSync(csvToXlf(good, join(dir, 'dist'), ['es']).files.es));
});

test('CSV rejects missing/duplicate headers, blank IDs and legacy/mixed formats', () => {
  assert.throws(() => parseCsvRecords('id,source,es,es\na,A,B,C\n'), /unique/);
  assert.throws(() => parseCsvRecords('source,es\nA,B\n'), /Missing required/);
  const dir = makeTempDir();
  const legacy = writeFixture(dir, 'legacy.csv', 'id,source,es\na,A,B\n');
  assert.throws(() => csvToXlf(legacy, join(dir, 'dist'), ['es']), /Legacy CSV/);
  const emptyId = writeFixture(dir, 'blank.csv', canonical([{ id: '', source: 'A', es: 'B' }]));
  assert.equal(validate(emptyId, ['es']), 1);
  assert.throws(() => csvToXlf(emptyId, join(dir, 'dist'), ['es']), /Missing id/);
  const mixed = writeFixture(dir, 'mixed.csv', 'id,source,es,__content_format\na,A,B,unknown\n');
  assert.equal(validateAll(mixed, ['es']).summary.errors, 1);
});

test('missing targets/columns fail, identical targets warn and strict escalates', () => {
  const dir = makeTempDir();
  const missing = writeFixture(dir, 'missing.csv', canonical([{ id: 'a', source: 'Hi', es: '' }]));
  const report = validateAll(missing, ['es']);
  assert.equal(report.validations.coverage.es.missing, 1);
  assert.equal(report.summary.allValid, false);
  assert.equal(validate(missing, ['es']), 1);
  const same = writeFixture(dir, 'same.csv', canonical([{ id: 'a', source: 'OK', es: 'OK' }]));
  assert.equal(validate(same, ['es']), 0);
  assert.equal(validate(same, ['es'], { strict: true }), 1);
  assert.equal(validateAll(same, ['fr']).summary.allValid, false);
});

test('standalone export prevalidates every language and rejects path traversal', () => {
  const dir = makeTempDir();
  const path = writeFixture(dir, 'input.csv', canonical([{ id: 'a', source: 'Hello <x id="PH"/>', es: 'Hola <x id="PH"/>', fr: 'Salut' }]));
  assert.throws(() => csvToXlf(path, join(dir, 'dist'), ['es', 'fr']), /Missing placeholder/);
  assert.equal(existsSync(join(dir, 'dist/messages.es.xlf')), false);
  assert.throws(() => csvToXlf(path, join(dir, 'dist'), ['es'], { fileNames: { es: '../outside.xlf' } }), /Unsafe/);
});

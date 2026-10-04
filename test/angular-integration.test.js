import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HtmlParser, I18NHtmlParser, MessageBundle, Xliff } from '@angular/compiler';
import { stringify } from 'csv-stringify/sync';
import { makeTempDir, writeFixture } from './helpers.js';
import { xlfToCsv, csvToXlf } from '../src/csv-converter.js';
import { parseCsvRecords } from '../src/csv-records.js';

const template = '<p i18n="greeting|Shown on home@@welcome">Hello {{name}}</p><p i18n="@@count">{count, plural, =0 {No items} other {# items}}</p><p i18n="@@literal">Show &lt;x id=&quot;FAKE&quot;/&gt;</p>';

test('real Angular extraction survives CSV translation and Angular consumption', () => {
  const bundle = new MessageBundle(new HtmlParser(), [], {}, 'en');
  assert.deepEqual(bundle.updateFromTemplate(template, 'component.html'), []);
  const source = bundle.write(new Xliff());
  const dir = makeTempDir();
  const sourceFile = writeFixture(dir, 'source.xlf', source);
  const csvFile = join(dir, 'messages.csv');
  xlfToCsv(sourceFile, csvFile, ['es']);
  const parsed = parseCsvRecords(readFileSync(csvFile, 'utf8'), { requireFormat: true });
  for (const row of parsed.records) row.es = row.source.replace('Hello', 'Hola').replace('No items', 'Ninguno').replace('# items', '# elementos').replace('Show', 'Mostrar');
  const translated = writeFixture(dir, 'messages.translated.csv', stringify(parsed.records, { columns: parsed.columns, header: true }));
  const { files } = csvToXlf(translated, join(dir, 'dist'), ['es']);
  const output = readFileSync(files.es, 'utf8');
  const loaded = new Xliff().load(output, files.es);
  assert.equal(loaded.locale, 'es');
  assert.ok(loaded.i18nNodesByMsgId.welcome);
  const translatedTemplate = new I18NHtmlParser(new HtmlParser(), output, 'xlf').parse(template, 'component.html', { tokenizeExpansionForms: true });
  assert.deepEqual(translatedTemplate.errors, []);
  assert.ok(translatedTemplate.rootNodes[0].children.some(node => node.value?.includes('Hola')));
  assert.ok(translatedTemplate.rootNodes[2].children.some(node => node.value?.includes('<x id="FAKE"/>')));
});

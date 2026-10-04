/**
 * Shared test helpers and fixtures.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'fs';
import { after } from 'node:test';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';

const temporaryFixtures = new Map();
after(() => {
  for (const [directory, prefix] of temporaryFixtures) {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith(prefix) || realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) {
      throw new Error(`Refusing unsafe fixture cleanup: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * XLF fixture covering the tricky cases: inline placeholders, attribute
 * entities, ICU, special characters, meaning and multiple notes.
 */
export const FIXTURE_XLF = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="es" original="messages">
    <body>
      <trans-unit id="plain.text">
        <source>Hello world</source>
        <note>Simple greeting</note>
      </trans-unit>
      <trans-unit id="interp.simple">
        <source>Hello, <x id="PH" equiv="interpolation" type="fmt" disp="{{name}}"/>!</source>
      </trans-unit>
      <trans-unit id="interp.attr.special">
        <source>Value <x id="PH" equiv="interpolation" type="fmt" disp="{{a &amp; b}}"/> end</source>
      </trans-unit>
      <trans-unit id="special.chars">
        <source>Tom &amp; Jerry &lt;3 &quot;quotes&quot;</source>
      </trans-unit>
      <trans-unit id="icu.plural">
        <source>{count, plural, =0 {No items} =1 {One item} other {# items}}</source>
        <note>First note</note>
        <note>Second note</note>
        <note from="meaning">items count</note>
      </trans-unit>
      <trans-unit id="html.inline">
        <source>Click <g id="0" ctype="link">here</g> to continue</source>
      </trans-unit>
    </body>
  </file>
</xliff>`;

/**
 * XLIFF 2.0 fixture (unsupported format).
 */
export const FIXTURE_XLF2 = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0" srcLang="en">
  <file id="ngi18n" original="ng.template">
    <unit id="welcome.title">
      <segment>
        <source>Welcome</source>
      </segment>
    </unit>
  </file>
</xliff>`;

/**
 * Malformed XML fixture.
 */
export const FIXTURE_XLF_BROKEN = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" original="messages">
    <body>
      <trans-unit id="broken.unit">
        <source>Unclosed tag <x id="PH"
      </trans-unit>
    </body>
  </file>
</xliff>`;

/**
 * Creates a fresh temporary directory for a test.
 * @param {string} prefix
 * @returns {string} Absolute path of the temp directory
 */
export function makeTempDir(prefix = 'i18n-test-') {
  const directory = resolve(mkdtempSync(join(tmpdir(), prefix)));
  temporaryFixtures.set(directory, prefix);
  return directory;
}

/**
 * Writes a file inside a directory, creating parents as needed.
 * @param {string} dir
 * @param {string} relativePath
 * @param {string} content
 * @returns {string} Absolute file path
 */
export function writeFixture(dir, relativePath, content) {
  const filePath = join(dir, relativePath);
  const parts = relativePath.split('/');
  if (parts.length > 1) {
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Builds a minimal i18n configuration object pointing at a mock LLM.
 */
export function makeConfig({ baseURL, languages = ['en', 'es'], sourceLanguage = 'en', llm = {} }) {
  return {
    languages: languages.map(code => ({
      code,
      name: code,
      file: `messages.${code}.xlf`,
    })),
    sourceLanguage,
    sourceFile: 'messages.xlf',
    csvOutput: 'messages.csv',
    outputDir: 'dist-i18n',
    batchDir: 'batches',
    llm: {
      baseURL: baseURL || 'http://127.0.0.1:9',
      apiKey: 'test-key',
      model: 'test-model',
      batchSize: 50,
      concurrency: 2,
      ...llm,
    },
  };
}

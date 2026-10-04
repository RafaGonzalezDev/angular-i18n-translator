import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmdirSync, unlinkSync } from 'node:fs';
import { makeTempDir } from './helpers.js';
import { join, dirname, resolve } from 'node:path';
import { cleanAll } from '../src/cleaner.js';
import { registerArtifacts, readArtifactManifest, ARTIFACT_MANIFEST } from '../src/artifacts.js';
import { resolveSafeOutputPath, assertSafeDirectory, assertNoSymlinks, getTranslatedCsvPath } from '../src/paths.js';
import { safeValidateConfig } from '../src/config-schema.js';

function fixture() {
  const root = makeTempDir('i18n-cleaner-');
  const paths = { batchDir: 'batches', outputDir: 'dist-i18n', csvPath: 'messages.csv', translatedCsvPath: 'messages.translated.csv', sourceFile: 'input.xlf', configFile: 'custom-settings.json' };
  const file = (name, content = 'sentinel') => {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };
  return { root, paths, file, options: { projectRoot: root, protectedPaths: [paths.sourceFile, paths.configFile] } };
}

test('cleanup removes owned files only and preserves foreign contents and source/config sentinels', async () => {
  const f = fixture();
  const owned = ['batches/pending/batch-1.csv', 'batches/translated/es/batch-1.csv', 'dist-i18n/messages.es.xlf', 'messages.csv', 'messages.translated.csv'].map(name => f.file(name));
  const foreign = ['batches/pending/foreign.csv', 'dist-i18n/foreign.xlf', 'input.xlf', 'custom-settings.json', '.env', 'src/index.js'].map(name => f.file(name));
  registerArtifacts(owned, f.options);
  const result = await cleanAll(f.paths, { projectRoot: f.root });
  owned.forEach(file => assert.equal(existsSync(file), false));
  foreign.forEach(file => assert.equal(readFileSync(file, 'utf8'), 'sentinel'));
  assert.ok(existsSync(join(f.root, 'batches/pending')));
  assert.ok(!existsSync(join(f.root, 'batches/translated')));
  assert.deepEqual(readArtifactManifest(f.options).files, []);
  assert.deepEqual(result.removed, result.planned);
  assert.deepEqual(result.warnings, []);
});

test('dry run plans owned files and newly empty directories without modifying manifest or files', async () => {
  const f = fixture();
  const owned = f.file('batches/pending/batch-1.csv');
  registerArtifacts([owned], f.options);
  const before = readFileSync(join(f.root, ARTIFACT_MANIFEST), 'utf8');
  const plan = await cleanAll(f.paths, { projectRoot: f.root, dryRun: true });
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.planned, [owned, join(f.root, 'batches/pending'), join(f.root, 'batches')]);
  assert.equal(readFileSync(join(f.root, ARTIFACT_MANIFEST), 'utf8'), before);
  assert.ok(existsSync(owned));
});

test('missing manifest preserves old artifacts and untouched empty directories', async () => {
  const f = fixture();
  const old = f.file('messages.csv');
  mkdirSync(join(f.root, 'dist-i18n'));
  const result = await cleanAll(f.paths, { projectRoot: f.root });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.planned, []);
  assert.match(result.warnings[0], /manually/);
  assert.ok(existsSync(old));
  assert.ok(existsSync(join(f.root, 'dist-i18n')));
});

test('unselected registered artifacts remain in the manifest', async () => {
  const f = fixture();
  const selected = f.file('messages.csv'), other = f.file('other/generated.csv');
  registerArtifacts([selected, other], f.options);
  await cleanAll(f.paths, { projectRoot: f.root });
  assert.ok(existsSync(other));
  assert.deepEqual(readArtifactManifest(f.options).files, ['other/generated.csv']);
});

test('malformed, unsupported, protected, absolute and traversal manifest entries fail before any deletion', async () => {
  for (const bad of ['{broken', { version: 99, files: [] }, { version: 1, files: ['../outside.csv'] }, { version: 1, files: ['/outside.csv'] }, { version: 1, files: ['C:\\outside.csv'] }, { version: 1, files: ['src/index.js'] }, { version: 1, files: ['.env'] }, { version: 1, files: ['batches/../messages.csv'] }, { version: 1, files: ['custom-settings.json'] }, { version: 1, files: ['a.csv:secret'] }]) {
    const f = fixture();
    const owned = f.file('messages.csv');
    f.file(ARTIFACT_MANIFEST, typeof bad === 'string' ? bad : JSON.stringify({ ...bad, files: ['messages.csv', ...(bad.files ?? [])] }));
    await assert.rejects(cleanAll(f.paths, { projectRoot: f.root }));
    assert.equal(readFileSync(owned, 'utf8'), 'sentinel');
  }
});

test('all selected paths preflight before deletion, including root, ancestor and protected targets', async () => {
  for (const outputDir of ['.', '..', '../escape', 'src', 'docs', 'node_modules', '.git']) {
    const f = fixture();
    const owned = f.file('messages.csv');
    registerArtifacts([owned], f.options);
    await assert.rejects(cleanAll({ ...f.paths, outputDir }, { projectRoot: f.root }));
    assert.ok(existsSync(owned));
  }
});

test('registration is synchronous, versioned, path-only and rejects protected/non-file/escaped outputs', () => {
  const f = fixture();
  const owned = f.file('messages.csv');
  const result = registerArtifacts([owned, owned], f.options);
  assert.deepEqual(result, { version: 1, files: ['messages.csv'] });
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, ARTIFACT_MANIFEST), 'utf8')), result);
  for (const name of ['input.xlf', 'custom-settings.json', '.env', 'package.json', 'i18n.config.json', 'src/index.js', 'docs/readme.md']) {
    const file = f.file(name);
    assert.throws(() => registerArtifacts([file], f.options));
  }
  assert.throws(() => registerArtifacts([f.root], f.options));
  assert.throws(() => resolveSafeOutputPath(resolve(f.root, '../outside.csv'), f.options));
  assert.throws(() => assertSafeDirectory(f.root, f.options));
  assert.throws(() => assertSafeDirectory('nested', { projectRoot: f.root, protectedPaths: ['nested/source.xlf'] }));
});

test('prospective artifacts may be registered before writes and missing artifacts produce safe cleanup warnings', async () => {
  const f = fixture();
  const prospective = join(f.root, 'batches/pending/not-written.csv');
  const result = registerArtifacts([prospective], f.options);
  assert.deepEqual(result.files, ['batches/pending/not-written.csv']);
  assert.equal(existsSync(prospective), false);
  const dryRun = await cleanAll(f.paths, { projectRoot: f.root, dryRun: true });
  assert.deepEqual(dryRun.planned, []);
  assert.match(dryRun.warnings[0], /missing/);
  assert.deepEqual(readArtifactManifest(f.options).files, result.files);
  const cleaned = await cleanAll(f.paths, { projectRoot: f.root });
  assert.deepEqual(cleaned.removed, []);
  assert.match(cleaned.warnings[0], /missing/);
  assert.deepEqual(readArtifactManifest(f.options).files, []);
  const dir = join(f.root, 'directory.csv');
  mkdirSync(dir);
  assert.throws(() => registerArtifacts([dir], f.options));
});

test('symlink/junction targets and ancestors are rejected without touching external sentinels', async t => {
  const f = fixture();
  const external = makeTempDir('i18n-cleaner-external-');
  const sentinel = join(external, 'sentinel.csv');
  writeFileSync(sentinel, 'external');
  try { symlinkSync(external, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Links unavailable: ${error.code}`); return; } throw error; }
  t.after(() => {
    // Remove the exact link itself non-recursively before fixture cleanup.
    const link = resolve(f.root, 'linked');
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  });
  assert.throws(() => assertNoSymlinks(join(f.root, 'linked', 'not-created', 'file.csv')));
  assert.throws(() => registerArtifacts([join(f.root, 'linked/sentinel.csv')], f.options));
  const owned = f.file('messages.csv');
  registerArtifacts([owned], f.options);
  await assert.rejects(cleanAll({ ...f.paths, outputDir: 'linked' }, { projectRoot: f.root }));
  assert.ok(existsSync(owned));
  assert.equal(readFileSync(sentinel, 'utf8'), 'external');
  f.file(ARTIFACT_MANIFEST, JSON.stringify({ version: 1, files: ['messages.csv', 'linked/sentinel.csv'] }));
  await assert.rejects(cleanAll(f.paths, { projectRoot: f.root }));
  assert.ok(existsSync(owned));
});

test('translated CSV names preserve parent paths and handle uppercase extensions and extensionless names', () => {
  assert.equal(getTranslatedCsvPath('folder.csv/MESSAGES.CSV'), 'folder.csv/MESSAGES.translated.csv');
  assert.equal(getTranslatedCsvPath('folder/messages'), 'folder/messages.translated.csv');
  assert.equal(getTranslatedCsvPath('C:\\folder.csv\\MESSAGES.CSV'), 'C:\\folder.csv\\MESSAGES.translated.csv');
});

test('schema rejects dangerous language filenames/codes, directories and path collisions', () => {
  const base = { languages: [{ code: 'en', name: 'English', file: 'messages.en.xlf' }], sourceLanguage: 'en', llm: { baseURL: 'https://example.com', apiKey: 'secret', model: 'model' } };
  assert.equal(safeValidateConfig(base).success, true);
  for (const code of ['..', '../en', 'en/US', 'en\\US']) {
    assert.equal(safeValidateConfig({ ...base, languages: [{ ...base.languages[0], code }] }).success, false);
  }
  for (const file of ['../en.xlf', 'dir/en.xlf', 'dir\\en.xlf', 'en.xml', 'C:en.xlf']) {
    assert.equal(safeValidateConfig({ ...base, languages: [{ ...base.languages[0], file }] }).success, false);
  }
  for (const dirs of [{ outputDir: '.' }, { outputDir: '/' }, { outputDir: '../escape' }, { batchDir: '..' }, { batchDir: 'C:\\' }, { outputDir: 'src' }, { outputDir: 'batches/output' }, { csvOutput: 'messages.xlf' }, { sourceFile: 'messages.translated.csv' }, { sourceFile: 'dist-i18n/input.xlf' }]) {
    assert.equal(safeValidateConfig({ ...base, ...dirs }).success, false, JSON.stringify(dirs));
  }
  assert.equal(safeValidateConfig({ ...base, languages: [{ code: 'zh-Hant-TW', name: 'Chinese', file: 'messages.zh.xlf' }], sourceLanguage: 'zh-Hant-TW' }).success, true);
});

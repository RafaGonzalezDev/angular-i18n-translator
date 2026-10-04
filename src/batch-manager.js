/** Split, translate and merge format-tagged CSV batches with verified caches. */
import { stringify } from 'csv-stringify/sync';
import { readFile, writeFile, mkdir, readdir, lstat, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { translateBatch, validateTranslation, buildSystemPrompt } from './llm-client.js';
import { parseCsvRecords, assertUniqueIds, FORMAT_COLUMN } from './csv-records.js';
import { registerArtifacts, readArtifactManifest } from './artifacts.js';
import { getTranslatedCsvPath, resolveSafeOutputPath, assertNoSymlinks, assertSafeDirectory } from './paths.js';

const BATCH_FILE_RE = /^batch-(\d+)\.csv$/;
const GENERATED_FILE_RE = /^batch-(\d+)\.csv(?:\.meta\.json)?$/;
const CACHE_VERSION = 2;
const FIXED_COLUMNS = new Set(['id', 'source', 'note', 'meaning', FORMAT_COLUMN]);
const CONTEXT_COLUMNS = ['id', 'source', 'note', 'meaning'];

function protectedInputs(options) {
  return [...(options.protectedPaths || []), options.sourceFile, options.configFile].filter(Boolean);
}

function checkLanguage(language) {
  if (typeof language !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(language) || FIXED_COLUMNS.has(language)) throw new Error(`Invalid target language: ${language}`);
}

function ordered(files) {
  return files.filter(file => BATCH_FILE_RE.test(file)).sort((a, b) => Number(BATCH_FILE_RE.exec(a)[1]) - Number(BATCH_FILE_RE.exec(b)[1]));
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');
}

function project(records, language) {
  return records.map(record => Object.fromEntries([...CONTEXT_COLUMNS, language].map(column => [column, record[column] ?? ''])));
}

function requestContext(config, language) {
  const { model, baseURL, systemPrompt, requestExtra } = config;
  const { model: ignoredModel, messages: ignoredMessages, ...extra } = requestExtra || {};
  return { model, baseURL: baseURL.replace(/\/+$/, ''), systemPrompt: buildSystemPrompt(language, systemPrompt), requestExtra: extra };
}

function fingerprint(records, language, request) {
  return digest({ version: CACHE_VERSION, language, records: project(records, language), request });
}

async function readCSV(filePath) {
  assertNoSymlinks(filePath);
  const parsed = parseCsvRecords(await readFile(filePath, 'utf8'), { requireFormat: true });
  assertUniqueIds(parsed.records, parsed.lines);
  return parsed;
}

async function atomicWrite(filePath, content) {
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, target);
  } finally {
    // The absolute cleanup target is the exact temporary sibling constructed above.
    if (dirname(resolve(tempPath)) !== dirname(target)) throw new Error('Unsafe temporary cleanup path');
    await rm(tempPath, { force: true });
  }
}

async function writeCSV(filePath, records, columns) {
  await atomicWrite(filePath, stringify(records, { header: true, columns }));
}

async function removeStale(dirPath, maxBatch, ownedPaths) {
  if (!existsSync(dirPath)) return [];
  const directory = assertNoSymlinks(resolve(dirPath));
  const removed = [];
  for (const entry of await readdir(directory)) {
    const match = GENERATED_FILE_RE.exec(entry);
    if (!match || Number(match[1]) <= maxBatch) continue;
    const target = resolve(directory, entry);
    if (dirname(target) !== directory || basename(target) !== entry) throw new Error('Unsafe batch deletion path');
    if (!ownedPaths.has(target)) continue;
    if (!(await lstat(target)).isFile()) throw new Error(`Refusing to delete non-file batch: ${target}`);
    await rm(target);
    removed.push(target);
  }
  return removed;
}

/** Validates metadata identity, current inputs and the complete cached CSV. */
async function readCache(outputPath, pendingPath, pending, language, config) {
  assertNoSymlinks(outputPath);
  assertNoSymlinks(`${outputPath}.meta.json`);
  const metadata = JSON.parse(await readFile(`${outputPath}.meta.json`, 'utf8'));
  if (metadata.version !== CACHE_VERSION || metadata.invalid || metadata.outputPath !== resolve(outputPath) || metadata.pendingPath !== resolve(pendingPath) || metadata.language !== language) throw new Error('Invalid cache metadata identity');
  const request = config ? requestContext(config, language) : metadata.request;
  if (!request || metadata.fingerprint !== fingerprint(pending.records, language, request)) throw new Error('Stale cache fingerprint');
  const raw = await readFile(outputPath, 'utf8');
  if (metadata.outputDigest !== digest(raw)) throw new Error('Corrupt cache output digest');
  const cached = parseCsvRecords(raw, { requireFormat: true });
  assertUniqueIds(cached.records, cached.lines);
  const expectedColumns = [...pending.columns];
  if (!expectedColumns.includes(language)) expectedColumns.push(language);
  if (cached.columns.length !== expectedColumns.length || cached.columns.some(column => !expectedColumns.includes(column))) throw new Error('Invalid cache columns');
  const projectedColumns = [...CONTEXT_COLUMNS, language];
  const validation = validateTranslation(
    stringify(project(pending.records, language), { header: true, columns: projectedColumns }),
    stringify(project(cached.records, language), { header: true, columns: projectedColumns }), language,
  );
  if (!validation.isValid) throw new Error(`Invalid cache: ${validation.reason}`);
  const originals = new Map(pending.records.map(record => [record.id, record]));
  for (const record of cached.records) {
    for (const column of pending.columns.filter(column => column !== language)) {
      if (record[column] !== originals.get(record.id)?.[column]) throw new Error(`Modified cache context: ${record.id}/${column}`);
    }
  }
  return cached.records;
}

export async function splitBatches(csvFilePath, batchSize = 50, batchDir = 'batches', options = {}) {
  if (!csvFilePath) throw new Error('csvFilePath is required');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`Invalid batchSize: ${batchSize}`);
  const parsed = await readCSV(csvFilePath);
  const projectRoot = options.projectRoot || dirname(resolve(csvFilePath));
  const pendingDir = assertSafeDirectory(resolve(batchDir, 'pending'), { projectRoot, protectedPaths: [resolve(csvFilePath), ...protectedInputs(options)] });
  const artifactOptions = { projectRoot, protectedPaths: protectedInputs(options) };
  const manifest = readArtifactManifest(artifactOptions);
  const ownedPaths = new Set((manifest?.files || []).map(path => resolve(projectRoot, path)));
  const batchCount = Math.ceil(parsed.records.length / batchSize);
  const paths = Array.from({ length: batchCount }, (_, index) => join(pendingDir, `batch-${index + 1}.csv`));
  paths.forEach(path => resolveSafeOutputPath(path, { projectRoot, protectedPaths: [resolve(csvFilePath), ...(protectedInputs(options))] }));
  if (paths.length) await registerArtifacts(paths, artifactOptions);
  await mkdir(pendingDir, { recursive: true });
  for (let index = 0; index < batchCount; index++) {
    const records = parsed.records.slice(index * batchSize, (index + 1) * batchSize);
    await writeCSV(paths[index], records, parsed.columns);
    options.onProgress?.(index + 1, batchCount, records.length);
  }
  const removedStale = await removeStale(pendingDir, batchCount, ownedPaths);
  const translatedDir = resolve(batchDir, 'translated');
  if (existsSync(translatedDir)) {
    for (const language of await readdir(translatedDir)) {
      const langDir = join(translatedDir, language);
      if ((await lstat(langDir)).isDirectory()) removedStale.push(...await removeStale(langDir, batchCount, ownedPaths));
    }
  }
  const result = { batchCount, recordCount: parsed.records.length, removedStale };
  options.onComplete?.(result);
  return result;
}

export async function runBatches(batchDir, targetLanguage, config, options = {}) {
  if (!batchDir) throw new Error('batchDir is required');
  checkLanguage(targetLanguage);
  if (!config?.baseURL || !config.model || !config.apiKey) throw new Error('config must include baseURL, model, and apiKey');
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const projectRoot = options.projectRoot || dirname(resolve(batchDir));
  const safety = { projectRoot, protectedPaths: protectedInputs(options) };
  const pendingDir = assertSafeDirectory(resolve(batchDir, 'pending'), safety);
  const outputDir = assertSafeDirectory(resolve(batchDir, 'translated', targetLanguage), safety);
  const files = existsSync(pendingDir) ? ordered(await readdir(pendingDir)) : [];
  const summary = { processed: 0, skipped: 0, failed: 0, errors: [], warnings: [], batchCount: files.length };
  async function processBatch(file, index) {
    const pendingPath = join(pendingDir, file);
    const outputPath = join(outputDir, file);
    const metadataPath = `${outputPath}.meta.json`;
    options.onProgress?.(index + 1, files.length, 'processing');
    try {
      // Invalidate before reading inputs or requesting: even an unreadable forced
      // batch must never expose its old translation to a later merge.
      if (options.force) {
        resolveSafeOutputPath(metadataPath, { projectRoot, protectedPaths: [pendingPath, ...(protectedInputs(options))] });
        await registerArtifacts([metadataPath], { projectRoot, protectedPaths: protectedInputs(options) });
        await atomicWrite(metadataPath, JSON.stringify({ version: CACHE_VERSION, invalid: true, outputPath }));
      }
      const pending = await readCSV(pendingPath);
      if (!pending.records.length) throw new Error(`Batch ${file} is empty`);
      if (!options.force) {
        try {
          await readCache(outputPath, pendingPath, pending, targetLanguage, config);
          summary.skipped++;
          options.onProgress?.(index + 1, files.length, 'skipped');
          return;
        } catch { /* Cache misses are retranslated, never silently reused. */ }
      }
      for (const path of [outputPath, metadataPath]) resolveSafeOutputPath(path, { projectRoot, protectedPaths: [pendingPath, ...(protectedInputs(options))] });
      await registerArtifacts([outputPath, metadataPath], { projectRoot, protectedPaths: protectedInputs(options) });
      await atomicWrite(metadataPath, JSON.stringify({ version: CACHE_VERSION, invalid: true, outputPath }));
      const columns = [...CONTEXT_COLUMNS, targetLanguage];
      const input = stringify(project(pending.records, targetLanguage), { header: true, columns });
      const translated = await translateBatch(input, targetLanguage, config, { ...options, currentBatch: index + 1, totalBatches: files.length, onProgress: undefined });
      const validation = validateTranslation(input, translated, targetLanguage);
      if (!validation.isValid) throw new Error(validation.reason);
      const response = parseCsvRecords(translated, { requiredColumns: columns });
      const byId = new Map(response.records.map(record => [record.id, record[targetLanguage]]));
      const records = pending.records.map(record => ({ ...record, [targetLanguage]: byId.get(record.id) }));
      const outputColumns = pending.columns.includes(targetLanguage) ? pending.columns : [...pending.columns, targetLanguage];
      const output = stringify(records, { header: true, columns: outputColumns });
      const request = requestContext(config, targetLanguage);
      await atomicWrite(outputPath, output);
      await atomicWrite(metadataPath, JSON.stringify({ version: CACHE_VERSION, outputPath, pendingPath, language: targetLanguage, request, fingerprint: fingerprint(pending.records, targetLanguage, request), outputDigest: digest(output) }, null, 2));
      summary.processed++;
      for (const warning of validation.warnings) summary.warnings.push({ batch: file, warning });
      options.onProgress?.(index + 1, files.length, 'completed');
    } catch (error) {
      summary.failed++;
      summary.errors.push({ batch: file, error: error.message });
      options.onProgress?.(index + 1, files.length, 'failed', error.message);
    }
  }
  for (let index = 0; index < files.length; index += concurrency) {
    await Promise.all(files.slice(index, index + concurrency).map((file, offset) => processBatch(file, index + offset)));
  }
  return summary;
}

export async function mergeBatches(csvFilePath, batchDir, options = {}) {
  if (!csvFilePath) throw new Error('csvFilePath is required');
  if (!batchDir) throw new Error('batchDir is required');
  const original = await readCSV(csvFilePath);
  const languages = options.languages ? options.languages.map(language => typeof language === 'string' ? language : language.code) : original.columns.filter(column => !FIXED_COLUMNS.has(column));
  languages.forEach(checkLanguage);
  if (new Set(languages).size !== languages.length) throw new Error('Duplicate expected language');
  const translatedDir = resolve(batchDir, 'translated');
  if (!existsSync(translatedDir)) throw new Error('No translated batches found. Run translate:run first.');
  const originals = new Map(original.records.map(record => [record.id, record]));
  const translations = new Map(languages.map(language => [language, new Map()]));
  let batchesRead = 0;
  const errors = [];
  for (const language of languages) {
    const langDir = join(translatedDir, language);
    if (!existsSync(langDir)) continue;
    let files;
    try { files = ordered(await readdir(langDir)); }
    catch (error) { errors.push({ lang: language, batch: null, error: error.message }); continue; }
    for (const file of files) {
      try {
        const pendingPath = resolve(batchDir, 'pending', file);
        const pending = await readCSV(pendingPath);
        for (const record of pending.records) {
          const current = originals.get(record.id);
          if (!current) throw new Error(`Batch contains id outside current source: ${record.id}`);
          for (const column of [...CONTEXT_COLUMNS, FORMAT_COLUMN, language]) {
            if ((record[column] ?? '') !== (current[column] ?? '')) throw new Error(`Batch source context changed: ${record.id}/${column}`);
          }
        }
        const records = await readCache(join(langDir, file), pendingPath, pending, language, options.llm || options.config);
        // Validate the complete batch before committing any of its targets.
        for (const record of records) {
          if (!originals.has(record.id)) throw new Error(`Translation contains id outside current source: ${record.id}`);
          if (translations.get(language).has(record.id)) throw new Error(`Duplicate translated id: ${record.id}`);
        }
        for (const record of records) translations.get(language).set(record.id, record[language]);
        batchesRead++;
      } catch (error) {
        errors.push({ lang: language, batch: file, error: error.message });
      }
    }
  }
  if (!batchesRead) throw new Error(`No translated batches found for expected languages.${errors.length ? ` Rejected batches: ${errors.map(item => `${item.lang}/${item.batch}: ${item.error}`).join('; ')}` : ''}`);
  const missing = languages.map(lang => ({ lang, ids: original.records.filter(record => !translations.get(lang).has(record.id)).map(record => record.id) })).filter(item => item.ids.length);
  const records = original.records.map(record => ({ ...record, ...Object.fromEntries(languages.map(language => [language, translations.get(language).get(record.id) ?? ''])) }));
  const columns = [...original.columns, ...languages.filter(language => !original.columns.includes(language))];
  const outputFile = getTranslatedCsvPath(csvFilePath);
  const projectRoot = options.projectRoot || dirname(resolve(csvFilePath));
  resolveSafeOutputPath(outputFile, { projectRoot, protectedPaths: [resolve(csvFilePath), ...(protectedInputs(options))] });
  await registerArtifacts([outputFile], { projectRoot, protectedPaths: protectedInputs(options) });
  await writeCSV(outputFile, records, columns);
  return { outputFile, missing, errors };
}

export default { splitBatches, runBatches, mergeBatches };

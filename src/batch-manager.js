/**
 * Batch Manager Module
 *
 * Handles splitting the source CSV into batches, translating them through
 * the LLM client, and merging the results back into a single CSV.
 *
 * Design notes:
 * - Translated records are always matched back by `id`, never by row index,
 *   so rows dropped or reordered by the LLM are reported as failures instead
 *   of silently corrupting other records.
 * - Already translated batches are skipped unless `force` is set.
 * - Splitting removes stale batch files from previous runs.
 */

import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { translateBatch } from './llm-client.js';

const PENDING_DIR = 'pending';
const TRANSLATED_DIR = 'translated';
const DEFAULT_CONCURRENCY = 5;
const BATCH_FILE_RE = /^batch-(\d+)\.csv$/;

// ============================================================================
// FILE HELPERS
// ============================================================================

/**
 * Ensures a directory exists, creating it if necessary.
 */
async function ensureDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Sorts batch file names numerically (batch-2 before batch-10).
 */
function sortBatchFilesNumerically(files) {
  return [...files].sort((a, b) => batchNumberOf(a) - batchNumberOf(b));
}

/**
 * Extracts the numeric index from a batch file name.
 * @returns {number} The batch number, or Number.MAX_SAFE_INTEGER if not a batch file
 */
function batchNumberOf(fileName) {
  const match = BATCH_FILE_RE.exec(fileName);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Reads and parses a CSV file.
 */
async function readCSV(filePath) {
  const content = await readFile(filePath, 'utf-8');

  return new Promise((resolve, reject) => {
    parse(content, {
      columns: true,
      skip_empty_lines: true,
    }, (err, records) => {
      if (err) {
        reject(new Error(`Failed to parse CSV ${filePath}: ${err.message}`));
      } else {
        resolve(records);
      }
    });
  });
}

/**
 * Writes records to a CSV file.
 */
async function writeCSV(filePath, records, columns) {
  return new Promise((resolve, reject) => {
    stringify(records, { header: true, columns }, (err, output) => {
      if (err) {
        reject(new Error(`Failed to stringify CSV: ${err.message}`));
      } else {
        // Create the parent directory lazily here: a directory that exists
        // without any translated file would mislead the merge step.
        ensureDirectory(dirname(filePath))
          .then(() => writeFile(filePath, output, 'utf-8'))
          .then(() => resolve())
          .catch(reject);
      }
    });
  });
}

/**
 * Removes batch files numbered above `maxBatch` from a directory.
 * @returns {Promise<string[]>} Removed file paths
 */
async function removeStaleBatches(dirPath, maxBatch) {
  if (!existsSync(dirPath)) return [];

  const removed = [];
  const entries = await readdir(dirPath);

  for (const entry of entries) {
    const match = BATCH_FILE_RE.exec(entry);
    if (match && parseInt(match[1], 10) > maxBatch) {
      const filePath = join(dirPath, entry);
      await rm(filePath, { force: true });
      removed.push(filePath);
    }
  }
  return removed;
}

// ============================================================================
// TRANSLATION
// ============================================================================

/**
 * Processes a single batch file for one language.
 *
 * @returns {Promise<{status: 'success'|'skipped'|'failed', batch: string, error?: string}>}
 */
async function processSingleBatch(batchFile, batchIndex, totalBatches, pendingDir, translatedDir, targetLanguage, config, options = {}) {
  const { force = false, onProgress } = options;
  const batchNumber = batchIndex + 1;
  const batchFilePath = join(pendingDir, batchFile);
  const translatedFilePath = join(translatedDir, batchFile);

  if (onProgress) {
    onProgress(batchNumber, totalBatches, 'processing');
  }

  try {
    // Skip batches that already have a translation unless forced
    if (!force && existsSync(translatedFilePath)) {
      if (onProgress) {
        onProgress(batchNumber, totalBatches, 'skipped');
      }
      return { status: 'skipped', batch: batchFile };
    }

    const records = await readCSV(batchFilePath);

    if (records.length === 0) {
      throw new Error(`Batch ${batchFile} is empty`);
    }

    // Send the LLM only the columns it needs
    const translationColumns = ['id', 'source', 'note', 'meaning', targetLanguage];
    const translationRecords = records.map(record => {
      const projected = {};
      for (const col of translationColumns) {
        projected[col] = record[col] || '';
      }
      return projected;
    });

    const csvContent = await new Promise((resolve, reject) => {
      stringify(translationRecords, { header: true, columns: translationColumns }, (err, output) => {
        if (err) reject(err);
        else resolve(output);
      });
    });

    const translatedCSV = await translateBatch(csvContent, targetLanguage, config, {
      force,
      currentBatch: batchNumber,
      totalBatches,
    });

    const translatedRecords = await new Promise((resolve, reject) => {
      parse(translatedCSV, {
        columns: true,
        skip_empty_lines: true,
      }, (err, parsed) => {
        if (err) reject(new Error(`Failed to parse translated CSV: ${err.message}`));
        else resolve(parsed);
      });
    });

    // Match translations back by id, never by row index
    const translatedById = new Map();
    for (const record of translatedRecords) {
      if (record.id) {
        translatedById.set(record.id, record);
      }
    }

    const missingIds = [];
    for (const record of records) {
      const translated = translatedById.get(record.id);
      if (!translated) {
        missingIds.push(record.id);
        continue;
      }
      const value = translated[targetLanguage];
      if (value !== undefined && value !== '') {
        record[targetLanguage] = value;
      }
    }

    if (missingIds.length > 0) {
      const shown = missingIds.slice(0, 5).join(', ');
      const more = missingIds.length > 5 ? ` (+${missingIds.length - 5} more)` : '';
      throw new Error(
        `LLM response is missing ${missingIds.length} record(s): ${shown}${more}. ` +
        `The batch was not saved.`
      );
    }

    const columns = Object.keys(records[0]);
    await writeCSV(translatedFilePath, records, columns);

    if (onProgress) {
      onProgress(batchNumber, totalBatches, 'completed');
    }

    return { status: 'success', batch: batchFile };

  } catch (err) {
    if (onProgress) {
      onProgress(batchNumber, totalBatches, 'failed', err.message);
    }
    return { status: 'failed', batch: batchFile, error: err.message };
  }
}

/**
 * Processes batches with controlled concurrency.
 */
async function processBatchesInParallel(batchFiles, pendingDir, translatedDir, targetLanguage, config, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, onProgress } = options;
  const totalBatches = batchFiles.length;

  const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };

  for (let chunkStart = 0; chunkStart < totalBatches; chunkStart += concurrency) {
    const chunkEnd = Math.min(chunkStart + concurrency, totalBatches);
    const chunk = batchFiles.slice(chunkStart, chunkEnd);

    const chunkPromises = chunk.map((batchFile, indexInChunk) => {
      const batchIndex = chunkStart + indexInChunk;
      return processSingleBatch(batchFile, batchIndex, totalBatches, pendingDir, translatedDir, targetLanguage, config, options);
    });

    const results = await Promise.allSettled(chunkPromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { status, batch, error } = result.value;
        if (status === 'success') {
          summary.processed++;
        } else if (status === 'skipped') {
          summary.skipped++;
        } else {
          summary.failed++;
          if (error) {
            summary.errors.push({ batch, error });
          }
        }
      } else {
        summary.failed++;
        summary.errors.push({ batch: 'unknown', error: result.reason?.message || 'Unknown error' });
      }
    }
  }

  return summary;
}

/**
 * Translates all pending batches for one language.
 *
 * Languages must be processed one at a time by the caller (sequential loop)
 * to keep API concurrency bounded and progress reporting readable; batches
 * within a language run in parallel according to `concurrency`.
 *
 * @param {string} batchDir - Base directory for batches
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration (baseURL, model, apiKey, ...)
 * @param {Object} options - Options (force, onProgress, concurrency)
 * @returns {Promise<{processed: number, skipped: number, failed: number, errors: Array, batchCount: number}>}
 */
export async function runBatches(batchDir, targetLanguage, config, options = {}) {
  const {
    force = false,
    onProgress,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  if (!batchDir) {
    throw new Error('batchDir is required');
  }
  if (!targetLanguage) {
    throw new Error('targetLanguage is required');
  }
  if (!config || !config.baseURL || !config.model || !config.apiKey) {
    throw new Error('config must include baseURL, model, and apiKey');
  }

  const pendingDir = join(batchDir, PENDING_DIR);
  const translatedDir = join(batchDir, TRANSLATED_DIR, targetLanguage);

  // Note: the translated directory is created lazily by writeCSV when the
  // first batch succeeds. Creating it up front would make a fully failed run
  // look like a successful one to the merge step.

  const emptySummary = { processed: 0, skipped: 0, failed: 0, errors: [], batchCount: 0 };

  if (!existsSync(pendingDir)) {
    return emptySummary;
  }

  let pendingFiles;
  try {
    pendingFiles = await readdir(pendingDir);
  } catch (err) {
    throw new Error(`Failed to read pending directory: ${err.message}`);
  }

  const batchFiles = sortBatchFilesNumerically(
    pendingFiles.filter(f => BATCH_FILE_RE.test(f))
  );

  if (batchFiles.length === 0) {
    return emptySummary;
  }

  const summary = await processBatchesInParallel(
    batchFiles,
    pendingDir,
    translatedDir,
    targetLanguage,
    config,
    { force, onProgress, concurrency }
  );

  summary.batchCount = batchFiles.length;
  return summary;
}

// ============================================================================
// MERGE
// ============================================================================

/**
 * Merges translated batches back into a single CSV file.
 *
 * @param {string} csvFilePath - Path to the original CSV (defines rows and columns)
 * @param {string} batchDir - Base directory for batches
 * @param {Object} options - Reserved for future options
 * @returns {Promise<{outputFile: string, missing: Array<{lang: string, ids: string[]}>}>}
 *   Output path and, per language, the record ids that have no translation.
 */
export async function mergeBatches(csvFilePath, batchDir, options = {}) {
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }
  if (!batchDir) {
    throw new Error('batchDir is required');
  }

  const translatedBaseDir = join(batchDir, TRANSLATED_DIR);

  if (!existsSync(translatedBaseDir)) {
    throw new Error(
      `No translated batches found (${translatedBaseDir} does not exist). ` +
      `Nothing has been translated yet: run "npm run translate:run" first. ` +
      `If that step failed, fix its error (often an invalid API key or rate limit) and retry. ` +
      `Tip: "npm run translate" runs the whole pipeline for you.`
    );
  }

  // Discover language directories
  let entries;
  try {
    entries = await readdir(translatedBaseDir);
  } catch (err) {
    throw new Error(`Failed to read translated directory: ${err.message}`);
  }

  const languageDirs = [];
  for (const entry of entries) {
    try {
      const statInfo = await stat(join(translatedBaseDir, entry));
      if (statInfo.isDirectory()) {
        languageDirs.push(entry);
      }
    } catch {
      // Skip unreadable entries
    }
  }

  if (languageDirs.length === 0) {
    throw new Error(
      'No translated batches found (the translated folder is empty). ' +
      'Nothing has been translated yet: run "npm run translate:run" first. ' +
      'If that step failed, fix its error (often an invalid API key or rate limit) and retry.'
    );
  }

  // Original CSV defines the row set and column order when present
  let originalRecords = [];
  let columns = [];

  if (existsSync(csvFilePath)) {
    originalRecords = await readCSV(csvFilePath);
    columns = Object.keys(originalRecords[0] || {});
  }

  // Collect translations: id -> { lang -> value }
  const translationsById = new Map();

  for (const lang of languageDirs) {
    const langDir = join(translatedBaseDir, lang);

    let batchFiles;
    try {
      const files = await readdir(langDir);
      batchFiles = sortBatchFilesNumerically(files.filter(f => BATCH_FILE_RE.test(f)));
    } catch {
      continue;
    }

    for (const batchFile of batchFiles) {
      let records;
      try {
        records = await readCSV(join(langDir, batchFile));
      } catch {
        continue;
      }

      for (const record of records) {
        if (!record.id) continue;

        if (!translationsById.has(record.id)) {
          translationsById.set(record.id, {});
        }
        if (record[lang] !== undefined && record[lang] !== '') {
          translationsById.get(record.id)[lang] = record[lang];
        }
      }
    }
  }

  // Nothing was translated at all: fail clearly instead of producing a
  // merged CSV that only repeats the source text.
  if (translationsById.size === 0) {
    throw new Error(
      'The translated batches contain no translations. ' +
      'Run "npm run translate:run" first; if it failed, fix its error (often an invalid API key or rate limit) and retry.'
    );
  }

  // Build merged records
  let mergedRecords;

  if (originalRecords.length > 0) {
    mergedRecords = originalRecords.map(originalRecord => {
      const translations = translationsById.get(originalRecord.id);
      return translations ? { ...originalRecord, ...translations } : originalRecord;
    });
  } else {
    mergedRecords = [];
    const allColumns = new Set(['id']);
    for (const [id, translations] of translationsById) {
      mergedRecords.push({ id, ...translations });
      Object.keys(translations).forEach(col => allColumns.add(col));
    }
    columns = Array.from(allColumns);
  }

  for (const lang of languageDirs) {
    if (!columns.includes(lang)) {
      columns.push(lang);
    }
  }

  // Detect records that never got a translation per language.
  // When the original CSV is available, a value only counts as translated
  // when it differs from the original cell (language columns are seeded with
  // the source text, so equality means "never translated").
  const missing = [];
  for (const lang of languageDirs) {
    const missingIds = [];

    for (let i = 0; i < mergedRecords.length; i++) {
      const mergedRecord = mergedRecords[i];
      if (!mergedRecord.id) continue;

      const value = mergedRecord[lang];
      const originalValue = originalRecords.length > 0 ? originalRecords[i]?.[lang] : undefined;

      const isTranslated = value !== undefined && value !== ''
        && (originalRecords.length === 0 || value !== originalValue);

      if (!isTranslated) {
        missingIds.push(mergedRecord.id);
      }
    }

    if (missingIds.length > 0) {
      missing.push({ lang, ids: missingIds });
    }
  }

  // Derive output path: <name>.csv -> <name>.translated.csv
  const parsedPath = csvFilePath.replace(/\\/g, '/');
  const lastSlash = parsedPath.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? parsedPath.substring(lastSlash + 1) : parsedPath;
  const extIndex = baseName.lastIndexOf('.');
  const nameWithoutExt = extIndex >= 0 ? baseName.substring(0, extIndex) : baseName;

  const outputFilePath = join(dirname(csvFilePath) || '.', `${nameWithoutExt}.translated.csv`);

  await writeCSV(outputFilePath, mergedRecords, columns);

  return { outputFile: outputFilePath, missing };
}

// ============================================================================
// SPLIT
// ============================================================================

/**
 * Splits a CSV file into batch files under `<batchDir>/pending`.
 *
 * Stale batch files from previous runs (numbered above the new batch count)
 * are removed from both `pending/` and every `translated/<lang>/` directory.
 *
 * @param {string} csvFilePath - Path to the source CSV file
 * @param {number} batchSize - Number of records per batch
 * @param {string} batchDir - Base directory for batches
 * @returns {Promise<{batchCount: number, recordCount: number, removedStale: string[]}>}
 */
export async function splitBatches(csvFilePath, batchSize = 50, batchDir = 'batches', options = {}) {
  const { onProgress, onComplete } = options;

  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Invalid batchSize: ${batchSize}`);
  }

  const records = await readCSV(csvFilePath);

  if (records.length === 0) {
    const result = { batchCount: 0, recordCount: 0, removedStale: [] };
    if (onComplete) onComplete(result);
    return result;
  }

  const columns = Object.keys(records[0]);
  const pendingDir = join(batchDir, PENDING_DIR);
  await ensureDirectory(pendingDir);

  const numBatches = Math.ceil(records.length / batchSize);

  for (let i = 0; i < numBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, records.length);
    const batchRecords = records.slice(start, end);

    const batchFilePath = join(pendingDir, `batch-${i + 1}.csv`);
    await writeCSV(batchFilePath, batchRecords, columns);

    if (onProgress) {
      onProgress(i + 1, numBatches, batchRecords.length);
    }
  }

  // Remove stale batches so re-runs never translate obsolete records
  const removedStale = [...(await removeStaleBatches(pendingDir, numBatches))];
  const translatedBaseDir = join(batchDir, TRANSLATED_DIR);
  if (existsSync(translatedBaseDir)) {
    for (const entry of await readdir(translatedBaseDir)) {
      const langDir = join(translatedBaseDir, entry);
      try {
        const statInfo = await stat(langDir);
        if (statInfo.isDirectory()) {
          removedStale.push(...(await removeStaleBatches(langDir, numBatches)));
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }

  const result = { batchCount: numBatches, recordCount: records.length, removedStale };
  if (onComplete) {
    onComplete(result);
  }
  return result;
}

export default {
  splitBatches,
  runBatches,
  mergeBatches,
};

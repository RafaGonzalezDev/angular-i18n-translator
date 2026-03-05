import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { BatchRepository, PENDING_DIR, TRANSLATED_DIR } from './repositories/batch-repository.js';
import { TranslationProvider } from './providers/translation-provider.js';

const DEFAULT_BATCH_DIR = './batches';
const DEFAULT_CONCURRENCY = 5;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function toCsvString(records, columns, repository) {
  const tmpPath = `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.csv`;
  await repository.writeCSV(tmpPath, records, columns);
  const parsed = await repository.readCSV(tmpPath);
  return { parsed, tmpPath };
}

function hasAnyTranslation(records, targetLanguage) {
  return records.some(record => typeof record[targetLanguage] === 'string' && record[targetLanguage].trim() !== '');
}

async function processSingleBatch(batchFile, batchIndex, totalBatches, pendingDir, translatedDir, targetLanguage, config, options) {
  const {
    overwrite = false,
    resume = true,
    dryRun = false,
    onProgress,
    provider,
    repository
  } = options;

  const batchNumber = batchIndex + 1;
  const pendingFilePath = join(pendingDir, batchFile);
  const translatedFilePath = join(translatedDir, batchFile);
  const translatedExists = existsSync(translatedFilePath);

  const sourceFilePath = translatedExists ? translatedFilePath : pendingFilePath;
  const records = await repository.readCSV(sourceFilePath);
  const columns = Object.keys(records[0] || {});

  if (!overwrite && resume && translatedExists && hasAnyTranslation(records, targetLanguage)) {
    onProgress?.(batchNumber, totalBatches, 'skipped', { batchFile });
    return { status: 'skipped', batch: batchFile };
  }

  if (dryRun) {
    onProgress?.(batchNumber, totalBatches, 'planned', { batchFile });
    return { status: 'planned', batch: batchFile };
  }

  const translationColumns = ['id', 'source', 'note', 'meaning', targetLanguage];
  const translationRecords = records.map(record => {
    const slim = {};
    for (const col of translationColumns) {
      slim[col] = record[col] || '';
    }
    return slim;
  });

  const csvPayload = await new Promise((resolve, reject) => {
    const lines = [translationColumns.join(',')];
    for (const row of translationRecords) {
      const line = translationColumns.map(col => JSON.stringify(row[col] ?? '')).join(',');
      lines.push(line);
    }
    resolve(lines.join('\n'));
  });

  const translatedCSV = await provider.translateBatch(csvPayload, targetLanguage, config, {
    currentBatch: batchNumber,
    totalBatches
  });

  const translatedRows = await new Promise((resolve, reject) => {
    import('csv-parse').then(({ parse }) => {
      parse(translatedCSV, { columns: true, skip_empty_lines: true, trim: true }, (err, parsed) => {
        if (err) {
          reject(new Error(`Failed to parse translated CSV: ${err.message}`));
          return;
        }
        resolve(parsed);
      });
    }).catch(reject);
  });

  for (let i = 0; i < records.length; i++) {
    const translatedValue = translatedRows[i]?.[targetLanguage];
    if (typeof translatedValue === 'string' && translatedValue.trim() !== '') {
      records[i][targetLanguage] = translatedValue;
    }
  }

  await repository.writeCSV(translatedFilePath, records, columns);
  onProgress?.(batchNumber, totalBatches, 'completed', { batchFile });
  return { status: 'success', batch: batchFile };
}

async function processBatchesInParallel(batchFiles, pendingDir, translatedDir, targetLanguage, config, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, onProgress } = options;
  const summary = { processed: 0, skipped: 0, failed: 0, planned: 0, errors: [] };
  const chunks = chunkArray(batchFiles, concurrency);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    onProgress?.(chunkIndex + 1, chunks.length, 'chunk-start');

    const results = await Promise.allSettled(
      chunk.map((batchFile, indexInChunk) => {
        const batchIndex = chunkIndex * concurrency + indexInChunk;
        return processSingleBatch(
          batchFile,
          batchIndex,
          batchFiles.length,
          pendingDir,
          translatedDir,
          targetLanguage,
          config,
          options
        );
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        summary.failed++;
        summary.errors.push({ batch: 'unknown', error: result.reason?.message || 'Unknown error' });
        continue;
      }

      if (result.value.status === 'success') {
        summary.processed++;
      } else if (result.value.status === 'skipped') {
        summary.skipped++;
      } else if (result.value.status === 'planned') {
        summary.planned++;
      } else {
        summary.failed++;
      }
    }

    onProgress?.(chunkIndex + 1, chunks.length, 'chunk-complete', { summary });
  }

  return summary;
}

export async function runBatches(batchDir, targetLanguage, config, options = {}) {
  const repository = options.repository || new BatchRepository();
  const provider = options.provider || new TranslationProvider();
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  if (!batchDir) {
    throw new Error('batchDir is required');
  }
  if (!targetLanguage) {
    throw new Error('targetLanguage is required');
  }

  const pendingDir = join(batchDir, PENDING_DIR);
  const translatedDir = join(batchDir, TRANSLATED_DIR);
  await repository.ensureDirectory(translatedDir);

  const batchFiles = await repository.listPending(batchDir);
  if (batchFiles.length === 0) {
    return { processed: 0, skipped: 0, failed: 0, planned: 0, errors: [] };
  }

  return processBatchesInParallel(batchFiles, pendingDir, translatedDir, targetLanguage, config, {
    ...options,
    provider,
    repository,
    concurrency
  });
}

export async function mergeBatches(csvFilePath, batchDir = DEFAULT_BATCH_DIR, options = {}) {
  const repository = options.repository || new BatchRepository();

  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }

  const translatedDir = join(batchDir, TRANSLATED_DIR);
  if (!existsSync(translatedDir)) {
    throw new Error(`Translated batches directory not found: ${translatedDir}`);
  }

  const batchFiles = await repository.listTranslated(batchDir);
  if (batchFiles.length === 0) {
    throw new Error('No translated batch files found');
  }

  const originalRecords = existsSync(csvFilePath) ? await repository.readCSV(csvFilePath) : [];
  let columns = Object.keys(originalRecords[0] || {});

  const allTranslatedRecords = [];
  for (const file of batchFiles) {
    const records = await repository.readCSV(join(translatedDir, file));
    allTranslatedRecords.push(...records);
  }

  const translatedMap = new Map();
  for (const row of allTranslatedRecords) {
    if (row.id) {
      translatedMap.set(row.id, row);
    }
  }

  const mergedRecords = originalRecords.length > 0
    ? originalRecords.map(row => translatedMap.get(row.id) ? { ...translatedMap.get(row.id), id: row.id } : row)
    : allTranslatedRecords;

  if (columns.length === 0 && mergedRecords.length > 0) {
    columns = Object.keys(mergedRecords[0]);
  }

  const baseName = csvFilePath.split('/').pop() || 'messages.csv';
  const rootName = baseName.endsWith('.csv') ? baseName.slice(0, -4) : baseName;
  const outputFilePath = join(dirname(csvFilePath) || '.', `${rootName}.translated.csv`);

  await repository.writeCSV(outputFilePath, mergedRecords, columns);
  return outputFilePath;
}

export async function splitBatches(csvFilePath, batchSize = 50, batchDir = DEFAULT_BATCH_DIR, options = {}) {
  const repository = options.repository || new BatchRepository();
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  const records = await repository.readCSV(csvFilePath);
  if (records.length === 0) {
    return 0;
  }

  const pendingDir = join(batchDir, PENDING_DIR);
  await repository.ensureDirectory(pendingDir);

  const columns = Object.keys(records[0]);
  const numBatches = Math.ceil(records.length / batchSize);

  if (options.dryRun) {
    return numBatches;
  }

  for (let i = 0; i < numBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, records.length);
    const batchRecords = records.slice(start, end);
    await repository.writeCSV(join(pendingDir, `batch-${i + 1}.csv`), batchRecords, columns);
  }

  return numBatches;
}

export default {
  splitBatches,
  runBatches,
  mergeBatches
};

/**
 * Batch Manager Module
 * Handles splitting, processing, and merging CSV translation batches
 */

import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { translateBatch } from './llm-client.js';

// Default directories
const DEFAULT_BATCH_DIR = './batches';
const PENDING_DIR = 'pending';
const TRANSLATED_DIR = 'translated';

// Default concurrency for parallel batch processing
const DEFAULT_CONCURRENCY = 5;

/**
 * Ensures a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to ensure
 * @param {Object} verboseInfo - Optional object to accumulate verbose information
 * @returns {boolean} - True if directory was created, false if it already existed
 */
async function ensureDirectory(dirPath, verboseInfo = null) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
    if (verboseInfo) {
      verboseInfo.directoriesCreated.push(dirPath);
    }
    return true;
  }
  return false;
}

/**
 * Sorts batch files numerically (batch-1, batch-2, not batch-10 before batch-2)
 * @param {string[]} files - Array of file names
 * @returns {string[]} - Sorted file names
 */
function sortBatchFilesNumerically(files) {
  return files.sort((a, b) => {
    const numA = parseInt(a.replace(/[^0-9]/g, ''), 10);
    const numB = parseInt(b.replace(/[^0-9]/g, ''), 10);
    return numA - numB;
  });
}

/**
 * Reads and parses a CSV file
 * @param {string} filePath - Path to CSV file
 * @param {Object} verboseInfo - Optional object to accumulate verbose information
 * @returns {Promise<Array>} - Parsed CSV records
 */
async function readCSV(filePath, verboseInfo = null) {
  if (verboseInfo) {
    verboseInfo.filesRead.push(filePath);
  }
  
  const content = await readFile(filePath, 'utf-8');
  
  return new Promise((resolve, reject) => {
    parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }, (err, records) => {
      if (err) {
        reject(new Error(`Failed to parse CSV: ${err.message}`));
      } else {
        resolve(records);
      }
    });
  });
}

/**
 * Writes records to a CSV file
 * @param {string} filePath - Path to output CSV file
 * @param {Array} records - Array of records to write
 * @param {Array} columns - Column headers
 */
async function writeCSV(filePath, records, columns) {
  return new Promise((resolve, reject) => {
    stringify(records, { header: true, columns }, (err, output) => {
      if (err) {
        reject(new Error(`Failed to stringify CSV: ${err.message}`));
      } else {
        writeFile(filePath, output, 'utf-8')
          .then(() => resolve())
          .catch(reject);
      }
    });
  });
}

/**
 * Processes a single batch file
 * @param {string} batchFile - Name of the batch file
 * @param {number} batchIndex - Index of the batch (0-based)
 * @param {number} totalBatches - Total number of batches
 * @param {string} pendingDir - Path to pending directory
 * @param {string} translatedDir - Path to translated directory
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration
 * @param {Object} options - Additional options (force, onProgress)
 * @returns {Promise<Object>} - Result { status, batch, error? }
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
    // Read from translated if it exists (to preserve previous language translations)
    // Otherwise read from pending (original data)
    const sourceFilePath = existsSync(translatedFilePath) 
      ? translatedFilePath 
      : batchFilePath;
    const records = await readCSV(sourceFilePath);
    
    // Extract only the columns needed for translation: id, source, note, meaning, and targetLanguage
    // This ensures the LLM only sees and translates one language at a time
    const translationColumns = ['id', 'source', 'note', 'meaning', targetLanguage];
    const translationRecords = records.map(record => {
      const translated = {};
      for (const col of translationColumns) {
        translated[col] = record[col] || '';
      }
      return translated;
    });
    
    // Convert to CSV string for translation
    const csvContent = await new Promise((resolve, reject) => {
      stringify(translationRecords, { header: true, columns: translationColumns }, (err, output) => {
        if (err) reject(err);
        else resolve(output);
      });
    });

    // Translate the batch
    const translatedCSV = await translateBatch(csvContent, targetLanguage, config, {
      force,
      currentBatch: batchNumber,
      totalBatches
    });

    // Parse the translated CSV
    const translatedRecords = await new Promise((resolve, reject) => {
      parse(translatedCSV, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      }, (err, records) => {
        if (err) reject(new Error(`Failed to parse translated CSV: ${err.message}`));
        else resolve(records);
      });
    });

    // Update only the target language column in the original records
    for (let i = 0; i < records.length; i++) {
      records[i][targetLanguage] = translatedRecords[i]?.[targetLanguage] || records[i][targetLanguage];
    }
    
    // Get all columns for writing (preserve original structure)
    const columns = Object.keys(records[0] || {});
    
    // Write translated batch (with all columns preserved)
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
 * Processes batches in parallel with controlled concurrency
 * @param {string[]} batchFiles - Array of batch file names
 * @param {string} pendingDir - Path to pending directory
 * @param {string} translatedDir - Path to translated directory
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration
 * @param {Object} options - Additional options (force, onProgress, concurrency)
 * @returns {Promise<Object>} - Summary { processed, skipped, failed, errors: [] }
 */
async function processBatchesInParallel(batchFiles, pendingDir, translatedDir, targetLanguage, config, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, onProgress } = options;
  const totalBatches = batchFiles.length;
  
  const summary = { processed: 0, skipped: 0, failed: 0, errors: [] };
  
  // Process batches in chunks of `concurrency` size
  for (let chunkStart = 0; chunkStart < totalBatches; chunkStart += concurrency) {
    const chunkEnd = Math.min(chunkStart + concurrency, totalBatches);
    const chunk = batchFiles.slice(chunkStart, chunkEnd);
    const chunkNumber = Math.floor(chunkStart / concurrency) + 1;
    const totalChunks = Math.ceil(totalBatches / concurrency);

    // Create promises for all batches in this chunk
    const chunkPromises = chunk.map((batchFile, indexInChunk) => {
      const batchIndex = chunkStart + indexInChunk;
      return processSingleBatch(batchFile, batchIndex, totalBatches, pendingDir, translatedDir, targetLanguage, config, options);
    });

    // Wait for all batches in chunk to complete (using allSettled so failures don't stop others)
    const results = await Promise.allSettled(chunkPromises);

    // Process results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { status, batch, error } = result.value;
        if (status === 'success') {
          summary.processed++;
        } else {
          summary.failed++;
          if (error) {
            summary.errors.push({ batch, error });
          }
        }
      } else {
        // Promise rejected (shouldn't happen with our error handling, but just in case)
        summary.failed++;
        summary.errors.push({ batch: 'unknown', error: result.reason?.message || 'Unknown error' });
      }
    }
  }
  
  return summary;
}

/**
 * Processes all pending batches by calling translateBatch
 * @param {string} batchDir - Base directory for batches
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration (baseURL, model, apiKey, systemPrompt)
 * @param {Object} options - Options (force, onProgress, concurrency, verbose)
 * @returns {Promise<Object>} - Summary { processed, skipped, failed, errors: [], batchCount, verboseInfo? }
 */
export async function runBatches(batchDir, targetLanguage, config, options = {}) {
  const { 
    force = false, 
    onProgress, 
    onStart,
    onComplete, 
    onError,
    concurrency = DEFAULT_CONCURRENCY,
    verbose = false
  } = options;
  
  // Initialize verbose info accumulator
  const verboseInfo = {
    directoriesCreated: [],
    filesRead: [],
    languagesProcessed: [],
    totalBatches: 0,
    totalRecords: 0
  };
  
  if (onStart) {
    onStart({ 
      language: targetLanguage, 
      force, 
      concurrency 
    });
  }

  // Validate inputs
  if (!batchDir) {
    throw new Error('batchDir is required');
  }
  if (!targetLanguage) {
    throw new Error('targetLanguage is required');
  }
  if (!config || !config.baseURL || !config.model || !config.apiKey) {
    throw new Error('config must include baseURL, model, and apiKey');
  }

  // Set up directories
  const pendingDir = join(batchDir, PENDING_DIR);
  const translatedDir = join(batchDir, TRANSLATED_DIR, targetLanguage);

  // Ensure translated directory exists
  await ensureDirectory(translatedDir, verbose ? verboseInfo : null);

  // Check if pending directory exists
  if (!existsSync(pendingDir)) {
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [], batchCount: 0 };
    if (verbose) {
      summary.verboseInfo = verboseInfo;
    }
    if (onComplete) onComplete(summary);
    return summary;
  }

  // Get all pending batch files
  let pendingFiles;
  try {
    pendingFiles = await readdir(pendingDir);
  } catch (err) {
    throw new Error(`Failed to read pending directory: ${err.message}`);
  }

  // Filter for CSV files and sort numerically
  const batchFiles = sortBatchFilesNumerically(
    pendingFiles.filter(f => f.endsWith('.csv'))
  );

  if (batchFiles.length === 0) {
    const summary = { processed: 0, skipped: 0, failed: 0, errors: [], batchCount: 0 };
    if (verbose) {
      summary.verboseInfo = verboseInfo;
    }
    if (onComplete) onComplete(summary);
    return summary;
  }

  // Process batches in parallel
  const summary = await processBatchesInParallel(
    batchFiles,
    pendingDir,
    translatedDir,
    targetLanguage,
    config,
    { force, onProgress, concurrency }
  );

  // Add batch count to summary
  summary.batchCount = batchFiles.length;
  
  // Populate verbose info
  if (verbose) {
    verboseInfo.totalBatches = batchFiles.length;
    verboseInfo.languagesProcessed.push(targetLanguage);
    summary.verboseInfo = verboseInfo;
  }

  // Report errors through callback if provided
  if (summary.errors.length > 0 && onError) {
    for (const { batch, error } of summary.errors) {
      onError({ batch, error, language: targetLanguage });
    }
  }

  if (onComplete) {
    onComplete(summary);
  }

  return summary;
}

/**
 * Merges translated batches back into a main CSV file
 * @param {string} csvFilePath - Path to the original CSV file (for reference)
 * @param {string} batchDir - Base directory for batches
 * @param {Object} options - Options (verbose)
 * @returns {Promise<string|Object>} - Path to the merged CSV file, or object with outputFile and verboseInfo if verbose=true
 */
export async function mergeBatches(csvFilePath, batchDir = DEFAULT_BATCH_DIR, options = {}) {
  const { verbose = false } = options;
  
  // Initialize verbose info accumulator
  const verboseInfo = {
    languagesProcessed: [],
    batchesPerLanguage: {},
    totalBatches: 0,
    totalRecords: 0,
    filesRead: [],
    directoriesCreated: []
  };

  // Validate inputs
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }

  // Set up base translated directory
  const translatedBaseDir = join(batchDir, TRANSLATED_DIR);

  // Check if translated directory exists
  if (!existsSync(translatedBaseDir)) {
    throw new Error(`Translated batches directory not found: ${translatedBaseDir}`);
  }

  // Get all language subdirectories
  let languageDirs;
  try {
    const entries = await readdir(translatedBaseDir);
    // Filter only directories (each represents a language)
    const languages = [];
    for (const entry of entries) {
      const entryPath = join(translatedBaseDir, entry);
      try {
        const statInfo = await stat(entryPath);
        if (statInfo.isDirectory()) {
          languages.push(entry);
        }
      } catch (err) {
        // Skip entries we can't stat
      }
    }
    languageDirs = languages;
  } catch (err) {
    throw new Error(`Failed to read translated base directory: ${err.message}`);
  }

  if (languageDirs.length === 0) {
    throw new Error('No language directories found in translated folder');
  }

  // Read original CSV to get column structure and preserve non-translated records
  let originalRecords = [];
  let columns = [];

  if (existsSync(csvFilePath)) {
    originalRecords = await readCSV(csvFilePath, verbose ? verboseInfo : null);
    columns = Object.keys(originalRecords[0] || {});
  }

  // Collect translated data from all languages
  // Key: record id, Value: object with translations for each language
  const translationsById = new Map();

  for (const lang of languageDirs) {
    const langDir = join(translatedBaseDir, lang);
    
    // Track language processing
    if (verbose) {
      verboseInfo.languagesProcessed.push(lang);
      verboseInfo.batchesPerLanguage[lang] = 0;
    }

    // Get all batch files for this language
    let batchFiles;
    try {
      const files = await readdir(langDir);
      batchFiles = sortBatchFilesNumerically(
        files.filter(f => f.endsWith('.csv'))
      );
    } catch (err) {
      continue;
    }

    if (batchFiles.length === 0) {
      continue;
    }

    // Track batches for this language
    if (verbose) {
      verboseInfo.batchesPerLanguage[lang] = batchFiles.length;
      verboseInfo.totalBatches += batchFiles.length;
    }

    // Read all batches for this language
    for (const batchFile of batchFiles) {
      const batchFilePath = join(langDir, batchFile);

      try {
        const records = await readCSV(batchFilePath, verbose ? verboseInfo : null);

        for (const record of records) {
          if (!record.id) continue;

          if (!translationsById.has(record.id)) {
            translationsById.set(record.id, {});
          }

          const translations = translationsById.get(record.id);
          // Store the translation for this language
          if (record[lang] !== undefined) {
            translations[lang] = record[lang];
          }
        }
      } catch (err) {
        // Skip failed batches
      }
    }
  }

  // Track total records
  if (verbose) {
    verboseInfo.totalRecords = translationsById.size;
  }

  // Build merged records
  let mergedRecords;

  if (originalRecords.length > 0) {
    mergedRecords = originalRecords.map(originalRecord => {
      const id = originalRecord.id;

      if (id && translationsById.has(id)) {
        // Merge translations into the original record
        const translations = translationsById.get(id);
        return { ...originalRecord, ...translations };
      }

      // Keep original if no translation available
      return originalRecord;
    });
  } else {
    // No original file, build records from translations
    mergedRecords = [];
    for (const [id, translations] of translationsById) {
      mergedRecords.push({ id, ...translations });
    }

    // Determine columns from all translations
    const allColumns = new Set(['id']);
    for (const [id, translations] of translationsById) {
      Object.keys(translations).forEach(col => allColumns.add(col));
    }
    columns = Array.from(allColumns);
  }

  // Ensure all language columns are included in the output
  for (const lang of languageDirs) {
    if (!columns.includes(lang)) {
      columns.push(lang);
    }
  }

  // Generate output filename
  const parsedPath = csvFilePath.replace(/\\/g, '/');
  const lastSlash = parsedPath.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? parsedPath.substring(lastSlash + 1) : parsedPath;
  const extIndex = baseName.lastIndexOf('.');
  const nameWithoutExt = extIndex >= 0 ? baseName.substring(0, extIndex) : baseName;

  const outputFilePath = join(dirname(csvFilePath) || '.', `${nameWithoutExt}.translated.csv`);

  // Write merged CSV
  await writeCSV(outputFilePath, mergedRecords, columns);

  if (verbose) {
    return { outputFile: outputFilePath, verboseInfo };
  }
  return outputFilePath;
}

/**
 * Splits a CSV file into multiple batch files
 * @param {string} csvFilePath - Path to the source CSV file
 * @param {number} batchSize - Number of records per batch
 * @param {string} batchDir - Base directory for batches
 * @param {Object} options - Options (onProgress, onComplete, verbose)
 * @returns {Promise<number|Object>} - Number of batches created, or object with verboseInfo if verbose=true
 */
export async function splitBatches(csvFilePath, batchSize = 50, batchDir = DEFAULT_BATCH_DIR, options = {}) {
  const { onProgress, onComplete, verbose = false } = options;

  // Initialize verbose info accumulator
  const verboseInfo = {
    directoriesCreated: [],
    filesRead: [],
    languagesProcessed: [],
    totalBatches: 0,
    totalRecords: 0
  };

  // Validate inputs
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  // Read the source CSV
  const records = await readCSV(csvFilePath, verbose ? verboseInfo : null);

  if (records.length === 0) {
    const result = { batchCount: 0, recordCount: 0 };
    if (verbose) {
      result.verboseInfo = verboseInfo;
    }
    if (onComplete) onComplete(result);
    return verbose ? result : 0;
  }

  // Get column headers from first record
  const columns = Object.keys(records[0]);

  // Set up pending directory
  const pendingDir = join(batchDir, PENDING_DIR);
  await ensureDirectory(pendingDir, verbose ? verboseInfo : null);

  // Calculate number of batches
  const numBatches = Math.ceil(records.length / batchSize);

  // Split and write batches
  for (let i = 0; i < numBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, records.length);
    const batchRecords = records.slice(start, end);

    const batchFileName = `batch-${i + 1}.csv`;
    const batchFilePath = join(pendingDir, batchFileName);

    await writeCSV(batchFilePath, batchRecords, columns);

    if (onProgress) {
      onProgress(i + 1, numBatches, batchRecords.length);
    }
  }

  // Populate verbose info
  if (verbose) {
    verboseInfo.totalBatches = numBatches;
    verboseInfo.totalRecords = records.length;
  }

  const result = { batchCount: numBatches, recordCount: records.length };
  if (verbose) {
    result.verboseInfo = verboseInfo;
  }

  if (onComplete) {
    onComplete(result);
  }

  return verbose ? result : numBatches;
}

/**
 * Cleans up batch directories
 * @param {string} batchDir - Base directory for batches
 * @param {string} mode - Which directories to clean ('pending', 'translated', 'all')
 * @param {Object} options - Options (verbose)
 * @returns {Promise<Object|void>} - Object with mode and verboseInfo if verbose=true
 */
export async function cleanBatches(batchDir = DEFAULT_BATCH_DIR, mode = 'all', options = {}) {
  const { verbose = false } = options;

  // Initialize verbose info accumulator
  const verboseInfo = {
    directoriesCreated: [],
    filesRead: [],
    languagesProcessed: [],
    totalBatches: 0,
    totalRecords: 0,
    filesCleared: []
  };

  const dirsToClean = [];

  if (mode === 'pending' || mode === 'all') {
    dirsToClean.push(join(batchDir, PENDING_DIR));
  }
  if (mode === 'translated' || mode === 'all') {
    dirsToClean.push(join(batchDir, TRANSLATED_DIR));
  }

  for (const dir of dirsToClean) {
    if (existsSync(dir)) {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.endsWith('.csv')) {
          const filePath = join(dir, file);
          await writeFile(filePath, '', 'utf-8').catch(() => {});
          // Note: We don't delete files, just empty them to be safe
          if (verbose) {
            verboseInfo.filesCleared.push(filePath);
          }
        }
      }
    }
  }

  if (verbose) {
    return { mode, verboseInfo };
  }
}

export default {
  splitBatches,
  runBatches,
  mergeBatches,
  cleanBatches
};

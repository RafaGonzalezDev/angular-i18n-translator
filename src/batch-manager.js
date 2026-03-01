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
 */
async function ensureDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
    console.log(`[Batch] Created directory: ${dirPath}`);
  }
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
 * @returns {Promise<Array>} - Parsed CSV records
 */
async function readCSV(filePath) {
  console.log(`[Batch] Reading CSV file: ${filePath}`);
  
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

  console.log(`\n[Batch] Processing batch ${batchNumber}/${totalBatches}: ${batchFile}`);

  try {
    // Read from translated if it exists (to preserve previous language translations)
    // Otherwise read from pending (original data)
    const sourceFilePath = existsSync(translatedFilePath) 
      ? translatedFilePath 
      : batchFilePath;
    console.log(`[Batch] Reading from: ${sourceFilePath === translatedFilePath ? 'translated' : 'pending'}`);
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
    
    console.log(`[Batch] Successfully translated and saved: ${batchFile}`);
    
    if (onProgress) {
      onProgress(batchNumber, totalBatches, 'completed');
    }

    return { status: 'success', batch: batchFile };

  } catch (err) {
    console.error(`[Batch] Failed to process batch ${batchFile}: ${err.message}`);
    
    if (onProgress) {
      onProgress(batchNumber, totalBatches, 'failed');
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
    
    console.log(`\n[Batch] Processing chunk ${chunkNumber}/${totalChunks} (batches ${chunkStart + 1}-${chunkEnd} of ${totalBatches}) with concurrency ${concurrency}`);
    
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
    
    // Log progress after each chunk
    console.log(`[Batch] Chunk ${chunkNumber}/${totalChunks} complete. Progress: ${summary.processed} processed, ${summary.failed} failed`);
  }
  
  return summary;
}

/**
 * Processes all pending batches by calling translateBatch
 * @param {string} batchDir - Base directory for batches
 * @param {string} targetLanguage - Target language code
 * @param {Object} config - LLM configuration (baseURL, model, apiKey, systemPrompt)
 * @param {Object} options - Options (force, onProgress, concurrency)
 * @returns {Promise<Object>} - Summary { processed, skipped, failed, errors: [] }
 */
export async function runBatches(batchDir, targetLanguage, config, options = {}) {
  const { force = false, onProgress, concurrency = DEFAULT_CONCURRENCY } = options;
  
  console.log(`[Batch] Starting batch processing`);
  console.log(`[Batch] Target language: ${targetLanguage}`);
  console.log(`[Batch] Force mode: ${force}`);
  console.log(`[Batch] Concurrency: ${concurrency}`);

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
  const translatedDir = join(batchDir, TRANSLATED_DIR);
  
  // Ensure translated directory exists
  await ensureDirectory(translatedDir);

  // Check if pending directory exists
  if (!existsSync(pendingDir)) {
    console.log(`[Batch] No pending batches directory found: ${pendingDir}`);
    return { processed: 0, skipped: 0, failed: 0, errors: [] };
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
    console.log('[Batch] No pending batch files found');
    return { processed: 0, skipped: 0, failed: 0, errors: [] };
  }

  console.log(`[Batch] Found ${batchFiles.length} batch files to process`);

  // Process batches in parallel
  const summary = await processBatchesInParallel(
    batchFiles,
    pendingDir,
    translatedDir,
    targetLanguage,
    config,
    { force, onProgress, concurrency }
  );

  // Print error summary if there were failures
  if (summary.errors.length > 0) {
    console.log(`\n[Batch] Error Summary:`);
    for (const { batch, error } of summary.errors) {
      console.log(`  - ${batch}: ${error}`);
    }
  }

  console.log(`\n[Batch] Processing complete: ${summary.processed} processed, ${summary.skipped} skipped, ${summary.failed} failed`);
  return summary;
}

/**
 * Merges translated batches back into a main CSV file
 * @param {string} csvFilePath - Path to the original CSV file (for reference)
 * @param {string} batchDir - Base directory for batches
 * @returns {Promise<string>} - Path to the merged CSV file
 */
export async function mergeBatches(csvFilePath, batchDir = DEFAULT_BATCH_DIR) {
  console.log(`[Batch] Starting batch merge`);
  console.log(`[Batch] Original CSV: ${csvFilePath}`);
  console.log(`[Batch] Batch directory: ${batchDir}`);

  // Validate inputs
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }

  // Set up directories
  const translatedDir = join(batchDir, TRANSLATED_DIR);

  // Check if translated directory exists
  if (!existsSync(translatedDir)) {
    throw new Error(`Translated batches directory not found: ${translatedDir}`);
  }

  // Get all translated batch files
  let translatedFiles;
  try {
    translatedFiles = await readdir(translatedDir);
  } catch (err) {
    throw new Error(`Failed to read translated directory: ${err.message}`);
  }

  // Filter for CSV files and sort numerically
  const batchFiles = sortBatchFilesNumerically(
    translatedFiles.filter(f => f.endsWith('.csv'))
  );

  if (batchFiles.length === 0) {
    throw new Error('No translated batch files found');
  }

  console.log(`[Batch] Found ${batchFiles.length} translated batch files`);

  // Read original CSV to get column structure and preserve non-translated records
  let originalRecords = [];
  let columns = [];
  
  if (existsSync(csvFilePath)) {
    originalRecords = await readCSV(csvFilePath);
    columns = Object.keys(originalRecords[0] || {});
  }

  // Read all translated batches
  const allTranslatedRecords = [];
  
  for (const batchFile of batchFiles) {
    const batchFilePath = join(translatedDir, batchFile);
    console.log(`[Batch] Reading translated batch: ${batchFile}`);
    
    try {
      const records = await readCSV(batchFilePath);
      allTranslatedRecords.push(...records);
    } catch (err) {
      console.error(`[Batch] Warning: Failed to read batch ${batchFile}: ${err.message}`);
    }
  }

  console.log(`[Batch] Total translated records: ${allTranslatedRecords.length}`);

  // Create a map of translated content keyed by ID
  // This prioritizes translated content over original
  const translatedMap = new Map();
  
  for (const record of allTranslatedRecords) {
    if (record.id) {
      translatedMap.set(record.id, record);
    }
  }

  // If we have original records, merge them
  let mergedRecords;
  
  if (originalRecords.length > 0) {
    mergedRecords = originalRecords.map(originalRecord => {
      const id = originalRecord.id;
      
      if (id && translatedMap.has(id)) {
        // Use translated record, but preserve the ID
        const translated = translatedMap.get(id);
        return { ...translated, id };
      }
      
      // Keep original if no translation available
      return originalRecord;
    });
    
    console.log(`[Batch] Merged ${originalRecords.length} records (${translatedMap.size} translated)`);
  } else {
    // No original file, use translated records directly
    mergedRecords = allTranslatedRecords;
    columns = Object.keys(mergedRecords[0] || {});
    console.log(`[Batch] Using ${mergedRecords.length} translated records directly`);
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
  
  console.log(`[Batch] Merged CSV saved to: ${outputFilePath}`);
  return outputFilePath;
}

/**
 * Splits a CSV file into multiple batch files
 * @param {string} csvFilePath - Path to the source CSV file
 * @param {number} batchSize - Number of records per batch
 * @param {string} batchDir - Base directory for batches
 * @returns {Promise<number>} - Number of batches created
 */
export async function splitBatches(csvFilePath, batchSize = 50, batchDir = DEFAULT_BATCH_DIR) {
  console.log(`[Batch] Splitting CSV into batches`);
  console.log(`[Batch] Source: ${csvFilePath}`);
  console.log(`[Batch] Batch size: ${batchSize}`);
  console.log(`[Batch] Output directory: ${batchDir}`);

  // Validate inputs
  if (!csvFilePath) {
    throw new Error('csvFilePath is required');
  }
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  // Read the source CSV
  const records = await readCSV(csvFilePath);
  
  if (records.length === 0) {
    console.log('[Batch] No records found in CSV');
    return 0;
  }

  console.log(`[Batch] Found ${records.length} records`);

  // Get column headers from first record
  const columns = Object.keys(records[0]);
  
  // Set up pending directory
  const pendingDir = join(batchDir, PENDING_DIR);
  await ensureDirectory(pendingDir);

  // Calculate number of batches
  const numBatches = Math.ceil(records.length / batchSize);
  console.log(`[Batch] Creating ${numBatches} batches`);

  // Split and write batches
  for (let i = 0; i < numBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, records.length);
    const batchRecords = records.slice(start, end);
    
    const batchFileName = `batch-${i + 1}.csv`;
    const batchFilePath = join(pendingDir, batchFileName);
    
    await writeCSV(batchFilePath, batchRecords, columns);
    console.log(`[Batch] Created: ${batchFileName} (${batchRecords.length} records)`);
  }

  console.log(`[Batch] Split complete: ${numBatches} batches created`);
  return numBatches;
}

/**
 * Cleans up batch directories
 * @param {string} batchDir - Base directory for batches
 * @param {string} mode - Which directories to clean ('pending', 'translated', 'all')
 */
export async function cleanBatches(batchDir = DEFAULT_BATCH_DIR, mode = 'all') {
  console.log(`[Batch] Cleaning batch directories (mode: ${mode})`);
  
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
          console.log(`[Batch] Cleared: ${filePath}`);
        }
      }
    }
  }
  
  console.log('[Batch] Cleanup complete');
}

export default {
  splitBatches,
  runBatches,
  mergeBatches,
  cleanBatches
};

/**
 * Cleaner Module
 * Handles cleaning of batch and output directories
 */

import { readdir, rm, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Ensures a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to ensure
 */
async function ensureDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
    console.log(`[Cleaner] Created directory: ${dirPath}`);
  }
}

/**
 * Deletes all contents of a directory
 * @param {string} dirPath - Directory path to clean
 * @returns {Promise<number>} - Number of files/directories deleted
 */
async function cleanDirectory(dirPath) {
  try {
    await ensureDirectory(dirPath);
    
    const entries = await readdir(dirPath, { withFileTypes: true });
    let deletedCount = 0;
    
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      
      try {
        await rm(fullPath, { recursive: true, force: true });
        deletedCount++;
        console.log(`[Cleaner] Deleted: ${fullPath}`);
      } catch (error) {
        console.error(`[Cleaner] Failed to delete ${fullPath}: ${error.message}`);
      }
    }
    
    return deletedCount;
  } catch (error) {
    console.error(`[Cleaner] Error cleaning directory ${dirPath}: ${error.message}`);
    return 0;
  }
}

/**
 * Cleans the batch directories (pending and translated)
 * @param {string} batchDir - Base batch directory path (e.g., './batches')
 */
export async function cleanBatchDirectories(batchDir) {
  console.log('[Cleaner] Cleaning batch directories...');
  
  const pendingDir = `${batchDir}/pending`;
  const translatedDir = `${batchDir}/translated`;
  
  const pendingCount = await cleanDirectory(pendingDir);
  const translatedCount = await cleanDirectory(translatedDir);
  
  console.log(`[Cleaner] Batch directories cleaned: ${pendingCount + translatedCount} items deleted`);
}

/**
 * Cleans the output directory
 * @param {string} outputDir - Output directory path (e.g., './dist-i18n')
 */
export async function cleanOutputDirectory(outputDir) {
  console.log('[Cleaner] Cleaning output directory...');
  
  const deletedCount = await cleanDirectory(outputDir);
  
  console.log(`[Cleaner] Output directory cleaned: ${deletedCount} items deleted`);
}

/**
 * Deletes the main CSV and translated CSV files
 * @param {string} csvPath - Path to the main CSV file
 * @param {string} translatedCsvPath - Path to the translated CSV file
 */
export async function cleanCsvFiles(csvPath, translatedCsvPath) {
  console.log('[Cleaner] Cleaning CSV files...');
  
  let deletedCount = 0;
  
  // Delete main CSV file if it exists
  if (existsSync(csvPath)) {
    try {
      await unlink(csvPath);
      deletedCount++;
      console.log(`[Cleaner] Deleted CSV file: ${csvPath}`);
    } catch (error) {
      console.error(`[Cleaner] Failed to delete CSV file ${csvPath}: ${error.message}`);
    }
  }
  
  // Delete translated CSV file if it exists
  if (existsSync(translatedCsvPath)) {
    try {
      await unlink(translatedCsvPath);
      deletedCount++;
      console.log(`[Cleaner] Deleted translated CSV file: ${translatedCsvPath}`);
    } catch (error) {
      console.error(`[Cleaner] Failed to delete translated CSV file ${translatedCsvPath}: ${error.message}`);
    }
  }
  
  console.log(`[Cleaner] CSV files cleaned: ${deletedCount} files deleted`);
}

/**
 * Cleans both batch directories and output directory
 * @param {Object} config - Configuration object containing batchDir, outputDir, csvPath, and translatedCsvPath
 * @param {Object} options - Options object to control what to clean
 * @param {boolean} options.csv - Whether to clean CSV files (default: true)
 * @param {boolean} options.batches - Whether to clean batch directories (default: true)
 * @param {boolean} options.output - Whether to clean output directory (default: true)
 */
export async function cleanAll(config, options = { csv: true, batches: true, output: true }) {
  // Determine the appropriate cleanup message based on options
  let cleanupMessage = '[Cleaner] Starting full cleanup...';
  
  if (options.csv && !options.batches && !options.output) {
    cleanupMessage = '[Cleaner] Starting CSV cleanup...';
  } else if (!options.csv && options.batches && !options.output) {
    cleanupMessage = '[Cleaner] Starting batch directories cleanup...';
  } else if (!options.csv && !options.batches && options.output) {
    cleanupMessage = '[Cleaner] Starting output directory cleanup...';
  } else if (!options.csv && options.batches && options.output) {
    cleanupMessage = '[Cleaner] Starting cleanup (batches and output)...';
  }
  
  console.log(cleanupMessage);
  
  const batchDir = config.batchDir || './batches';
  const outputDir = config.outputDir || './dist-i18n';
  const csvPath = config.csvPath || './csv/translations.csv';
  const translatedCsvPath = config.translatedCsvPath || './csv/translations_translated.csv';
  
  // Clean CSV files if enabled
  if (options.csv) {
    await cleanCsvFiles(csvPath, translatedCsvPath);
  }
  
  // Clean batch directories if enabled
  if (options.batches) {
    await cleanBatchDirectories(batchDir);
  }
  
  // Clean output directory if enabled
  if (options.output) {
    await cleanOutputDirectory(outputDir);
  }
  
  console.log('[Cleaner] Full cleanup completed');
}

export default { cleanBatchDirectories, cleanOutputDirectory, cleanAll, cleanCsvFiles };

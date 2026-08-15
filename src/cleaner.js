/**
 * Cleaner Module
 *
 * Removes generated artifacts: batch directories, output directory and the
 * intermediate CSV files. Silent by design: returns what was removed so the
 * caller decides what to report.
 */

import { rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Cleans batch directories, the output directory, and the CSV files.
 *
 * @param {Object} paths - Paths to clean
 * @param {string} paths.batchDir - Batch directory (e.g. 'batches')
 * @param {string} paths.outputDir - Output directory (e.g. 'dist-i18n')
 * @param {string} paths.csvPath - Main CSV file (e.g. 'messages.csv')
 * @param {string} paths.translatedCsvPath - Translated CSV file
 * @returns {Promise<{removed: string[]}>} Removed file/directory paths
 */
export async function cleanAll(paths) {
  const removed = [];

  const directories = [
    join(paths.batchDir, 'pending'),
    join(paths.batchDir, 'translated'),
    paths.outputDir,
  ];

  for (const dir of directories) {
    if (!existsSync(dir)) continue;

    const entries = await readdir(dir);
    if (entries.length === 0) continue;

    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }

  // Remove the batch parent directory too if it is now empty
  if (existsSync(paths.batchDir)) {
    const remaining = await readdir(paths.batchDir);
    if (remaining.length === 0) {
      await rm(paths.batchDir, { recursive: true, force: true });
    }
  }

  for (const file of [paths.csvPath, paths.translatedCsvPath]) {
    if (file && existsSync(file)) {
      await rm(file, { force: true });
      removed.push(file);
    }
  }

  return { removed };
}

export default { cleanAll };

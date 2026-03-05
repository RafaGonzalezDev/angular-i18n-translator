import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';

export const PENDING_DIR = 'pending';
export const TRANSLATED_DIR = 'translated';

function sortBatchFilesNumerically(files) {
  return files.sort((a, b) => {
    const numA = parseInt(a.replace(/[^0-9]/g, ''), 10);
    const numB = parseInt(b.replace(/[^0-9]/g, ''), 10);
    return numA - numB;
  });
}

/**
 * BatchRepository contract:
 * - listPending(batchDir)
 * - listTranslated(batchDir)
 * - readCSV(filePath)
 * - writeCSV(filePath, records, columns)
 */
export class BatchRepository {
  async ensureDirectory(dirPath) {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
  }

  async listPending(batchDir) {
    const pendingDir = join(batchDir, PENDING_DIR);
    if (!existsSync(pendingDir)) {
      return [];
    }

    const files = await readdir(pendingDir);
    return sortBatchFilesNumerically(files.filter(f => f.endsWith('.csv')));
  }

  async listTranslated(batchDir) {
    const translatedDir = join(batchDir, TRANSLATED_DIR);
    if (!existsSync(translatedDir)) {
      return [];
    }

    const files = await readdir(translatedDir);
    return sortBatchFilesNumerically(files.filter(f => f.endsWith('.csv')));
  }

  async readCSV(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return new Promise((resolve, reject) => {
      parse(content, { columns: true, skip_empty_lines: true, trim: true }, (err, records) => {
        if (err) {
          reject(new Error(`Failed to parse CSV: ${err.message}`));
          return;
        }
        resolve(records);
      });
    });
  }

  async writeCSV(filePath, records, columns) {
    return new Promise((resolve, reject) => {
      stringify(records, { header: true, columns }, async (err, output) => {
        if (err) {
          reject(new Error(`Failed to stringify CSV: ${err.message}`));
          return;
        }
        try {
          await writeFile(filePath, output, 'utf-8');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export default BatchRepository;

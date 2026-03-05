import { parse as csvParseSync } from 'csv-parse/sync';
import { stringify as csvStringifySync } from 'csv-stringify/sync';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { parseXLFString, generateXLF } from './xlf-parser.js';

export function xlfToCsv(xlfFilePath, csvOutputPath, targetLanguages, options = {}) {
  if (!xlfFilePath || typeof xlfFilePath !== 'string') {
    throw new Error(`Invalid XLF file path: ${xlfFilePath}`);
  }
  if (!csvOutputPath || typeof csvOutputPath !== 'string') {
    throw new Error(`Invalid CSV output path: ${csvOutputPath}`);
  }
  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    throw new Error('targetLanguages must be a non-empty array');
  }
  if (!existsSync(xlfFilePath)) {
    throw new Error(`XLF file not found: ${xlfFilePath}`);
  }

  const xlfContent = readFileSync(xlfFilePath, 'utf-8');
  const translationUnits = parseXLFString(xlfContent);
  const columns = ['id', 'source', 'note', 'meaning', ...targetLanguages];

  const csvData = translationUnits.map(unit => {
    const row = {
      id: unit.id || '',
      source: unit.source || '',
      note: unit.note || '',
      meaning: unit.meaning || ''
    };
    for (const lang of targetLanguages) {
      row[lang] = unit.source || '';
    }
    return row;
  });

  const csvOutput = csvStringifySync(csvData, {
    columns,
    header: true,
    quoted_string: true
  });

  const outputDir = dirname(resolve(csvOutputPath));
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(csvOutputPath, csvOutput, 'utf-8');
  return csvOutputPath;
}

export function csvToXlf(csvFilePath, outputDir, languages, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';

  if (!csvFilePath || typeof csvFilePath !== 'string') {
    throw new Error(`Invalid CSV file path: ${csvFilePath}`);
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error(`Invalid output directory: ${outputDir}`);
  }
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('languages must be a non-empty array');
  }
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  const csvContent = readFileSync(csvFilePath, 'utf-8');
  const csvData = csvParseSync(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const resolvedOutputDir = resolve(outputDir);
  if (!existsSync(resolvedOutputDir)) {
    mkdirSync(resolvedOutputDir, { recursive: true });
  }

  const generatedFiles = {};
  for (const lang of languages) {
    const translations = csvData.map(row => ({
      id: row.id || '',
      source: row.source || '',
      target: row[lang] || '',
      note: row.note || '',
      meaning: row.meaning || ''
    })).filter(row => row.id);

    const outputPath = resolve(resolvedOutputDir, `${original}.${lang}.xlf`);
    generateXLF(translations, lang, outputPath, { sourceLanguage, original });
    generatedFiles[lang] = outputPath;
  }

  return generatedFiles;
}

export default {
  xlfToCsv,
  csvToXlf
};

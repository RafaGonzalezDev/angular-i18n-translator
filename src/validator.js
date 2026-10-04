import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCsvRecords } from './csv-records.js';
import { validateMessage, isMissingTranslation } from './message-content.js';

export const Severity = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

function summarize(issues, strict) {
  const counts = { totalIssues: issues.length, errors: 0, warnings: 0, info: 0, allValid: true };
  for (const issue of issues) counts[`${issue.severity}s` in counts ? `${issue.severity}s` : 'info']++;
  counts.allValid = counts.errors === 0 && (!strict || counts.warnings === 0);
  return counts;
}

/** Pure record validation; file readers enforce the canonical CSV version. */
export function validateRecords(records, languages, { columns = Object.keys(records[0] || {}), lines = [], strict = false } = {}) {
  const issues = [];
  const contentIssues = [];
  const idIssues = [];
  const locations = new Map();
  const duplicates = [];
  const messageCache = new Map();
  const coverage = Object.create(null);
  const missingColumns = ['id', 'source', ...languages].filter(column => !columns.includes(column));
  for (const column of missingColumns) issues.push({ id: 'N/A', language: 'N/A', line: 1, severity: Severity.ERROR, issue: `Missing required column: ${column}` });
  records.forEach((row, index) => {
    const line = lines[index] || index + 2;
    if (typeof row.id !== 'string' || !row.id.trim()) {
      idIssues.push({ id: 'N/A', language: 'N/A', line, severity: Severity.ERROR, issue: 'Missing id' });
    } else {
      const previous = locations.get(row.id) || [];
      previous.push(line);
      locations.set(row.id, previous);
    }
    for (const language of languages) {
      if (!columns.includes(language)) continue;
      const source = row.source || '';
      const target = row[language] || '';
      const base = { id: row.id || 'N/A', language, line, context: { source, target } };
      if (isMissingTranslation(source, target)) {
        contentIssues.push({ ...base, severity: Severity.ERROR, issue: 'Missing translation', suggestion: 'Fill the target cell; source fallback is not allowed' });
        continue;
      }
      const cacheKey = JSON.stringify([source, target]);
      let errors = messageCache.get(cacheKey);
      if (!errors) {
        errors = validateMessage(source, target);
        if (messageCache.size < 256) messageCache.set(cacheKey, errors);
      }
      for (const issue of errors) contentIssues.push({ ...base, severity: Severity.ERROR, issue });
      if (target === source && source.trim()) {
        contentIssues.push({ ...base, severity: Severity.WARNING, issue: 'Translation identical to source; review if intentional' });
      }
    }
  });
  for (const [id, idLines] of locations) {
    if (idLines.length > 1) {
      duplicates.push({ id, lines: idLines, count: idLines.length });
      idIssues.push({ id, language: 'N/A', line: idLines[0], severity: Severity.ERROR, issue: `Duplicate id: ${id} (lines ${idLines.join(', ')})` });
    }
  }
  for (const language of languages) {
    let translated = 0, identical = 0, missing = 0;
    for (const row of records) {
      const value = row[language] || '';
      if (!columns.includes(language) || isMissingTranslation(row.source || '', value)) missing++;
      else if (value === (row.source || '')) identical++;
      else translated++;
    }
    coverage[language] = {
      total: records.length, translated, identical, missing,
      percentage: records.length ? Math.round((translated + identical) * 100 / records.length) : 0,
      severity: missing || !columns.includes(language) ? Severity.ERROR : identical ? Severity.WARNING : Severity.INFO,
    };
  }
  for (const issue of idIssues) issues.push(issue);
  for (const issue of contentIssues) issues.push(issue);
  if (!records.length) issues.push({ id: 'N/A', language: 'N/A', line: 1, severity: Severity.ERROR, issue: 'CSV contains no translation records' });
  const summary = summarize(issues, strict);
  return {
    timestamp: new Date().toISOString(), languages, issues, summary,
    validations: {
      interpolations: { valid: !contentIssues.some(issue => issue.severity === Severity.ERROR) && !missingColumns.length, issues: [...issues.filter(issue => issue.line === 1), ...contentIssues] },
      uniqueIds: { valid: idIssues.length === 0, duplicates, issues: idIssues },
      coverage,
    },
  };
}

function failedReport(error, languages, file) {
  const issue = { id: 'N/A', language: 'N/A', line: error.lines || 1, severity: Severity.ERROR, issue: error.message };
  const result = validateRecords([], languages, { columns: ['id', 'source', ...languages] });
  result.file = file;
  result.issues = [issue];
  result.summary = summarize(result.issues, false);
  result.validations.interpolations = { valid: false, issues: [issue] };
  result.validations.uniqueIds = { valid: false, duplicates: [], issues: [issue] };
  for (const language of languages) result.validations.coverage[language] = { total: 0, translated: 0, identical: 0, missing: 0, percentage: 0, severity: Severity.ERROR, error: error.message };
  return result;
}

export function validateAll(csvFilePath, languages, options = {}) {
  try {
    const parsed = parseCsvRecords(readFileSync(resolve(csvFilePath), 'utf8'), { requireFormat: true });
    const report = validateRecords(parsed.records, languages, { ...parsed, strict: options.strict });
    report.file = resolve(csvFilePath);
    return report;
  } catch (error) {
    return failedReport(error, languages, csvFilePath);
  }
}

export function validateInterpolations(csvFilePath, languages) {
  return validateAll(csvFilePath, languages).validations.interpolations;
}
export function validateUniqueIds(csvFilePath) {
  return validateAll(csvFilePath, []).validations.uniqueIds;
}
export function validateCoverage(csvFilePath, languages) {
  return validateAll(csvFilePath, languages).validations.coverage;
}

export function printReport(report) {
  console.log(`Validation: ${report.file || 'records'}`);
  for (const issue of report.issues) console.log(`[${issue.severity}] ${issue.language}/${issue.id}:${issue.line} ${issue.issue}`);
  for (const [language, value] of Object.entries(report.validations.coverage)) {
    console.log(`${language}: ${value.percentage}% populated; different=${value.translated}, identical=${value.identical}, missing=${value.missing}`);
  }
  console.log(`${report.summary.allValid ? 'Validation passed' : 'Validation failed'}: ${report.summary.errors} errors, ${report.summary.warnings} warnings`);
}

export function validate(csvFilePath, languages, options = {}) {
  if (!csvFilePath || !Array.isArray(languages) || !languages.length) {
    console.error('CSV path and target languages are required');
    return 1;
  }
  if (!existsSync(resolve(csvFilePath))) {
    console.error(`CSV file not found: ${csvFilePath}`);
    return 1;
  }
  const report = validateAll(csvFilePath, languages, options);
  if (options.verbose) printReport(report);
  else for (const issue of report.issues.filter(issue => issue.severity === Severity.ERROR || (options.strict && issue.severity === Severity.WARNING))) console.error(`[${issue.severity}] ${issue.language}/${issue.id}:${issue.line} ${issue.issue}`);
  return report.summary.allValid ? 0 : 1;
}

export default { validateRecords, validateInterpolations, validateUniqueIds, validateCoverage, validateAll, validate, printReport, Severity };

import { parse as csvParseSync } from 'csv-parse/sync';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { colors } from './cli/ui.js';

/**
 * Severity levels for validation issues
 */
export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

/**
 * Log a message with optional color
 * @param {string} message - Message to log
 * @param {function} colorFn - Optional color function from ui.js colors
 */
function log(message, colorFn = null) {
  if (colorFn) {
    console.log(colorFn(message));
  } else {
    console.log(message);
  }
}

/**
 * Get color function based on severity
 * @param {string} severity - Severity level
 * @returns {function} Color function
 */
function getSeverityColor(severity) {
  switch (severity) {
    case Severity.ERROR:
      return colors.error;
    case Severity.WARNING:
      return colors.warning;
    case Severity.INFO:
      return colors.info;
    default:
      return colors.info;
  }
}

/**
 * Extract interpolation variables from text
 * Matches {{variable}} patterns including nested brackets
 * @param {string} text - Text to extract interpolations from
 * @returns {string[]} Array of interpolation variable names
 */
function extractInterpolations(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // Match {{...}} patterns including nested brackets
  const matches = text.match(/\{\{[^}]+\}\}/g) || [];
  
  return matches.map(match => {
    // Remove {{ and }} and trim whitespace
    return match.slice(2, -2).trim();
  });
}

/**
 * Extracts inline XLIFF placeholder signatures (<x/>, <g>, ...) from text.
 * Each tag is represented as `name#id` (id attribute, or positional index
 * when absent) so multisets can be compared between source and translation.
 * @param {string} text
 * @returns {string[]}
 */
function extractInlineTags(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const signatures = [];
  const tagRe = /<(x|g|bx|ex|ph|bpt|ept|sub|mrk|it)\b([^>]*?)\/?>/gi;

  let positional = 0;
  for (const match of text.matchAll(tagRe)) {
    const name = match[1].toLowerCase();
    const idMatch = /\bid="([^"]*)"/.exec(match[2]);
    const id = idMatch ? idMatch[1] : `pos${positional}`;
    positional++;
    signatures.push(`${name}#${id}`);
  }

  return signatures;
}

/**
 * Detects ICU message format (plural/select) in text.
 * @param {string} text
 * @returns {boolean}
 */
function hasIcuFormat(text) {
  if (!text || typeof text !== 'string') return false;
  return /\{\s*[\w.]+\s*,\s*(plural|select|selectordinal)\s*,/.test(text);
}

/**
 * Checks that curly braces are balanced in text.
 * @param {string} text
 * @returns {boolean}
 */
function bracesBalanced(text) {
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Removes values present in `remove` from a copy of `base` (multiset diff).
 * @param {string[]} base
 * @param {string[]} remove
 * @returns {string[]}
 */
function multisetDiff(base, remove) {
  const remaining = [...remove];
  const result = [];

  for (const item of base) {
    const index = remaining.indexOf(item);
    if (index === -1) {
      result.push(item);
    } else {
      remaining.splice(index, 1);
    }
  }
  return result;
}

/**
 * Compare two interpolation arrays and find differences
 * @param {string[]} sourceVars - Source interpolation variables
 * @param {string[]} targetVars - Target interpolation variables
 * @returns {string[]} Missing variables in target
 */
function findMissingInterpolations(sourceVars, targetVars) {
  const missing = [];
  
  for (const variable of sourceVars) {
    if (!targetVars.includes(variable)) {
      missing.push(variable);
    }
  }
  
  return missing;
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength = 50) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Build context string for interpolation issues
 * @param {string} sourceText - Source text
 * @param {string} targetText - Target text
 * @returns {string} Context string
 */
function buildContext(sourceText, targetText) {
  const source = truncateText(sourceText, 40);
  const target = truncateText(targetText, 40);
  return `Source: "${source}" | Translation: "${target}"`;
}

/**
 * Read and parse CSV file
 * @param {string} csvFilePath - Path to CSV file
 * @returns {{data: Object[], columns: string[]}} Parsed CSV data
 * @throws {Error} If file doesn't exist or parsing fails
 */
function readCsvFile(csvFilePath) {
  const resolvedPath = resolve(csvFilePath);
  
  if (!existsSync(resolvedPath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  let csvContent;
  try {
    csvContent = readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read CSV file: ${error.message}`);
  }

  let data;
  try {
    data = csvParseSync(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }

  // Get columns from first row if available
  const columns = data.length > 0 ? Object.keys(data[0]) : [];

  return { data, columns };
}

/**
 * Validate interpolation variables between source and translations
 * @param {string} csvFilePath - Path to CSV file
 * @param {string[]} languages - Array of language codes to validate
 * @returns {{valid: boolean, issues: Array}} Validation result
 */
export function validateInterpolations(csvFilePath, languages) {
  const issues = [];
  
  try {
    const { data, columns } = readCsvFile(csvFilePath);
    
    // Check if required columns exist
    if (!columns.includes('id') || !columns.includes('source')) {
      issues.push({
        id: 'N/A',
        language: 'structure',
        line: 1,
        severity: Severity.ERROR,
        issue: 'Missing required columns: id or source',
        suggestion: 'Ensure CSV has "id" and "source" columns'
      });
      return { valid: false, issues };
    }

    // Validate each row with line tracking
    for (const [rowIndex, row] of data.entries()) {
      const lineNumber = rowIndex + 2; // +2 for header row and 0-index
      const id = row.id || '';
      const sourceText = row.source || '';
      const sourceVars = extractInterpolations(sourceText);

      // Skip empty rows
      if (!id && !sourceText) {
        continue;
      }

      // Check each language column
      for (const lang of languages) {
        // Check if language column exists
        if (!columns.includes(lang)) {
          issues.push({
            id,
            language: lang,
            line: lineNumber,
            severity: Severity.ERROR,
            issue: `Language column '${lang}' not found in CSV`,
            suggestion: `Add column '${lang}' to the CSV file`
          });
          continue;
        }

        const targetText = row[lang] || '';
        const targetVars = extractInterpolations(targetText);

        // Check for missing interpolations (critical error)
        const missing = findMissingInterpolations(sourceVars, targetVars);
        
        for (const variable of missing) {
          issues.push({
            id,
            language: lang,
            line: lineNumber,
            severity: Severity.ERROR,
            issue: `Missing interpolation: {{${variable}}}`,
            suggestion: `Add {{${variable}}} to the translation`,
            context: buildContext(sourceText, targetText)
          });
        }

        // Check for extra interpolations (warning - not critical)
        const extra = findMissingInterpolations(targetVars, sourceVars);
        for (const variable of extra) {
          issues.push({
            id,
            language: lang,
            line: lineNumber,
            severity: Severity.WARNING,
            issue: `Extra interpolation not in source: {{${variable}}}`,
            suggestion: `Remove {{${variable}}} from translation or verify source`,
            context: buildContext(sourceText, targetText)
          });
        }

        // Check inline XLIFF placeholders (<x/>, <g>, ...)
        const sourceTags = extractInlineTags(sourceText);
        const targetTags = extractInlineTags(targetText);

        for (const signature of multisetDiff(sourceTags, targetTags)) {
          issues.push({
            id,
            language: lang,
            line: lineNumber,
            severity: Severity.ERROR,
            issue: `Missing placeholder: <${signature.split('#')[0]} id="${signature.split('#')[1]}">`,
            suggestion: 'Keep inline placeholders like <x id="..."/> exactly as in the source',
            context: buildContext(sourceText, targetText)
          });
        }

        for (const signature of multisetDiff(targetTags, sourceTags)) {
          issues.push({
            id,
            language: lang,
            line: lineNumber,
            severity: Severity.WARNING,
            issue: `Extra placeholder not in source: <${signature.split('#')[0]} id="${signature.split('#')[1]}">`,
            suggestion: 'Remove the placeholder or verify the source',
            context: buildContext(sourceText, targetText)
          });
        }

        // Check ICU message format structure
        if (hasIcuFormat(sourceText)) {
          if (!hasIcuFormat(targetText)) {
            issues.push({
              id,
              language: lang,
              line: lineNumber,
              severity: Severity.ERROR,
              issue: 'Missing ICU message format (plural/select)',
              suggestion: 'Keep the {var, plural, ...} structure; translate only the text inside the braces',
              context: buildContext(sourceText, targetText)
            });
          } else if (!bracesBalanced(targetText)) {
            issues.push({
              id,
              language: lang,
              line: lineNumber,
              severity: Severity.ERROR,
              issue: 'Unbalanced braces in ICU message',
              suggestion: 'Check that every { has a matching }',
              context: buildContext(sourceText, targetText)
            });
          }
        }
      }
    }

    return {
      valid: issues.filter(i => i.severity === Severity.ERROR).length === 0,
      issues
    };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        id: 'N/A',
        language: 'error',
        line: 0,
        severity: Severity.ERROR,
        issue: error.message,
        suggestion: 'Check file path and permissions'
      }]
    };
  }
}

/**
 * Validate unique IDs in CSV
 * @param {string} csvFilePath - Path to CSV file
 * @returns {{valid: boolean, duplicates: Array, issues: Array}} Validation result
 */
export function validateUniqueIds(csvFilePath) {
  try {
    const { data, columns } = readCsvFile(csvFilePath);
    
    if (!columns.includes('id')) {
      return {
        valid: false,
        duplicates: [],
        issues: [{
          line: 1,
          severity: Severity.ERROR,
          issue: 'Missing required column: id',
          suggestion: 'Add "id" column to CSV file'
        }]
      };
    }

    const idLocations = {}; // Track line numbers for each ID

    for (const [rowIndex, row] of data.entries()) {
      const lineNumber = rowIndex + 2;
      const id = row.id || '';
      if (!id) continue; // Skip empty IDs

      if (!idLocations[id]) {
        idLocations[id] = [];
      }
      idLocations[id].push(lineNumber);
    }

    // Find duplicates (IDs appearing more than once)
    const duplicates = Object.entries(idLocations)
      .filter(([id, lines]) => lines.length > 1)
      .map(([id, lines]) => ({
        id,
        lines,
        count: lines.length
      }));

    return {
      valid: duplicates.length === 0,
      duplicates
    };
  } catch (error) {
    return {
      valid: false,
      duplicates: [],
      issues: [{
        line: 0,
        severity: Severity.ERROR,
        issue: error.message,
        suggestion: 'Check file path and permissions'
      }]
    };
  }
}

/**
 * Validate translation coverage per language.
 *
 * A row counts as translated when the target cell is non-empty AND differs
 * from the source text. Rows identical to the source are reported separately
 * (they may be legitimate loanwords, but are usually untranslated rows).
 *
 * @param {string} csvFilePath - Path to CSV file
 * @param {string[]} languages - Array of language codes
 * @returns {Object} Coverage data per language
 */
export function validateCoverage(csvFilePath, languages) {
  try {
    const { data, columns } = readCsvFile(csvFilePath);
    
    // Filter out empty rows (no id and no source)
    const validRows = data.filter(row => row.id || row.source);
    const total = validRows.length;

    const coverage = {};

    for (const lang of languages) {
      if (!columns.includes(lang)) {
        coverage[lang] = {
          total,
          translated: 0,
          identical: 0,
          percentage: 0,
          severity: Severity.ERROR
        };
        continue;
      }

      let translated = 0;
      let identical = 0;

      for (const row of validRows) {
        const value = row[lang];
        if (!value || value.trim().length === 0) {
          continue;
        }
        if (value === row.source) {
          identical++;
        } else {
          translated++;
        }
      }

      const percentage = total > 0 ? Math.round((translated / total) * 100) : 0;

      // Determine severity based on coverage
      let severity;
      if (percentage === 100) {
        severity = Severity.INFO;
      } else if (percentage >= 80) {
        severity = Severity.WARNING;
      } else {
        severity = Severity.ERROR;
      }

      coverage[lang] = {
        total,
        translated,
        identical,
        percentage,
        severity,
        missing: total - translated
      };
    }

    return coverage;
  } catch (error) {
    // Return empty coverage on error
    const coverage = {};
    for (const lang of languages) {
      coverage[lang] = {
        total: 0,
        translated: 0,
        identical: 0,
        percentage: 0,
        severity: Severity.ERROR,
        error: error.message
      };
    }
    return coverage;
  }
}

/**
 * Run all validations and return comprehensive report
 * @param {string} csvFilePath - Path to CSV file
 * @param {string[]} languages - Array of language codes
 * @returns {Object} Complete validation report
 */
export function validateAll(csvFilePath, languages) {
  const report = {
    timestamp: new Date().toISOString(),
    file: csvFilePath,
    languages,
    validations: {},
    summary: {
      totalIssues: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      allValid: true
    }
  };

  // Run interpolation validation
  const interpolationResult = validateInterpolations(csvFilePath, languages);
  report.validations.interpolations = interpolationResult;
  
  // Count by severity
  for (const issue of interpolationResult.issues) {
    report.summary.totalIssues++;
    if (issue.severity === Severity.ERROR) {
      report.summary.errors++;
      report.summary.allValid = false;
    } else if (issue.severity === Severity.WARNING) {
      report.summary.warnings++;
    } else {
      report.summary.info++;
    }
  }

  // Run unique ID validation
  const uniqueIdsResult = validateUniqueIds(csvFilePath);
  report.validations.uniqueIds = uniqueIdsResult;
  if (!uniqueIdsResult.valid) {
    report.summary.totalIssues += uniqueIdsResult.duplicates.length;
    report.summary.errors += uniqueIdsResult.duplicates.length;
    report.summary.allValid = false;
  }

  // Run coverage validation
  const coverageResult = validateCoverage(csvFilePath, languages);
  report.validations.coverage = coverageResult;

  return report;
}

/**
 * Print validation report to console with colors
 * @param {Object} report - Validation report from validateAll
 */
export function printReport(report) {
  log('');
  log('═'.repeat(60), colors.highlight);
  log('  Translation Validation Report', colors.highlight);
  log('═'.repeat(60), colors.highlight);
  log('');

  log(`File: ${report.file}`, colors.path);
  log(`Languages: ${report.languages.join(', ')}`, colors.path);
  log(`Timestamp: ${report.timestamp}`, colors.dim);
  log('');

  // Print interpolation issues
  log('─'.repeat(60), colors.brand);
  log('  Interpolation Validation', colors.brand);
  log('─'.repeat(60), colors.brand);
  
  const interp = report.validations.interpolations;
  const errorIssues = interp.issues.filter(i => i.severity === Severity.ERROR);
  const warningIssues = interp.issues.filter(i => i.severity === Severity.WARNING);
  const infoIssues = interp.issues.filter(i => i.severity === Severity.INFO);
  
  if (interp.issues.length === 0) {
    log('  ✓ All interpolations match', colors.success);
  } else {
    if (errorIssues.length > 0) {
      log(`  ✗ Found ${errorIssues.length} error(s)`, colors.error);
    }
    if (warningIssues.length > 0) {
      log(`  ⚠ Found ${warningIssues.length} warning(s)`, colors.warning);
    }
    if (infoIssues.length > 0) {
      log(`  ℹ Found ${infoIssues.length} info message(s)`, colors.info);
    }
    log('');

    // Group issues by language
    const byLanguage = {};
    for (const issue of interp.issues) {
      if (!byLanguage[issue.language]) {
        byLanguage[issue.language] = [];
      }
      byLanguage[issue.language].push(issue);
    }

    for (const [lang, issues] of Object.entries(byLanguage)) {
      log(`  Language: ${lang}`, colors.highlight);
      for (const issue of issues) {
        const severityColor = getSeverityColor(issue.severity);
        const severityLabel = `[${issue.severity.toUpperCase()}]`;
        
        // Main issue line with line number
        log(`    Line ${issue.line}: [${issue.id}] ${severityLabel} ${issue.issue}`, severityColor);
        
        // Show context if available
        if (issue.context) {
          log(`      Context: ${issue.context}`, colors.dim);
        }
        
        // Show suggestion if available
        if (issue.suggestion) {
          log(`      Suggestion: ${issue.suggestion}`, colors.dim);
        }
      }
    }
  }
  log('');

  // Print unique ID issues
  log('─'.repeat(60), colors.brand);
  log('  Unique ID Validation', colors.brand);
  log('─'.repeat(60), colors.brand);
  
  const uniqueIds = report.validations.uniqueIds;
  if (uniqueIds.valid) {
    log('  ✓ All IDs are unique', colors.success);
  } else {
    log(`  ✗ Found ${uniqueIds.duplicates.length} duplicate ID(s)`, colors.error);
    log('');
    
    for (const dup of uniqueIds.duplicates) {
      log(`    ID "${dup.id}" appears ${dup.count} times at lines: ${dup.lines.join(', ')}`, colors.error);
      log(`      Suggestion: Rename one of the duplicate IDs to be unique`, colors.dim);
    }
  }
  log('');

  // Print coverage
  log('─'.repeat(60), colors.brand);
  log('  Translation Coverage', colors.brand);
  log('─'.repeat(60), colors.brand);
  
  const coverage = report.validations.coverage;
  for (const [lang, stats] of Object.entries(coverage)) {
    const percentage = stats.percentage;
    
    // Select color based on coverage
    let colorFn;
    if (percentage === 100) {
      colorFn = colors.success;
    } else if (percentage >= 80) {
      colorFn = colors.warning;
    } else {
      colorFn = colors.error;
    }

    const bar = '█'.repeat(Math.floor(percentage / 10)) + '░'.repeat(10 - Math.floor(percentage / 10));
    const missingText = stats.missing > 0 ? ` (${stats.missing} missing)` : '';
    log(`  ${lang}: [${bar}] ${percentage}% (${stats.translated}/${stats.total})${missingText}`, colorFn);
    if (stats.identical > 0) {
      log(`    ${stats.identical} row(s) identical to source - verify they are really translated`, colors.warning);
    }
  }
  log('');

  // Print summary with severity breakdown
  log('─'.repeat(60), colors.brand);
  log('  Summary', colors.brand);
  log('─'.repeat(60), colors.brand);
  
  if (report.summary.allValid && report.summary.warnings === 0 && report.summary.info === 0) {
    log('  ✓ All validations passed!', colors.success);
  } else {
    // Show breakdown by severity
    if (report.summary.errors > 0) {
      log(`  ✗ Errors: ${report.summary.errors}`, colors.error);
    }
    if (report.summary.warnings > 0) {
      log(`  ⚠ Warnings: ${report.summary.warnings}`, colors.warning);
    }
    if (report.summary.info > 0) {
      log(`  ℹ Info: ${report.summary.info}`, colors.info);
    }
    log('');
    
    if (report.summary.allValid) {
      log('  No critical errors found, but review warnings and info above.', colors.warning);
    } else {
      log(`  Found ${report.summary.totalIssues} total issue(s)`, colors.error);
    }
  }
  log('');
}

/**
 * Main validation function with exit code support
 * @param {string} csvFilePath - Path to CSV file
 * @param {string[]} languages - Array of language codes
 * @param {Object} options - Options object
 * @param {boolean} options.verbose - Print detailed report
 * @returns {number} Exit code (0 for success, 1 for failure)
 */
export function validate(csvFilePath, languages, options = {}) {
  if (!csvFilePath) {
    log('Error: CSV file path is required', colors.error);
    return 1;
  }

  if (!languages || !Array.isArray(languages) || languages.length === 0) {
    log('Error: Languages array is required', colors.error);
    return 1;
  }

  // Check if file exists
  if (!existsSync(resolve(csvFilePath))) {
    log(`Error: CSV file not found: ${csvFilePath}`, colors.error);
    return 1;
  }

  // Run all validations
  const report = validateAll(csvFilePath, languages);

  // Print report if verbose mode
  if (options.verbose) {
    printReport(report);
  }

  // Return exit code based on errors (not warnings or info)
  return report.summary.allValid ? 0 : 1;
}

// Export for CLI usage
export default {
  validateInterpolations,
  validateUniqueIds,
  validateCoverage,
  validateAll,
  validate,
  printReport,
  Severity
};

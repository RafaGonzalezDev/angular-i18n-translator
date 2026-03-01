import { parse as csvParseSync } from 'csv-parse/sync';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

/**
 * Log a message with optional color
 * @param {string} message - Message to log
 * @param {string} color - Optional color code
 */
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
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
        issue: 'Missing required columns: id or source'
      });
      return { valid: false, issues };
    }

    // Validate each row
    for (const row of data) {
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
            issue: `Language column '${lang}' not found in CSV`
          });
          continue;
        }

        const targetText = row[lang] || '';
        const targetVars = extractInterpolations(targetText);

        // Check for missing interpolations
        const missing = findMissingInterpolations(sourceVars, targetVars);
        
        for (const variable of missing) {
          issues.push({
            id,
            language: lang,
            issue: `Missing interpolation: {{${variable}}}`
          });
        }

        // Check for extra interpolations (not in source)
        const extra = findMissingInterpolations(targetVars, sourceVars);
        for (const variable of extra) {
          issues.push({
            id,
            language: lang,
            issue: `Extra interpolation not in source: {{${variable}}}`
          });
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  } catch (error) {
    return {
      valid: false,
      issues: [{
        id: 'N/A',
        language: 'error',
        issue: error.message
      }]
    };
  }
}

/**
 * Validate unique IDs in CSV
 * @param {string} csvFilePath - Path to CSV file
 * @returns {{valid: boolean, duplicates: string[]}} Validation result
 */
export function validateUniqueIds(csvFilePath) {
  try {
    const { data, columns } = readCsvFile(csvFilePath);
    
    if (!columns.includes('id')) {
      return {
        valid: false,
        duplicates: [],
        issues: ['Missing required column: id']
      };
    }

    const idCounts = {};
    const duplicates = [];

    for (const row of data) {
      const id = row.id || '';
      if (!id) continue; // Skip empty IDs

      if (idCounts[id]) {
        idCounts[id]++;
        if (!duplicates.includes(id)) {
          duplicates.push(id);
        }
      } else {
        idCounts[id] = 1;
      }
    }

    return {
      valid: duplicates.length === 0,
      duplicates
    };
  } catch (error) {
    return {
      valid: false,
      duplicates: [],
      issues: [error.message]
    };
  }
}

/**
 * Validate translation coverage per language
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
          percentage: 0
        };
        continue;
      }

      const translated = validRows.filter(row => {
        const value = row[lang];
        return value && value.trim().length > 0;
      }).length;

      const percentage = total > 0 ? Math.round((translated / total) * 100) : 0;

      coverage[lang] = {
        total,
        translated,
        percentage
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
        percentage: 0,
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
      allValid: true
    }
  };

  // Run interpolation validation
  const interpolationResult = validateInterpolations(csvFilePath, languages);
  report.validations.interpolations = interpolationResult;
  report.summary.totalIssues += interpolationResult.issues.length;
  if (!interpolationResult.valid) {
    report.summary.allValid = false;
  }

  // Run unique ID validation
  const uniqueIdsResult = validateUniqueIds(csvFilePath);
  report.validations.uniqueIds = uniqueIdsResult;
  if (!uniqueIdsResult.valid) {
    report.summary.totalIssues += uniqueIdsResult.duplicates.length;
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
  log('\n' + '='.repeat(60), colors.bold);
  log(`  Translation Validation Report`, colors.bold + colors.cyan);
  log('='.repeat(60) + '\n', colors.bold);

  log(`File: ${report.file}`, colors.blue);
  log(`Languages: ${report.languages.join(', ')}`, colors.blue);
  log(`Timestamp: ${report.timestamp}\n`, colors.blue);

  // Print interpolation issues
  log('-'.repeat(60), colors.magenta);
  log('  Interpolation Validation', colors.bold + colors.magenta);
  log('-'.repeat(60), colors.magenta);
  
  const interp = report.validations.interpolations;
  if (interp.valid) {
    log('  ✓ All interpolations match\n', colors.green);
  } else {
    log(`  ✗ Found ${interp.issues.length} interpolation issue(s)\n`, colors.red);
    
    // Group issues by language
    const byLanguage = {};
    for (const issue of interp.issues) {
      if (!byLanguage[issue.language]) {
        byLanguage[issue.language] = [];
      }
      byLanguage[issue.language].push(issue);
    }

    for (const [lang, issues] of Object.entries(byLanguage)) {
      log(`  Language: ${lang}`, colors.yellow);
      for (const issue of issues) {
        log(`    - [${issue.id}] ${issue.issue}`, colors.red);
      }
    }
    log('');
  }

  // Print unique ID issues
  log('-'.repeat(60), colors.magenta);
  log('  Unique ID Validation', colors.bold + colors.magenta);
  log('-'.repeat(60), colors.magenta);
  
  const uniqueIds = report.validations.uniqueIds;
  if (uniqueIds.valid) {
    log('  ✓ All IDs are unique\n', colors.green);
  } else {
    log(`  ✗ Found duplicate ID(s): ${uniqueIds.duplicates.join(', ')}\n`, colors.red);
  }

  // Print coverage
  log('-'.repeat(60), colors.magenta);
  log('  Translation Coverage', colors.bold + colors.magenta);
  log('-'.repeat(60), colors.magenta);
  
  const coverage = report.validations.coverage;
  for (const [lang, stats] of Object.entries(coverage)) {
    const percentage = stats.percentage;
    let color = colors.green;
    
    if (percentage < 50) {
      color = colors.red;
    } else if (percentage < 80) {
      color = colors.yellow;
    }

    const bar = '█'.repeat(Math.floor(percentage / 10)) + '░'.repeat(10 - Math.floor(percentage / 10));
    log(`  ${lang}: [${bar}] ${percentage}% (${stats.translated}/${stats.total})`, color);
  }
  log('');

  // Print summary
  log('-'.repeat(60), colors.magenta);
  log('  Summary', colors.bold + colors.magenta);
  log('-'.repeat(60), colors.magenta);
  
  if (report.summary.allValid) {
    log('  ✓ All validations passed!\n', colors.green + colors.bold);
  } else {
    log(`  ✗ Found ${report.summary.totalIssues} issue(s)\n`, colors.red + colors.bold);
  }
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
    log('Error: CSV file path is required', colors.red);
    return 1;
  }

  if (!languages || !Array.isArray(languages) || languages.length === 0) {
    log('Error: Languages array is required', colors.red);
    return 1;
  }

  // Check if file exists
  if (!existsSync(resolve(csvFilePath))) {
    log(`Error: CSV file not found: ${csvFilePath}`, colors.red);
    return 1;
  }

  // Run all validations
  const report = validateAll(csvFilePath, languages);

  // Print report if verbose mode
  if (options.verbose) {
    printReport(report);
  }

  // Return exit code
  return report.summary.allValid ? 0 : 1;
}

// Export for CLI usage
export default {
  validateInterpolations,
  validateUniqueIds,
  validateCoverage,
  validateAll,
  validate,
  printReport
};

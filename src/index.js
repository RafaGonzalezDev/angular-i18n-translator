/**
 * Angular i18n Translator - Main Entry Point
 * CLI tool for managing Angular translation workflow
 */

import config, { getTargetLanguages } from './config.js';
import { parseXLF, generateXLF } from './xlf-parser.js';
import { xlfToCsv, csvToXlf } from './csv-converter.js';
import { splitBatches, runBatches, mergeBatches } from './batch-manager.js';
import { cleanBatchDirectories, cleanOutputDirectory, cleanAll } from './cleaner.js';
import { validate, printReport } from './validator.js';

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

/**
 * Log a message with optional color
 */
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

/**
 * Log an error message
 */
function error(message) {
  console.error(`${colors.red}Error: ${message}${colors.reset}`);
}

/**
 * Log success message
 */
function success(message) {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

/**
 * Print usage information
 */
function printUsage() {
  console.log(`
${colors.bold}Angular i18n Translator${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node src/index.js <command> [options]

${colors.cyan}Commands:${colors.reset}
  extract              Show command to run ng extract-i18n
  xlf-to-csv          Convert XLF file to CSV format
  csv-to-xlf          Convert CSV to XLF files per language
  translate-split     Split CSV into batches for translation
  translate-run       Process batches with LLM (parallel processing)
  translate-merge     Merge translated batches into CSV
  translate-all       Run full translation pipeline
  validate            Validate CSV consistency
  clean               Clean generated directories

${colors.cyan}Clean Options:${colors.reset}
  --csv-only          Clean only CSV files (default: clean all)
  --batches-only      Clean only batch directories
  --output-only       Clean only output directory
  --keep-csv          Keep CSV files, clean batches and output

${colors.cyan}Options:${colors.reset}
  --force             Force overwrite of existing translated batches

${colors.cyan}Configuration (i18n.config.json):${colors.reset}
  concurrency         Number of languages to process in parallel (default: 5)
  batchSize           Number of records per batch (default: 50)

${colors.cyan}Examples:${colors.reset}
  node src/index.js extract
  node src/index.js xlf-to-csv
  node src/index.js translate-all
  node src/index.js translate-run --force
  node src/index.js validate
  node src/index.js clean
  node src/index.js clean --batches-only
  node src/index.js clean --keep-csv
  `);
}

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || '';
  const options = {
    force: args.includes('--force'),
    clean: {
      csvOnly: args.includes('--csv-only'),
      batchesOnly: args.includes('--batches-only'),
      outputOnly: args.includes('--output-only'),
      keepCsv: args.includes('--keep-csv'),
      help: args.includes('--help') || args.includes('-h')
    },
    extra: args.filter(arg => !arg.startsWith('--'))
  };
  
  return { command, options };
}

/**
 * Get target language codes (excluding source language)
 * @returns {string[]} Array of target language codes
 */
function getTargetLanguageCodes() {
  return getTargetLanguages().map(lang => lang.code);
}

/**
 * Print a detailed translation report
 * @param {Array} results - Array of results from Promise.allSettled
 * @param {string[]} targetLanguages - Array of target language codes
 */
function printTranslationReport(results, targetLanguages) {
  const successful = [];
  const failed = [];
  
  results.forEach((result, index) => {
    const lang = targetLanguages[index];
    if (result.status === 'fulfilled') {
      successful.push({ lang, summary: result.value });
    } else {
      failed.push({ lang, error: result.reason });
    }
  });
  
  log('\n' + '='.repeat(60), colors.bold);
  log('  Translation Report', colors.bold + colors.cyan);
  log('='.repeat(60), colors.bold);
  
  if (successful.length > 0) {
    log(`\n${colors.green}Successful (${successful.length}):${colors.reset}`);
    for (const { lang, summary } of successful) {
      log(`  ${colors.green}✓${colors.reset} ${lang}: ` +
          `processed=${summary.processed}, ` +
          `skipped=${summary.skipped}, ` +
          `failed=${summary.failed}`);
    }
  }
  
  if (failed.length > 0) {
    log(`\n${colors.red}Failed (${failed.length}):${colors.reset}`);
    for (const { lang, error } of failed) {
      log(`  ${colors.red}✗${colors.reset} ${lang}: ${error?.message || 'Unknown error'}`);
    }
  }
  
  log('\n' + '-'.repeat(60));
  
  const totalProcessed = successful.reduce((sum, { summary }) => sum + summary.processed, 0);
  const totalSkipped = successful.reduce((sum, { summary }) => sum + summary.skipped, 0);
  const totalFailed = successful.reduce((sum, { summary }) => sum + summary.failed, 0);
  
  log(`Total: ${successful.length}/${targetLanguages.length} languages succeeded`);
  log(`Batches: processed=${totalProcessed}, skipped=${totalSkipped}, failed=${totalFailed}`);
  log('='.repeat(60) + '\n', colors.bold);
  
  return { successful, failed };
}

/**
 * Handle extract command
 * Shows the Angular extract-i18n command
 */
async function handleExtract() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Angular i18n Extraction', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const sourceFile = config.config.sourceFile || 'messages.xlf';
  
  log(`To extract translations from your Angular project, run:\n`);
  log(`  ${colors.green}ng extract-i18n --output-path src/locale --out-file ${sourceFile}${colors.reset}\n`);
  
  log(`Or for Angular 17+ with esbuild:\n`);
  log(`  ${colors.green}ng extract-i18n --format xlf2 --output-path src/locale${colors.reset}\n`);
  
  log(`After extraction, ensure the file exists at: ${sourceFile}\n`);
  
  return 0;
}

/**
 * Handle xlf-to-csv command
 */
async function handleXlfToCsv() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  XLF to CSV Conversion', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const sourceFile = config.config.sourceFile || 'messages.xlf';
  const csvOutput = config.config.csvOutput || 'messages.csv';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    error('No target languages configured');
    return 1;
  }
  
  try {
    success(`Converting ${sourceFile} to ${csvOutput}`);
    
    await xlfToCsv(sourceFile, csvOutput, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage
    });
    
    success(`CSV file created: ${csvOutput}`);
    log(`  - Source language: ${config.config.sourceLanguage}`);
    log(`  - Target languages: ${targetLanguages.join(', ')}`);
    
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

/**
 * Handle csv-to-xlf command
 */
async function handleCsvToXlf() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  CSV to XLF Conversion', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const csvFile = (config.config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv');
  const outputDir = config.config.outputDir || 'dist-i18n';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    error('No target languages configured');
    return 1;
  }
  
  try {
    success(`Converting ${csvFile} to XLF files`);
    
    const generatedFiles = await csvToXlf(csvFile, outputDir, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage,
      original: 'messages'
    });
    
    log(`\nGenerated XLF files:`);
    for (const [lang, path] of Object.entries(generatedFiles)) {
      log(`  ${lang}: ${path}`);
    }
    
    success('XLF conversion complete');
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

/**
 * Handle translate-split command
 */
async function handleTranslateSplit() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Splitting CSV into Batches', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const csvFile = config.config.csvOutput || 'messages.csv';
  const batchDir = config.config.batchDir || 'batches';
  const batchSize = config.config.llm?.batchSize || 50;
  
  try {
    success(`Splitting ${csvFile} into batches`);
    
    const numBatches = await splitBatches(csvFile, batchSize, batchDir);
    
    success(`Created ${numBatches} batches in ${batchDir}/pending/`);
    log(`  - Batch size: ${batchSize} records per batch`);
    
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

/**
 * Handle translate-run command with sequential language processing
 */
async function handleTranslateRun(force = false) {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Running LLM Translation (Sequential)', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const batchDir = config.config.batchDir || 'batches';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    error('No target languages configured');
    return 1;
  }
  
  const llmConfig = config.config.llm;
  
  if (!llmConfig) {
    error('LLM configuration is missing in i18n.config.json');
    log('Please ensure the "llm" object is defined in your configuration file.');
    return 1;
  }
  
  // Check individual fields and provide specific error messages
  const missingFields = [];
  if (!llmConfig.baseURL) missingFields.push('baseURL');
  if (!llmConfig.model) missingFields.push('model');
  if (!llmConfig.apiKey) missingFields.push('apiKey');
  
  if (missingFields.length > 0) {
    error(`LLM configuration is incomplete. Missing fields: ${missingFields.join(', ')}`);
    log('');
    log('Current LLM config:');
    log(`  - baseURL: ${llmConfig.baseURL || '(not set)'}`);
    log(`  - model: ${llmConfig.model || '(not set)'}`);
    log(`  - apiKey: ${llmConfig.apiKey ? '***configured***' : '(not set or empty)'}`);
    log('');
    log('To fix:');
    log('  1. Set LLM_API_KEY environment variable, OR');
    log('  2. Add your API key directly in i18n.config.json');
    return 1;
  }
  
  // Get concurrency setting from config
  const concurrency = config.config.llm?.concurrency || 5;
  
  log(`Processing ${targetLanguages.length} languages with concurrency: ${concurrency}`);
  log(`Languages: ${targetLanguages.join(', ')}\n`);
  
  // Process languages sequentially (one at a time) to avoid file conflicts
  const results = [];
  
  for (const lang of targetLanguages) {
    log(`${colors.yellow}Starting: ${lang}${colors.reset}`);
    
    const summary = await runBatches(batchDir, lang, llmConfig, { force, concurrency });
    
    log(`${colors.green}Completed: ${lang}${colors.reset} ` +
        `(processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed})`);
    
    results.push({ status: 'fulfilled', value: summary });
  }
  
  // Transform results to match expected format for printTranslationReport
  const transformedResults = results.map((r, i) => ({
    status: r.status,
    value: r.value,
    lang: targetLanguages[i]
  }));
  
  // Print detailed report
  const { successful, failed } = printTranslationReport(transformedResults, targetLanguages);
  
  // Return success if at least one language succeeded
  if (successful.length > 0) {
    if (failed.length > 0) {
      log(`${colors.yellow}Warning: ${failed.length} language(s) failed, but ${successful.length} succeeded${colors.reset}`);
    }
    return 0;
  } else {
    error('All languages failed to process');
    return 1;
  }
}

/**
 * Handle translate-merge command
 */
async function handleTranslateMerge() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Merging Translated Batches', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const csvFile = config.config.csvOutput || 'messages.csv';
  const batchDir = config.config.batchDir || 'batches';
  
  try {
    success('Merging translated batches');
    
    const mergedFile = await mergeBatches(csvFile, batchDir);
    
    success(`Merged CSV saved to: ${mergedFile}`);
    
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

/**
 * Handle translate-all command - Full translation pipeline with improved error tolerance
 */
async function handleTranslateAll(force = false) {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Full Translation Pipeline', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const stepResults = [];
  
  // Step 1: XLF to CSV
  log(`\n${colors.bold}Step 1/5: XLF to CSV${colors.reset}\n`);
  const xlfToCsvResult = await handleXlfToCsv();
  stepResults.push({ name: 'XLF to CSV', success: xlfToCsvResult === 0 });
  
  if (xlfToCsvResult !== 0) {
    error('Pipeline failed at step: XLF to CSV');
    return 1;
  }
  
  // Step 2: Split into batches
  log(`\n${colors.bold}Step 2/5: Split into batches${colors.reset}\n`);
  const splitResult = await handleTranslateSplit();
  stepResults.push({ name: 'Split into batches', success: splitResult === 0 });
  
  if (splitResult !== 0) {
    error('Pipeline failed at step: Split into batches');
    return 1;
  }
  
  // Step 3: Run LLM translation (with partial failure tolerance)
  log(`\n${colors.bold}Step 3/5: Run LLM translation${colors.reset}\n`);
  const translateResult = await handleTranslateRun(force);
  stepResults.push({ name: 'Run LLM translation', success: translateResult === 0 });
  
  // Continue even if translation had partial failures
  // The merge step will work with whatever translations succeeded
  if (translateResult !== 0) {
    log(`${colors.yellow}Warning: Translation step had failures, continuing with partial results...${colors.reset}`);
  }
  
  // Step 4: Merge translated batches
  log(`\n${colors.bold}Step 4/5: Merge translated batches${colors.reset}\n`);
  let mergeResult = 0;
  try {
    mergeResult = await handleTranslateMerge();
    stepResults.push({ name: 'Merge translated batches', success: mergeResult === 0 });
  } catch (err) {
    stepResults.push({ name: 'Merge translated batches', success: false, error: err.message });
    error(`Merge failed: ${err.message}`);
  }
  
  if (mergeResult !== 0) {
    error('Pipeline failed at step: Merge translated batches');
    log(`${colors.yellow}Note: Some translations may have completed but could not be merged${colors.reset}`);
    return 1;
  }
  
  // Step 5: CSV to XLF
  log(`\n${colors.bold}Step 5/5: CSV to XLF${colors.reset}\n`);
  const csvToXlfResult = await handleCsvToXlf();
  stepResults.push({ name: 'CSV to XLF', success: csvToXlfResult === 0 });
  
  if (csvToXlfResult !== 0) {
    error('Pipeline failed at step: CSV to XLF');
    return 1;
  }
  
  // Print final summary
  log('\n' + '='.repeat(60), colors.bold);
  log('  Pipeline Summary', colors.bold + colors.cyan);
  log('='.repeat(60), colors.bold);
  
  const failedSteps = stepResults.filter(s => !s.success);
  
  if (failedSteps.length === 0) {
    success('All steps completed successfully!');
  } else {
    log(`\n${colors.yellow}Completed with warnings:${colors.reset}`);
    for (const step of failedSteps) {
      log(`  ${colors.yellow}!${colors.reset} ${step.name}${step.error ? `: ${step.error}` : ''}`);
    }
  }
  
  log('\n' + '-'.repeat(60));
  for (const step of stepResults) {
    const icon = step.success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    log(`  ${icon} ${step.name}`);
  }
  log('='.repeat(60) + '\n', colors.bold);
  
  return 0;
}

/**
 * Handle validate command
 */
async function handleValidate() {
  log('\n' + '='.repeat(50), colors.bold);
  log('  CSV Validation', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  const csvFile = config.config.csvOutput || 'messages.csv';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    error('No target languages configured');
    return 1;
  }
  
  const exitCode = validate(csvFile, targetLanguages, { verbose: true });
  
  if (exitCode === 0) {
    success('Validation passed');
  } else {
    error('Validation failed');
  }
  
  return exitCode;
}

/**
 * Handle clean command
 * @param {Object} cleanOptions - Options for cleaning: { csvOnly, batchesOnly, outputOnly, keepCsv }
 */
async function handleClean(cleanOptions = {}) {
  log('\n' + '='.repeat(50), colors.bold);
  log('  Cleaning Directories', colors.bold + colors.cyan);
  log('='.repeat(50) + '\n', colors.bold);
  
  // Parse clean options into cleanAll options
  let cleanAllOptions;
  
  if (cleanOptions.csvOnly) {
    // --csv-only: clean only CSV files
    cleanAllOptions = { csv: true, batches: false, output: false };
  } else if (cleanOptions.batchesOnly) {
    // --batches-only: clean only batch directories
    cleanAllOptions = { csv: false, batches: true, output: false };
  } else if (cleanOptions.outputOnly) {
    // --output-only: clean only output directory
    cleanAllOptions = { csv: false, batches: false, output: true };
  } else if (cleanOptions.keepCsv) {
    // --keep-csv: clean batches and output but keep CSV files
    cleanAllOptions = { csv: false, batches: true, output: true };
  } else {
    // Default: clean everything
    cleanAllOptions = { csv: true, batches: true, output: true };
  }
  
  try {
    await cleanAll({
      batchDir: config.config.batchDir || 'batches',
      outputDir: config.config.outputDir || 'dist-i18n',
      csvPath: config.config.csvOutput || 'messages.csv',
      translatedCsvPath: (config.config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv')
    }, cleanAllOptions);
    
    // Determine appropriate message based on options
    let cleanupMessage = 'Cleanup completed';
    if (cleanAllOptions.csv && !cleanAllOptions.batches && !cleanAllOptions.output) {
      cleanupMessage = 'CSV cleanup completed';
    } else if (!cleanAllOptions.csv && cleanAllOptions.batches && !cleanAllOptions.output) {
      cleanupMessage = 'Batch directories cleanup completed';
    } else if (!cleanAllOptions.csv && !cleanAllOptions.batches && cleanAllOptions.output) {
      cleanupMessage = 'Output directory cleanup completed';
    } else if (cleanAllOptions.batches && cleanAllOptions.output && !cleanAllOptions.csv) {
      cleanupMessage = 'Batch and output cleanup completed (CSV files kept)';
    } else if (cleanAllOptions.csv && cleanAllOptions.batches && cleanAllOptions.output) {
      cleanupMessage = 'Full cleanup completed';
    }
    
    success(cleanupMessage);
    return 0;
  } catch (err) {
    error(err.message);
    return 1;
  }
}

/**
 * Main entry point
 */
async function main() {
  const { command, options } = parseArgs();
  
  // Handle empty command
  if (!command) {
    printUsage();
    return 1;
  }
  
  // Route to appropriate handler
  try {
    switch (command) {
      case 'extract':
        return await handleExtract();
        
      case 'xlf-to-csv':
        return await handleXlfToCsv();
        
      case 'csv-to-xlf':
        return await handleCsvToXlf();
        
      case 'translate-split':
        return await handleTranslateSplit();
        
      case 'translate-run':
        return await handleTranslateRun(options.force);
        
      case 'translate-merge':
        return await handleTranslateMerge();
        
      case 'translate-all':
        return await handleTranslateAll(options.force);
        
      case 'validate':
        return await handleValidate();
        
      case 'clean':
        if (options.clean.help) {
          log('\nUsage: node src/index.js clean [options]');
          log('\nClean Options:');
          log('  --csv-only      Clean only CSV files');
          log('  --batches-only  Clean only batch directories');
          log('  --output-only   Clean only output directory');
          log('  --keep-csv      Keep CSV files, clean batches and output');
          log('');
          return 0;
        }
        return await handleClean(options.clean);
        
      case '--help':
      case '-h':
        printUsage();
        return 0;
        
      default:
        error(`Unknown command: ${command}`);
        log(`\nRun 'node src/index.js --help' for usage information\n`);
        return 1;
    }
  } catch (err) {
    error(`Unexpected error: ${err.message}`);
    console.error(err.stack);
    return 1;
  }
}

// Run main function and exit with appropriate code
main()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(err => {
    error(`Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });

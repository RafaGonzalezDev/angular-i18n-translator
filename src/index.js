/**
 * Angular i18n Translator - Main Entry Point
 * CLI tool for managing Angular translation workflow with LLM
 * 
 * Refactored with Commander.js for better UX and structured commands
 */

import { Command } from 'commander';
import config, { getTargetLanguages } from './config.js';
import { xlfToCsv, csvToXlf } from './csv-converter.js';
import { splitBatches, runBatches, mergeBatches } from './batch-manager.js';
import { cleanAll } from './cleaner.js';
import { validate } from './validator.js';
import handleInit from './commands/init.js';
import { 
  colors, 
  createSpinner, 
  printHeader, 
  printSummaryLine,
  formatDuration 
} from './cli/ui.js';
import { formatError, I18nTranslatorError } from './errors.js';

// ============================================================================
// GLOBAL OPTIONS
// ============================================================================

/**
 * Global CLI options accessible from any command
 */
let globalOptions = {
  quiet: false,
  verbose: false,
};

/**
 * Log message respecting quiet mode
 */
function log(message, colorFn = null) {
  if (globalOptions.quiet) return;
  const output = colorFn ? colorFn(message) : message;
  console.log(output);
}

/**
 * Log verbose message (only when --verbose is set)
 */
function logVerbose(message) {
  if (!globalOptions.verbose) return;
  console.log(colors.dim(`[verbose] ${message}`));
}

/**
 * Log error message (always shown, even in quiet mode)
 */
function logError(message) {
  console.error(colors.error(`✖ ${message}`));
}

/**
 * Log success message
 */
function logSuccess(message) {
  if (globalOptions.quiet) return;
  console.log(colors.success(`✓ ${message}`));
}

/**
 * Log warning message
 */
function logWarning(message) {
  if (globalOptions.quiet) return;
  console.log(colors.warning(`⚠ ${message}`));
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get target language codes (excluding source language)
 */
function getTargetLanguageCodes() {
  return getTargetLanguages().map(lang => lang.code);
}

/**
 * Print a section banner
 */
function printBanner(title) {
  if (globalOptions.quiet) return;
  console.log();
  console.log(colors.highlight(`━━━ ${title} ━━━`));
  console.log();
}

/**
 * Print a translation report summary
 */
function printTranslationReport(results, targetLanguages) {
  const successful = [];
  const failed = [];
  
  results.forEach((result, index) => {
    const lang = targetLanguages[index];
    if (result.status === 'fulfilled' || result.status === 'success') {
      successful.push({ lang, summary: result.value || result });
    } else {
      failed.push({ lang, error: result.reason || result.error });
    }
  });
  
  console.log();
  console.log(colors.highlight('━━━ Translation Report ━━━'));
  console.log();
  
  if (successful.length > 0) {
    console.log(colors.success(`Successful (${successful.length}):`));
    for (const { lang, summary } of successful) {
      const processed = summary?.processed ?? summary?.value?.processed ?? 0;
      const skipped = summary?.skipped ?? summary?.value?.skipped ?? 0;
      const failedCount = summary?.failed ?? summary?.value?.failed ?? 0;
      console.log(`  ${colors.success('✓')} ${lang}: ` +
          `processed=${colors.number(processed)}, ` +
          `skipped=${colors.number(skipped)}, ` +
          `failed=${colors.number(failedCount)}`);
    }
  }
  
  if (failed.length > 0) {
    console.log();
    console.log(colors.error(`Failed (${failed.length}):`));
    for (const { lang, error } of failed) {
      console.log(`  ${colors.error('✗')} ${lang}: ${error?.message || error || 'Unknown error'}`);
    }
  }
  
  console.log();
  console.log(colors.dim('─'.repeat(50)));
  
  const totalProcessed = successful.reduce((sum, { summary }) => {
    const val = summary?.processed ?? summary?.value?.processed ?? 0;
    return sum + val;
  }, 0);
  
  console.log(`Total: ${colors.number(successful.length)}/${colors.number(targetLanguages.length)} languages succeeded`);
  console.log(`Batches processed: ${colors.number(totalProcessed)}`);
  console.log();
  
  return { successful, failed };
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle xlf-to-csv command
 */
async function handleXlfToCsv() {
  printBanner('XLF to CSV Conversion');
  
  const sourceFile = config.config.sourceFile || 'messages.xlf';
  const csvOutput = config.config.csvOutput || 'messages.csv';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    logError('No target languages configured');
    return 1;
  }
  
  const spinner = createSpinner(`Converting ${colors.path(sourceFile)} to ${colors.path(csvOutput)}`);
  spinner.start();
  
  try {
    await xlfToCsv(sourceFile, csvOutput, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage
    });
    
    spinner.succeed(`CSV file created: ${colors.path(csvOutput)}`);
    
    logVerbose(`Source language: ${config.config.sourceLanguage}`);
    logVerbose(`Target languages: ${targetLanguages.join(', ')}`);
    
    return 0;
  } catch (err) {
    spinner.fail(`Conversion failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle csv-to-xlf command
 */
async function handleCsvToXlf() {
  printBanner('CSV to XLF Conversion');
  
  const csvFile = (config.config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv');
  const outputDir = config.config.outputDir || 'dist-i18n';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    logError('No target languages configured');
    return 1;
  }
  
  const spinner = createSpinner(`Converting ${colors.path(csvFile)} to XLF files`);
  spinner.start();
  
  try {
    const generatedFiles = await csvToXlf(csvFile, outputDir, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage,
      original: 'messages'
    });
    
    spinner.succeed('XLF conversion complete');
    
    console.log();
    log('Generated XLF files:');
    for (const [lang, path] of Object.entries(generatedFiles)) {
      log(`  ${lang}: ${colors.path(path)}`);
    }
    
    return 0;
  } catch (err) {
    spinner.fail(`Conversion failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle translate-split command
 */
async function handleTranslateSplit() {
  printBanner('Splitting CSV into Batches');
  
  const csvFile = config.config.csvOutput || 'messages.csv';
  const batchDir = config.config.batchDir || 'batches';
  const batchSize = config.config.llm?.batchSize || 50;
  
  const spinner = createSpinner('Reading CSV and creating batches...');
  spinner.start();
  
  try {
    const result = await splitBatches(csvFile, batchSize, batchDir, {
      verbose: globalOptions.verbose
    });
    
    const batchCount = result.batchCount || result;
    const recordCount = result.recordCount || 0;
    
    spinner.succeed(`Created ${batchCount} batches (${recordCount} records)`);
    
    logVerbose(`Batch size: ${batchSize} records per batch`);
    
    if (globalOptions.verbose && result.verboseInfo) {
      logVerbose('Split details:');
      logVerbose(`  Directories created: ${result.verboseInfo.directoriesCreated.length}`);
      logVerbose(`  Files read: ${result.verboseInfo.filesRead.length}`);
    }
    
    return 0;
  } catch (err) {
    spinner.fail(`Split failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle translate-run command
 */
async function handleTranslateRun(options = {}) {
  const { force = false } = options;
  
  printBanner('Running LLM Translation');
  
  const batchDir = config.config.batchDir || 'batches';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    logError('No target languages configured');
    return 1;
  }
  
  const llmConfig = config.config.llm;
  
  if (!llmConfig) {
    logError('LLM configuration is missing in i18n.config.json');
    log('Please ensure the "llm" object is defined in your configuration file.');
    return 1;
  }
  
  // Validate LLM config
  const missingFields = [];
  if (!llmConfig.baseURL) missingFields.push('baseURL');
  if (!llmConfig.model) missingFields.push('model');
  if (!llmConfig.apiKey) missingFields.push('apiKey');
  
  if (missingFields.length > 0) {
    logError(`LLM configuration is incomplete. Missing fields: ${missingFields.join(', ')}`);
    console.log();
    log('Current LLM config:');
    log(`  - baseURL: ${llmConfig.baseURL || colors.dim('(not set)')}`);
    log(`  - model: ${llmConfig.model || colors.dim('(not set)')}`);
    log(`  - apiKey: ${llmConfig.apiKey ? colors.success('***configured***') : colors.dim('(not set)')}`);
    console.log();
    log('To fix:');
    log('  1. Set LLM_API_KEY environment variable, OR');
    log('  2. Add your API key directly in i18n.config.json');
    return 1;
  }
  
  const concurrency = config.config.llm?.concurrency || 5;
  const verbose = globalOptions.verbose;
  
  log(`Processing ${colors.number(targetLanguages.length)} languages with concurrency: ${colors.number(concurrency)}`);
  log(`Languages: ${targetLanguages.map(l => colors.highlight(l)).join(', ')}`);
  console.log();

  // Spinner único global
  const spinner = createSpinner(`Translating ${targetLanguages.length} languages...`);
  spinner.start();

  // Track de estado de cada idioma (solo para el reporte final)
  const languageStatus = {};
  targetLanguages.forEach(lang => {
    languageStatus[lang] = { status: 'pending', batches: 0, total: 0 };
  });

  const languagePromises = targetLanguages.map(async (lang) => {
    const summary = await runBatches(batchDir, lang, llmConfig, { 
      force, 
      concurrency,
      verbose,
      onStart: (info) => {
        // No actualizar el spinner - solo trackear estado interno
        languageStatus[lang].status = 'translating';
      },
      onProgress: (batchNumber, totalBatches) => {
        // Actualizar estado interno, NO el spinner
        languageStatus[lang].batches = batchNumber;
        languageStatus[lang].total = totalBatches;
      },
      onComplete: (summary) => {
        languageStatus[lang].status = 'completed';
        languageStatus[lang].summary = summary;
      },
      onError: (error) => {
        languageStatus[lang].status = 'failed';
        languageStatus[lang].error = error.error;
      }
    });
    
    return { lang, status: 'fulfilled', value: summary };
  });

  const results = await Promise.allSettled(languagePromises);
  
  // Calcular resultado global
  const completedLanguages = Object.values(languageStatus).filter(l => l.status === 'completed').length;
  const failedLanguages = Object.values(languageStatus).filter(l => l.status === 'failed').length;
  const totalBatches = Object.values(languageStatus).reduce((sum, l) => sum + (l.summary?.processed || 0), 0);

  if (failedLanguages === 0) {
    spinner.succeed(`Translation complete (${totalBatches} batches processed)`);
  } else if (completedLanguages > 0) {
    spinner.warn(`${completedLanguages} languages completed, ${failedLanguages} failed (${totalBatches} batches processed)`);
  } else {
    spinner.fail(`All ${failedLanguages} languages failed to process`);
  }
  
  // Convert results from Promise.allSettled to the expected format
  const formattedResults = results.map(result => {
    if (result.status === 'fulfilled') {
      return { 
        status: 'fulfilled', 
        value: result.value  // result.value already contains the object returned by the promise
      };
    } else {
      return { 
        status: 'rejected', 
        reason: result.reason  // rejected promises have reason directly, not in result.value.reason
      };
    }
  });
  
  // Print detailed report
  const { successful, failed } = printTranslationReport(formattedResults, targetLanguages);
  
  if (successful.length > 0) {
    if (failed.length > 0) {
      logWarning(`${failed.length} language(s) failed, but ${successful.length} succeeded`);
    }
    return 0;
  } else {
    logError('All languages failed to process');
    return 1;
  }
}

/**
 * Handle translate-merge command
 */
async function handleTranslateMerge() {
  printBanner('Merging Translated Batches');

  const csvFile = config.config.csvOutput || 'messages.csv';
  const batchDir = config.config.batchDir || 'batches';

  const spinner = createSpinner('Merging translated batches');
  spinner.start();

  try {
    const result = await mergeBatches(csvFile, batchDir, {
      verbose: globalOptions.verbose
    });

    const mergedFile = result.outputFile || result;
    spinner.succeed(`Merged CSV saved to: ${colors.path(mergedFile)}`);

    if (globalOptions.verbose && result.verboseInfo) {
      logVerbose('Merge details:');
      logVerbose(`  Languages processed: ${result.verboseInfo.languagesProcessed.join(', ')}`);
      logVerbose(`  Total batches: ${result.verboseInfo.totalBatches}`);
      logVerbose(`  Total records: ${result.verboseInfo.totalRecords}`);
    }

    return 0;
  } catch (err) {
    spinner.fail(`Merge failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle translate-all command
 */
async function handleTranslateAll(options = {}) {
  const { force = false } = options;
  
  printBanner('Full Translation Pipeline');
  
  const steps = [
    { name: 'XLF to CSV', handler: handleXlfToCsv },
    { name: 'Split into batches', handler: handleTranslateSplit },
    { name: 'Run LLM translation', handler: () => handleTranslateRun({ force }) },
    { name: 'Merge translated batches', handler: handleTranslateMerge },
    { name: 'CSV to XLF', handler: handleCsvToXlf },
  ];
  
  const stepResults = [];
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    
    console.log();
    log(colors.bold(`Step ${stepNum}/${steps.length}: ${step.name}`));
    console.log();
    
    try {
      const result = await step.handler();
      stepResults.push({ name: step.name, success: result === 0 });
      
      if (result !== 0) {
        // Allow partial failure for translation step
        if (step.name === 'Run LLM translation') {
          logWarning('Translation step had failures, continuing with partial results...');
          continue;
        }
        
        logError(`Pipeline failed at step: ${step.name}`);
        return 1;
      }
    } catch (err) {
      stepResults.push({ name: step.name, success: false, error: err.message });
      logError(`Step failed: ${step.name} - ${err.message}`);
      
      if (step.name === 'Run LLM translation') {
        logWarning('Continuing with partial results...');
        continue;
      }
      
      return 1;
    }
  }
  
  // Print final summary
  console.log();
  console.log(colors.highlight('━━━ Pipeline Summary ━━━'));
  console.log();
  
  const failedSteps = stepResults.filter(s => !s.success);
  
  if (failedSteps.length === 0) {
    logSuccess('All steps completed successfully!');
  } else {
    logWarning('Completed with warnings:');
    for (const step of failedSteps) {
      log(`  ${colors.warning('!')} ${step.name}${step.error ? `: ${step.error}` : ''}`);
    }
  }
  
  console.log();
  console.log(colors.dim('─'.repeat(50)));
  for (const step of stepResults) {
    const icon = step.success ? colors.success('✓') : colors.error('✗');
    log(`  ${icon} ${step.name}`);
  }
  console.log();
  
  return 0;
}

/**
 * Handle validate command
 */
async function handleValidate() {
  printBanner('CSV Validation');
  
  const csvFile = config.config.csvOutput || 'messages.csv';
  const targetLanguages = getTargetLanguageCodes();
  
  if (targetLanguages.length === 0) {
    logError('No target languages configured');
    return 1;
  }
  
  const spinner = createSpinner(`Validating ${colors.path(csvFile)}`);
  spinner.start();
  
  const exitCode = validate(csvFile, targetLanguages, { verbose: !globalOptions.quiet });
  
  if (exitCode === 0) {
    spinner.succeed('Validation passed');
  } else {
    spinner.fail('Validation failed');
  }
  
  return exitCode;
}

/**
 * Handle clean command
 */
async function handleClean(options = {}) {
  printBanner('Cleaning Directories');
  
  // Parse clean options
  let cleanAllOptions;
  
  if (options.csvOnly) {
    cleanAllOptions = { csv: true, batches: false, output: false };
  } else if (options.batchesOnly) {
    cleanAllOptions = { csv: false, batches: true, output: false };
  } else if (options.outputOnly) {
    cleanAllOptions = { csv: false, batches: false, output: true };
  } else if (options.keepCsv) {
    cleanAllOptions = { csv: false, batches: true, output: true };
  } else {
    cleanAllOptions = { csv: true, batches: true, output: true };
  }
  
  const spinner = createSpinner('Cleaning directories');
  spinner.start();
  
  try {
    await cleanAll({
      batchDir: config.config.batchDir || 'batches',
      outputDir: config.config.outputDir || 'dist-i18n',
      csvPath: config.config.csvOutput || 'messages.csv',
      translatedCsvPath: (config.config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv')
    }, cleanAllOptions);
    
    // Determine message
    let message = 'Cleanup completed';
    if (cleanAllOptions.csv && !cleanAllOptions.batches && !cleanAllOptions.output) {
      message = 'CSV cleanup completed';
    } else if (!cleanAllOptions.csv && cleanAllOptions.batches && !cleanAllOptions.output) {
      message = 'Batch directories cleanup completed';
    } else if (!cleanAllOptions.csv && !cleanAllOptions.batches && cleanAllOptions.output) {
      message = 'Output directory cleanup completed';
    } else if (cleanAllOptions.batches && cleanAllOptions.output && !cleanAllOptions.csv) {
      message = 'Batch and output cleanup completed (CSV files kept)';
    } else if (cleanAllOptions.csv && cleanAllOptions.batches && cleanAllOptions.output) {
      message = 'Full cleanup completed';
    }
    
    spinner.succeed(message);
    return 0;
  } catch (err) {
    spinner.fail(`Cleanup failed: ${err.message}`);
    return 1;
  }
}

// ============================================================================
// CLI PROGRAM SETUP
// ============================================================================

const program = new Command();

program
  .name('angular-i18n-translator')
  .description('CLI for managing Angular i18n translations with LLM')
  .version('1.0.0')
  .option('--quiet', 'Suppress non-essential output')
  .option('--verbose', 'Enable verbose output')
  .hook('preAction', (thisCommand) => {
    // Capture global options before any action
    globalOptions = {
      quiet: thisCommand.opts().quiet || false,
      verbose: thisCommand.opts().verbose || false,
    };
  });

// ============================================================================
// COMMANDS
// ============================================================================

// Init command
program
  .command('init')
  .description('Interactive configuration wizard to set up i18n.config.json and .env')
  .action(async () => {
    const exitCode = await handleInit();
    process.exit(exitCode);
  });

// XLF to CSV command
program
  .command('xlf-to-csv')
  .description('Convert XLF file to CSV format')
  .action(async () => {
    const exitCode = await handleXlfToCsv();
    process.exit(exitCode);
  });

// CSV to XLF command
program
  .command('csv-to-xlf')
  .description('Convert CSV to XLF files per language')
  .action(async () => {
    const exitCode = await handleCsvToXlf();
    process.exit(exitCode);
  });

// Translate split command
program
  .command('translate-split')
  .description('Split CSV into batches for translation')
  .action(async () => {
    const exitCode = await handleTranslateSplit();
    process.exit(exitCode);
  });

// Translate run command
program
  .command('translate-run')
  .description('Process batches with LLM (parallel processing)')
  .option('-f, --force', 'Force re-translation of existing batches')
  .action(async (options) => {
    const exitCode = await handleTranslateRun(options);
    process.exit(exitCode);
  });

// Translate merge command
program
  .command('translate-merge')
  .description('Merge translated batches into CSV')
  .action(async () => {
    const exitCode = await handleTranslateMerge();
    process.exit(exitCode);
  });

// Translate all command (full pipeline)
program
  .command('translate-all')
  .description('Run full translation pipeline')
  .option('-f, --force', 'Force re-translation of existing batches')
  .action(async (options) => {
    const exitCode = await handleTranslateAll(options);
    process.exit(exitCode);
  });

// Validate command
program
  .command('validate')
  .description('Validate CSV consistency')
  .action(async () => {
    const exitCode = await handleValidate();
    process.exit(exitCode);
  });

// Clean command
program
  .command('clean')
  .description('Clean generated directories')
  .option('--csv-only', 'Clean only CSV files')
  .option('--batches-only', 'Clean only batch directories')
  .option('--output-only', 'Clean only output directory')
  .option('--keep-csv', 'Keep CSV files, clean batches and output')
  .action(async (options) => {
    const exitCode = await handleClean(options);
    process.exit(exitCode);
  });

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Handle unknown commands
program.on('command:*', (operands) => {
  logError(`Unknown command: ${operands[0]}`);
  console.log();
  log(`Run '${colors.highlight('angular-i18n-translator --help')}' for usage information`);
  process.exit(1);
});

// Global error handler
process.on('uncaughtException', (error) => {
  console.error();
  console.error(formatError(error));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error();
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(formatError(error));
  process.exit(1);
});

// ============================================================================
// RUN
// ============================================================================

program.parse();

/**
 * Angular i18n Translator - Main Entry Point
 * CLI tool for managing Angular translation workflow with LLM
 */

import { readFileSync, existsSync } from 'fs';
import { Command } from 'commander';
import config, { getTargetLanguages } from './config.js';
import { xlfToCsv, csvToXlf } from './csv-converter.js';
import { splitBatches, runBatches, mergeBatches } from './batch-manager.js';
import { cleanAll } from './cleaner.js';
import { validate } from './validator.js';
import handleInit from './commands/init.js';
import { colors, createSpinner } from './cli/ui.js';
import { formatError } from './errors.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

// ============================================================================
// GLOBAL OPTIONS
// ============================================================================

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
 * Get target language codes (excluding source language)
 */
function getTargetLanguageCodes() {
  return getTargetLanguages().map(lang => lang.code);
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

  if (!existsSync(sourceFile)) {
    logError(`Source XLF file not found: ${sourceFile}`);
    log('Extract it from your Angular project first:');
    log('  ng extract-i18n --output-path src/locale --out-file messages.xlf');
    log('Then copy it to this directory and run "npm run translate" again.');
    return 1;
  }

  const spinner = createSpinner(`Converting ${colors.path(sourceFile)} to ${colors.path(csvOutput)}`);
  spinner.start();

  try {
    await xlfToCsv(sourceFile, csvOutput, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage,
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

  if (!existsSync(csvFile)) {
    logError(`Translated CSV not found: ${csvFile}`);
    log('There is nothing to convert yet. Run the pipeline first:');
    log('  npm run translate          (full pipeline)');
    log('  npm run translate:run      (only if you already split the CSV)');
    log('  npm run translate:merge    (only if batches were already translated)');
    return 1;
  }

  const fileNames = {};
  for (const lang of getTargetLanguages()) {
    if (lang.file) {
      fileNames[lang.code] = lang.file;
    }
  }

  const spinner = createSpinner(`Converting ${colors.path(csvFile)} to XLF files`);
  spinner.start();

  try {
    const { files, issues } = await csvToXlf(csvFile, outputDir, targetLanguages, {
      sourceLanguage: config.config.sourceLanguage,
      original: 'messages',
      fileNames,
    });

    spinner.succeed('XLF conversion complete');

    console.log();
    log('Generated XLF files:');
    for (const [lang, path] of Object.entries(files)) {
      log(`  ${lang}: ${colors.path(path)}`);
    }

    for (const issue of issues) {
      logWarning(issue);
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
    const result = await splitBatches(csvFile, batchSize, batchDir);

    spinner.succeed(`Created ${result.batchCount} batches (${result.recordCount} records)`);

    if (result.removedStale.length > 0) {
      logVerbose(`Removed ${result.removedStale.length} stale batch file(s) from previous runs`);
    }
    logVerbose(`Batch size: ${batchSize} records per batch`);

    return 0;
  } catch (err) {
    spinner.fail(`Split failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle translate-run command.
 *
 * Languages are processed sequentially; batches within each language run in
 * parallel up to `concurrency`. This keeps API load bounded and progress
 * output readable.
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

  const missingFields = [];
  if (!llmConfig.baseURL) missingFields.push('baseURL');
  if (!llmConfig.model) missingFields.push('model');
  if (!llmConfig.apiKey) missingFields.push('apiKey');

  if (missingFields.length > 0) {
    logError(`LLM configuration is incomplete. Missing fields: ${missingFields.join(', ')}`);
    console.log();
    log('To fix:');
    log('  1. Set the missing values in your .env file (see .env.example), OR');
    log('  2. Add them directly in i18n.config.json');
    return 1;
  }

  const concurrency = llmConfig.concurrency || 5;

  log(`Processing ${colors.number(targetLanguages.length)} languages sequentially (batch concurrency: ${colors.number(concurrency)})`);
  log(`Languages: ${targetLanguages.map(l => colors.highlight(l)).join(', ')}`);
  console.log();

  const spinner = createSpinner('Starting translation...');
  spinner.start();

  const results = [];

  for (const lang of targetLanguages) {
    spinner.text = `Translating ${colors.highlight(lang)}...`;

    try {
      const summary = await runBatches(batchDir, lang, llmConfig, {
        force,
        concurrency,
        verbose: globalOptions.verbose,
      });
      results.push({ lang, summary });
    } catch (err) {
      results.push({ lang, error: err });
    }
  }

  // Classify results: a language succeeds only when no batch failed
  const successful = results.filter(r => !r.error && r.summary.failed === 0);
  const failed = results.filter(r => r.error || r.summary.failed > 0);

  const totalProcessed = successful.reduce((sum, r) => sum + r.summary.processed, 0);
  const totalSkipped = successful.reduce((sum, r) => sum + r.summary.skipped, 0);

  if (failed.length === 0) {
    spinner.succeed(`Translation complete (${totalProcessed} batches processed, ${totalSkipped} skipped)`);
  } else if (successful.length > 0) {
    spinner.warn(`${successful.length} language(s) completed, ${failed.length} failed`);
  } else {
    spinner.fail('All languages failed to process');
  }

  // Print report
  console.log();
  console.log(colors.highlight('━━━ Translation Report ━━━'));
  console.log();

  if (successful.length > 0) {
    console.log(colors.success(`Successful (${successful.length}):`));
    for (const { lang, summary } of successful) {
      console.log(`  ${colors.success('✓')} ${lang}: ` +
        `processed=${colors.number(summary.processed)}, ` +
        `skipped=${colors.number(summary.skipped)}, ` +
        `failed=${colors.number(summary.failed)}`);
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log(colors.error(`Failed (${failed.length}):`));
    for (const { lang, error, summary } of failed) {
      if (error) {
        console.log(`  ${colors.error('✗')} ${lang}: ${error.message}`);
      } else {
        console.log(`  ${colors.error('✗')} ${lang}: ${summary.failed} batch(es) failed`);
        for (const batchError of summary.errors) {
          console.log(`      ${colors.dim(`- ${batchError.batch}: ${batchError.error}`)}`);
        }
      }
    }
  }

  console.log();
  console.log(colors.dim('─'.repeat(50)));
  console.log(`Total: ${colors.number(successful.length)}/${colors.number(targetLanguages.length)} languages succeeded`);
  console.log(`Batches processed: ${colors.number(totalProcessed)} (skipped: ${colors.number(totalSkipped)})`);
  console.log();

  if (failed.length > 0) {
    logWarning('Some batches failed. Re-run translate-run to retry them (translated batches are skipped).');
    return 1;
  }
  return 0;
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
    const result = await mergeBatches(csvFile, batchDir);

    spinner.succeed(`Merged CSV saved to: ${colors.path(result.outputFile)}`);

    for (const { lang, ids } of result.missing) {
      const shown = ids.slice(0, 3).join(', ');
      const more = ids.length > 3 ? `, +${ids.length - 3} more` : '';
      logWarning(`${lang}: ${ids.length} record(s) are still identical to the source text (e.g. ${shown}${more})`);
    }

    if (result.missing.length > 0) {
      logWarning('They were never translated, or the translation is legitimately identical to the source. Review them.');
    }

    return 0;
  } catch (err) {
    spinner.fail(`Merge failed: ${err.message}`);
    return 1;
  }
}

/**
 * Handle translate-all command (full pipeline)
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
  let pipelineOk = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;

    console.log();
    log(colors.bold(`Step ${stepNum}/${steps.length}: ${step.name}`));
    console.log();

    let exitCode;
    try {
      exitCode = await step.handler();
    } catch (err) {
      stepResults.push({ name: step.name, success: false, error: err.message });
      logError(`Step failed: ${step.name} - ${err.message}`);
      return 1;
    }

    const success = exitCode === 0;
    stepResults.push({ name: step.name, success });

    if (!success) {
      // Translation failures are partial: continue so successful languages
      // still produce output, but mark the pipeline as failed overall.
      if (step.name === 'Run LLM translation') {
        logWarning('Translation step had failures; continuing with partial results.');
        pipelineOk = false;
        continue;
      }

      logError(`Pipeline failed at step: ${step.name}`);
      return 1;
    }
  }

  // Final summary
  console.log();
  console.log(colors.highlight('━━━ Pipeline Summary ━━━'));
  console.log();

  for (const step of stepResults) {
    const icon = step.success ? colors.success('✓') : colors.error('✗');
    log(`  ${icon} ${step.name}${step.error ? `: ${step.error}` : ''}`);
  }
  console.log();

  if (pipelineOk) {
    logSuccess('All steps completed successfully!');
    return 0;
  }

  logWarning('Pipeline completed with translation failures. Review the report above.');
  return 1;
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

  if (!existsSync(csvFile)) {
    logError(`CSV file not found: ${csvFile}`);
    log('Generate it first with "npm run xlf-to-csv" (or run the full pipeline: npm run translate).');
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
async function handleClean() {
  printBanner('Cleaning Generated Files');

  const spinner = createSpinner('Cleaning batches, output directory and CSV files');
  spinner.start();

  try {
    const { removed } = await cleanAll({
      batchDir: config.config.batchDir || 'batches',
      outputDir: config.config.outputDir || 'dist-i18n',
      csvPath: config.config.csvOutput || 'messages.csv',
      translatedCsvPath: (config.config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv'),
    });

    spinner.succeed(
      removed.length > 0
        ? `Cleanup completed (${removed.length} item(s) removed)`
        : 'Nothing to clean'
    );

    for (const path of removed) {
      logVerbose(`Removed: ${path}`);
    }

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
  .version(packageJson.version)
  .option('--quiet', 'Suppress non-essential output')
  .option('--verbose', 'Enable verbose output')
  .hook('preAction', (thisCommand) => {
    globalOptions = {
      quiet: thisCommand.opts().quiet || false,
      verbose: thisCommand.opts().verbose || false,
    };
  });

// ============================================================================
// COMMANDS
// ============================================================================

program
  .command('init')
  .description('Interactive configuration wizard to set up i18n.config.json and .env')
  .action(async () => {
    const exitCode = await handleInit();
    process.exit(exitCode);
  });

program
  .command('xlf-to-csv')
  .description('Convert XLF file to CSV format')
  .action(async () => {
    const exitCode = await handleXlfToCsv();
    process.exit(exitCode);
  });

program
  .command('csv-to-xlf')
  .description('Convert translated CSV to XLF files per language')
  .action(async () => {
    const exitCode = await handleCsvToXlf();
    process.exit(exitCode);
  });

program
  .command('translate-split')
  .description('Split CSV into batches for translation')
  .action(async () => {
    const exitCode = await handleTranslateSplit();
    process.exit(exitCode);
  });

program
  .command('translate-run')
  .description('Translate batches with the LLM (languages sequentially, batches in parallel)')
  .option('-f, --force', 'Force re-translation of existing batches')
  .action(async (options) => {
    const exitCode = await handleTranslateRun(options);
    process.exit(exitCode);
  });

program
  .command('translate-merge')
  .description('Merge translated batches into the translated CSV')
  .action(async () => {
    const exitCode = await handleTranslateMerge();
    process.exit(exitCode);
  });

program
  .command('translate')
  .alias('translate-all')
  .description('Run the full translation pipeline (recommended)')
  .option('-f, --force', 'Force re-translation of existing batches')
  .action(async (options) => {
    const exitCode = await handleTranslateAll(options);
    process.exit(exitCode);
  });

program
  .command('validate')
  .description('Validate translated CSV consistency')
  .action(async () => {
    const exitCode = await handleValidate();
    process.exit(exitCode);
  });

program
  .command('clean')
  .description('Remove generated batches, output directory and CSV files')
  .action(async () => {
    const exitCode = await handleClean();
    process.exit(exitCode);
  });

// ============================================================================
// ERROR HANDLING
// ============================================================================

program.on('command:*', (operands) => {
  logError(`Unknown command: ${operands[0]}`);
  console.log();
  log(`Run 'angular-i18n-translator --help' for usage information`);
  process.exit(1);
});

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

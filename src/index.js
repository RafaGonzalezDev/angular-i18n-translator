import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import config, { getTargetLanguages, DEFAULT_CONFIG_PATH } from './config.js';
import { xlfToCsv, csvToXlf } from './csv-converter.js';
import { splitBatches, runBatches, mergeBatches } from './batch-manager.js';
import { cleanAll } from './cleaner.js';
import { validate, validateAll } from './validator.js';
import { getTranslatedCsvPath, assertSafeDirectory, resolveSafeOutputPath } from './paths.js';
import handleInit from './commands/init.js';
import { formatError } from './errors.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let globalOptions = { quiet: false, verbose: false };
const log = message => { if (!globalOptions.quiet) console.log(message); };
const warn = message => { if (!globalOptions.quiet) console.warn(message); };
const error = message => console.error(message);
const targetCodes = () => getTargetLanguages().map(language => language.code);

function outputOptions() {
  const cfg = config.config;
  const options = { projectRoot: process.cwd(), sourceFile: resolve(cfg.sourceFile), configFile: DEFAULT_CONFIG_PATH };
  const protection = { projectRoot: options.projectRoot, protectedPaths: [options.sourceFile, options.configFile] };
  resolveSafeOutputPath(cfg.csvOutput, protection);
  resolveSafeOutputPath(getTranslatedCsvPath(cfg.csvOutput), protection);
  assertSafeDirectory(cfg.batchDir, protection);
  assertSafeDirectory(cfg.outputDir, protection);
  return options;
}

async function handleXlfToCsv() {
  const cfg = config.config;
  const languages = targetCodes();
  if (!languages.length) throw new Error('No target languages configured');
  if (!existsSync(cfg.sourceFile)) throw new Error(`Source XLF file not found: ${cfg.sourceFile}. Extract it with ng extract-i18n --format xlf`);
  const path = xlfToCsv(cfg.sourceFile, cfg.csvOutput, languages, { ...outputOptions(), sourceLanguage: cfg.sourceLanguage });
  log(`CSV file created: ${path}`);
  return 0;
}

async function handleCsvToXlf(languages = targetCodes()) {
  const cfg = config.config;
  const csv = getTranslatedCsvPath(cfg.csvOutput);
  if (!existsSync(csv)) throw new Error(`Translated CSV not found: ${csv}. Run npm run translate or npm run translate:merge first`);
  const result = csvToXlf(csv, cfg.outputDir, languages, {
    ...outputOptions(), sourceLanguage: cfg.sourceLanguage, original: 'messages',
    fileNames: Object.fromEntries(getTargetLanguages().map(language => [language.code, language.file])),
  });
  for (const [language, path] of Object.entries(result.files)) log(`Generated ${language}: ${path}`);
  for (const issue of result.issues) warn(issue);
  return 0;
}

async function handleTranslateSplit() {
  const cfg = config.config;
  const result = await splitBatches(cfg.csvOutput, cfg.llm.batchSize, cfg.batchDir, outputOptions());
  log(`Created ${result.batchCount} batches (${result.recordCount} records)`);
  if (globalOptions.verbose) log(`Removed ${result.removedStale.length} stale files`);
  return 0;
}

async function handleTranslateRun(options = {}) {
  const cfg = config.config;
  const languages = targetCodes();
  if (!languages.length) throw new Error('No target languages configured');
  let failed = false;
  for (const language of languages) {
    try {
      const summary = await runBatches(cfg.batchDir, language, cfg.llm, { ...outputOptions(), force: options.force, concurrency: cfg.llm.concurrency });
      log(`${language}: processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}`);
      for (const item of summary.errors) error(`${language}/${item.batch}: ${item.error}`);
      for (const item of summary.warnings || []) warn(`${language}/${item.batch}: ${item.warning}`);
      if (summary.failed) failed = true;
    } catch (cause) {
      error(`${language}: ${cause.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

async function handleTranslateMerge() {
  const cfg = config.config;
  const result = await mergeBatches(cfg.csvOutput, cfg.batchDir, { ...outputOptions(), languages: targetCodes(), llm: cfg.llm });
  log(`Merged CSV saved to: ${result.outputFile}`);
  for (const item of result.errors || []) error(`${item.lang}/${item.batch}: ${item.error}`);
  for (const item of result.missing) error(`${item.lang}: ${item.ids.length} missing translations (${item.ids.slice(0, 5).join(', ')})`);
  return result.missing.length || result.errors?.length ? 1 : 0;
}

async function handleTranslateAll(options = {}) {
  await handleXlfToCsv();
  await handleTranslateSplit();
  const runExit = await handleTranslateRun(options);
  const mergeExit = await handleTranslateMerge();
  const csv = getTranslatedCsvPath(config.config.csvOutput);
  let exported = 0;
  const skipped = [];
  for (const language of targetCodes()) {
    const report = validateAll(csv, [language]);
    if (!report.summary.allValid) {
      skipped.push(language);
      for (const issue of report.issues.filter(item => item.severity === 'error')) error(`${language}/${issue.id}:${issue.line} ${issue.issue}`);
      continue;
    }
    try {
      await handleCsvToXlf([language]);
      exported++;
    } catch (cause) {
      skipped.push(language);
      error(`${language}: ${cause.message}`);
    }
  }
  log(`Exported ${exported}/${targetCodes().length} languages`);
  if (skipped.length) error(`Not exported: ${skipped.join(', ')}. Any existing files for these languages are old outputs, not results of this run.`);
  if (runExit || mergeExit || skipped.length) return 1;
  log('All steps completed successfully!');
  return 0;
}

async function handleValidate(options = {}) {
  const csv = options.file || getTranslatedCsvPath(config.config.csvOutput);
  if (!existsSync(csv)) throw new Error(`CSV file not found: ${csv}. Run npm run translate; use validate --file to check another canonical CSV`);
  return validate(csv, targetCodes(), { verbose: !globalOptions.quiet, strict: options.strict });
}

async function handleClean(options = {}) {
  const cfg = config.config;
  const result = await cleanAll({
    batchDir: cfg.batchDir, outputDir: cfg.outputDir, csvPath: cfg.csvOutput,
    translatedCsvPath: getTranslatedCsvPath(cfg.csvOutput), sourceFile: resolve(cfg.sourceFile), configFile: DEFAULT_CONFIG_PATH,
  }, { ...outputOptions(), dryRun: options.dryRun });
  for (const warning of result.warnings) warn(warning);
  for (const path of options.dryRun ? result.planned : result.removed) log(`${options.dryRun ? 'Would remove' : 'Removed'}: ${path}`);
  log(options.dryRun ? 'Dry run: no files removed' : `Cleanup completed (${result.removed.length} files removed)`);
  return 0;
}

const program = new Command();
program.name('angular-i18n-translator').description('CLI for managing Angular i18n translations with LLM').version(packageJson.version)
  .option('--quiet', 'Suppress non-essential output').option('--verbose', 'Enable verbose output')
  .hook('preAction', () => { globalOptions = program.opts(); });

function action(handler) {
  return async options => {
    try { process.exitCode = await handler(options); }
    catch (cause) { error(formatError(cause)); process.exitCode = 1; }
  };
}

program.command('init').description('Interactive configuration wizard to set up i18n.config.json and .env').action(action(handleInit));
program.command('xlf-to-csv').description('Convert XLF file to canonical CSV format').action(action(handleXlfToCsv));
program.command('csv-to-xlf').description('Validate and convert translated CSV to XLF files per language').action(action(() => handleCsvToXlf()));
program.command('translate-split').description('Split CSV into batches for translation').action(action(handleTranslateSplit));
program.command('translate-run').description('Translate batches with the LLM (languages sequentially, batches in parallel)').option('-f, --force', 'Force re-translation of existing batches').action(action(handleTranslateRun));
program.command('translate-merge').description('Merge current valid translated batches').action(action(handleTranslateMerge));
program.command('translate').alias('translate-all').description('Run the full translation pipeline').option('-f, --force', 'Force re-translation of existing batches').action(action(handleTranslateAll));
program.command('validate').description('Validate the translated CSV').option('--file <path>', 'Validate another canonical CSV').option('--strict', 'Treat warnings as failures').action(action(handleValidate));
program.command('clean').description('Remove owned generated files only').option('--dry-run', 'Show deletion targets without removing files').action(action(handleClean));

try { await program.parseAsync(); }
catch (cause) { error(formatError(cause)); process.exitCode = 1; }

import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { xlfToCsv, csvToXlf } from './csv-converter.js';
import { splitBatches, runBatches, mergeBatches } from './batch-manager.js';
import { cleanAll } from './cleaner.js';
import { validate } from './validator.js';
import { ConfigService } from './services/config-service.js';
import { OutputService } from './services/output-service.js';
import { EXIT_CODES } from './constants/exit-codes.js';
import { parseArgs, normalizeCommand, getUsage } from './cli/arg-parser.js';

const PIPELINE_STEPS = ['xlf-to-csv', 'split', 'run', 'merge', 'csv-to-xlf'];

function nowMs() {
  return Date.now();
}

function inferErrorCode(error, action = '') {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('configuration') || message.includes('config') || message.includes('api key')) {
    return EXIT_CODES.CONFIG_ERROR;
  }
  if (message.includes('timeout') || message.includes('api error') || message.includes('rate limit') || message.includes('fetch')) {
    return EXIT_CODES.LLM_ERROR;
  }
  if (action === 'validate' || message.includes('validation')) {
    return EXIT_CODES.VALIDATION_ERROR;
  }
  return EXIT_CODES.INPUT_ERROR;
}

function getTargetLanguageCodes(configService, config) {
  return configService.getTargetLanguages(config).map(lang => lang.code);
}

function getBasePaths(config) {
  return {
    sourceFile: config.sourceFile || 'messages.xlf',
    csvOutput: config.csvOutput || 'messages.csv',
    batchDir: config.batchDir || 'batches',
    outputDir: config.outputDir || 'dist-i18n'
  };
}

async function executeStep(step, context) {
  const { output, configService, flags } = context;
  const validationProfile =
    step === 'split' ? 'translate-split' :
    step === 'run' ? (flags.dryRun ? 'translate-run-dry' : 'translate-run') :
    step === 'merge' ? 'translate-merge' :
    step === 'csv-to-xlf' ? 'csv-to-xlf' :
    'xlf-to-csv';
  const config = configService.validateFor(validationProfile);
  const { sourceFile, csvOutput, batchDir, outputDir } = getBasePaths(config);
  const targetLanguages = getTargetLanguageCodes(configService, config);

  if (step === 'xlf-to-csv') {
    if (flags.dryRun) {
      output.info(`Dry-run: would convert ${sourceFile} to ${csvOutput}`);
      return { artifacts: [csvOutput], status: 'planned' };
    }
    xlfToCsv(sourceFile, csvOutput, targetLanguages, { sourceLanguage: config.sourceLanguage });
    output.success(`CSV generated: ${csvOutput}`);
    return { artifacts: [csvOutput], status: 'done' };
  }

  if (step === 'split') {
    const batchSize = config.llm?.batchSize || 50;
    if (flags.dryRun && !existsSync(csvOutput)) {
      output.info(`Dry-run: would split ${csvOutput} into batches of ${batchSize}`);
      return { artifacts: [`${batchDir}/pending`], status: 'planned' };
    }
    const batches = await splitBatches(csvOutput, batchSize, batchDir, { dryRun: flags.dryRun });
    output.success(`${flags.dryRun ? 'Planned' : 'Created'} ${batches} batches`);
    return { artifacts: [`${batchDir}/pending`], status: flags.dryRun ? 'planned' : 'done' };
  }

  if (step === 'run') {
    const languages = targetLanguages;
    if (languages.length === 0) {
      throw new Error('No target languages configured');
    }

    const aggregate = { processed: 0, skipped: 0, failed: 0, planned: 0 };
    for (const lang of languages) {
      output.info(`Language ${lang}: start`);
      const summary = await runBatches(batchDir, lang, config.llm, {
        dryRun: flags.dryRun,
        resume: flags.resume || !flags.overwrite,
        overwrite: flags.overwrite,
        concurrency: config.llm?.concurrency || 5,
        onProgress: (current, total, status) => {
          if (status === 'completed' || status === 'skipped' || status === 'planned') {
            output.progress(`[${lang}] batch ${current}/${total}: ${status}`);
          }
        }
      });

      aggregate.processed += summary.processed;
      aggregate.skipped += summary.skipped;
      aggregate.failed += summary.failed;
      aggregate.planned += summary.planned;
      output.info(`Language ${lang}: processed=${summary.processed}, skipped=${summary.skipped}, failed=${summary.failed}, planned=${summary.planned}`);
    }

    if (aggregate.failed > 0 && aggregate.processed === 0 && aggregate.planned === 0) {
      throw new Error('Translation failed for all languages');
    }
    return { artifacts: [`${batchDir}/translated`], status: flags.dryRun ? 'planned' : 'done', aggregate };
  }

  if (step === 'merge') {
    if (flags.dryRun) {
      const merged = csvOutput.replace(/\.csv$/, '.translated.csv');
      output.info(`Dry-run: would merge translated batches into ${merged}`);
      return { artifacts: [merged], status: 'planned' };
    }
    const merged = await mergeBatches(csvOutput, batchDir);
    output.success(`Merged CSV generated: ${merged}`);
    return { artifacts: [merged], status: 'done' };
  }

  if (step === 'csv-to-xlf') {
    const mergedFile = csvOutput.replace(/\.csv$/, '.translated.csv');
    if (flags.dryRun) {
      output.info(`Dry-run: would generate XLF files from ${mergedFile}`);
      return { artifacts: [outputDir], status: 'planned' };
    }
    const files = csvToXlf(mergedFile, outputDir, targetLanguages, {
      sourceLanguage: config.sourceLanguage,
      original: 'messages'
    });
    output.success(`Generated ${Object.keys(files).length} XLF files`);
    return { artifacts: Object.values(files), status: 'done' };
  }

  throw new Error(`Unknown pipeline step: ${step}`);
}

async function handleTranslateRun(context) {
  const artifacts = [];
  for (const step of PIPELINE_STEPS) {
    context.output.title(`Step: ${step}`);
    const result = await executeStep(step, context);
    artifacts.push(...(result.artifacts || []));
  }
  return { artifacts };
}

async function handleTranslateStep(context, step) {
  if (!PIPELINE_STEPS.includes(step)) {
    throw new Error(`Invalid translate step "${step}". Valid: ${PIPELINE_STEPS.join(', ')}`);
  }
  return executeStep(step, context);
}

function handleExtract(output, configService) {
  const sourceFile = configService.exists() ? (configService.load().sourceFile || 'messages.xlf') : 'messages.xlf';
  output.info(`ng extract-i18n --output-path src/locale --out-file ${sourceFile}`);
  output.info('Angular 17+: ng extract-i18n --format xlf2 --output-path src/locale');
  return { artifacts: [sourceFile] };
}

function handleValidate(output, configService) {
  const config = configService.validateFor('validate');
  const csvFile = config.csvOutput || 'messages.csv';
  const targetLanguages = getTargetLanguageCodes(configService, config);
  const resultCode = validate(csvFile, targetLanguages, { verbose: !output.json });
  if (resultCode !== 0) {
    const err = new Error('Validation failed');
    err.exitCode = EXIT_CODES.VALIDATION_ERROR;
    throw err;
  }
  output.success('Validation passed');
  return { artifacts: [csvFile] };
}

async function handleClean(output, configService, argv) {
  const config = configService.exists() ? configService.load() : {};
  const cleanOptions = {
    csv: !argv.includes('--batches-only') && !argv.includes('--output-only') || argv.includes('--csv-only'),
    batches: !argv.includes('--csv-only') && !argv.includes('--output-only') || argv.includes('--batches-only') || argv.includes('--keep-csv'),
    output: !argv.includes('--csv-only') && !argv.includes('--batches-only') || argv.includes('--output-only') || argv.includes('--keep-csv')
  };
  if (argv.includes('--keep-csv')) {
    cleanOptions.csv = false;
  }

  await cleanAll({
    batchDir: config.batchDir || 'batches',
    outputDir: config.outputDir || 'dist-i18n',
    csvPath: config.csvOutput || 'messages.csv',
    translatedCsvPath: (config.csvOutput || 'messages.csv').replace('.csv', '.translated.csv')
  }, cleanOptions);

  output.success('Cleanup finished');
  return { artifacts: [config.batchDir || 'batches', config.outputDir || 'dist-i18n'] };
}

function handleDoctor(output, configService) {
  const checks = [];
  const push = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

  const envPath = resolve('.env');
  push('.env file', existsSync(envPath), existsSync(envPath) ? 'Found' : `Missing: ${envPath}`, 'Run: node src/index.js init');

  if (!configService.exists()) {
    push('i18n.config.json', false, 'Missing configuration file', 'Run: node src/index.js init');
  } else {
    push('i18n.config.json', true, 'Found configuration file', null);
    try {
      const config = configService.load();
      const paths = getBasePaths(config);
      push('source file', existsSync(paths.sourceFile), existsSync(paths.sourceFile) ? `Found: ${paths.sourceFile}` : `Missing: ${paths.sourceFile}`, 'Copy your messages.xlf or update sourceFile');

      const llmConfigured = Boolean(config.llm?.baseURL && config.llm?.model && config.llm?.apiKey && !String(config.llm.apiKey).includes('${'));
      push('LLM settings', llmConfigured, llmConfigured ? 'Configured' : 'Incomplete LLM config for translation', 'Set LLM_BASE_URL, LLM_MODEL, LLM_API_KEY in .env');
    } catch (error) {
      push('configuration parse', false, error.message, 'Fix JSON syntax and required fields');
    }
  }

  const failed = checks.filter(check => !check.ok);
  for (const check of checks) {
    if (check.ok) {
      output.success(`${check.name}: ${check.detail}`);
    } else {
      output.warn(`${check.name}: ${check.detail}`);
      if (check.fix) {
        output.info(`  fix: ${check.fix}`);
      }
    }
  }

  if (failed.length > 0) {
    const error = new Error(`Doctor found ${failed.length} issue(s)`);
    error.exitCode = EXIT_CODES.CONFIG_ERROR;
    throw error;
  }

  output.success('Doctor checks passed');
  return { artifacts: [] };
}

function handleInit(output) {
  const configTemplate = {
    languages: [
      { code: 'en', name: 'English', file: 'messages.en.xlf' },
      { code: 'es', name: 'Spanish', file: 'messages.es.xlf' }
    ],
    sourceLanguage: 'en',
    sourceFile: 'messages.xlf',
    csvOutput: 'messages.csv',
    outputDir: 'dist-i18n',
    batchDir: 'batches',
    llm: {
      baseURL: '${LLM_BASE_URL}',
      apiKey: '${LLM_API_KEY}',
      model: '${LLM_MODEL}',
      batchSize: 50,
      concurrency: 5,
      systemPrompt: 'You are a professional translator specializing in software localization.'
    }
  };

  const envTemplate = [
    'LLM_API_KEY=your-api-key-here',
    'LLM_MODEL=deepseek-chat',
    'LLM_BASE_URL=https://api.deepseek.com/v1'
  ].join('\n');

  if (!existsSync('i18n.config.json')) {
    writeFileSync('i18n.config.json', `${JSON.stringify(configTemplate, null, 2)}\n`, 'utf-8');
    output.success('Created i18n.config.json');
  } else {
    output.warn('i18n.config.json already exists (kept as-is)');
  }

  if (!existsSync('.env')) {
    writeFileSync('.env', `${envTemplate}\n`, 'utf-8');
    output.success('Created .env');
  } else {
    output.warn('.env already exists (kept as-is)');
  }

  output.info('Next: run `node src/index.js doctor`');
  return { artifacts: ['i18n.config.json', '.env'] };
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const normalized = normalizeCommand(parsed);
  const output = new OutputService({ json: parsed.flags.json });
  const configService = new ConfigService();
  const startedAt = nowMs();

  if (!parsed.command || parsed.flags.help) {
    console.log(getUsage(parsed.command));
    if (parsed.command === 'translate' && parsed.flags.help) {
      console.log('');
      console.log(getUsage('translate'));
    }
    return EXIT_CODES.SUCCESS;
  }

  try {
    let result;
    if (normalized.action === 'translate-run') {
      result = await handleTranslateRun({ output, configService, flags: parsed.flags });
    } else if (normalized.action === 'translate-step') {
      result = await handleTranslateStep({ output, configService, flags: parsed.flags }, normalized.step);
    } else if (normalized.action === 'xlf-to-csv') {
      result = await executeStep('xlf-to-csv', { output, configService, flags: parsed.flags });
    } else if (normalized.action === 'csv-to-xlf') {
      result = await executeStep('csv-to-xlf', { output, configService, flags: parsed.flags });
    } else if (normalized.action === 'translate-split') {
      result = await executeStep('split', { output, configService, flags: parsed.flags });
    } else if (normalized.action === 'translate-merge') {
      result = await executeStep('merge', { output, configService, flags: parsed.flags });
    } else if (normalized.action === 'extract') {
      result = handleExtract(output, configService);
    } else if (normalized.action === 'validate') {
      result = handleValidate(output, configService);
    } else if (normalized.action === 'clean') {
      result = await handleClean(output, configService, argv);
    } else if (normalized.action === 'doctor') {
      result = handleDoctor(output, configService);
    } else if (normalized.action === 'init') {
      result = handleInit(output);
    } else {
      throw new Error(`Unknown command: ${parsed.command}`);
    }

    output.printSummary({
      status: 'success',
      durationMs: nowMs() - startedAt,
      artifacts: result?.artifacts || [],
      nextAction: parsed.command === 'init' ? 'Run doctor to validate setup' : null
    });
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    output.error(error.message);
    const exitCode = error.exitCode || inferErrorCode(error, normalized.action);
    output.printSummary({
      status: 'failed',
      durationMs: nowMs() - startedAt,
      artifacts: [],
      nextAction: 'Run with --help or use `doctor` for setup checks'
    });
    return exitCode;
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error);
    process.exit(EXIT_CODES.INPUT_ERROR);
  });

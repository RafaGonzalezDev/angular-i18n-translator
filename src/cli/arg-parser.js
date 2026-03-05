export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    resume: argv.includes('--resume'),
    overwrite: argv.includes('--overwrite')
  };

  const positional = argv.filter(arg => !arg.startsWith('--') && arg !== '-h');
  const [command = '', subcommand = '', ...rest] = positional;

  return {
    command,
    subcommand,
    rest,
    flags
  };
}

export function normalizeCommand(parsed) {
  const { command, subcommand, rest } = parsed;

  if (command === 'translate') {
    if (!subcommand || subcommand === 'run') {
      return { action: 'translate-run', step: null };
    }
    if (subcommand === 'step') {
      return { action: 'translate-step', step: rest[0] || null };
    }
  }

  if (command === 'xlf-to-csv') return { action: 'xlf-to-csv', step: null };
  if (command === 'csv-to-xlf') return { action: 'csv-to-xlf', step: null };
  if (command === 'translate-split') return { action: 'translate-split', step: null };
  if (command === 'translate-run') return { action: 'translate-run', step: null };
  if (command === 'translate-merge') return { action: 'translate-merge', step: null };
  if (command === 'translate-all') return { action: 'translate-run', step: null };

  return { action: command, step: null };
}

export function getUsage(action = 'root') {
  if (action === 'translate') {
    return [
      'Usage:',
      '  node src/index.js translate run [--dry-run] [--resume] [--overwrite] [--json]',
      '  node src/index.js translate step <xlf-to-csv|split|run|merge|csv-to-xlf> [--dry-run] [--json]'
    ].join('\n');
  }

  if (action === 'doctor') {
    return [
      'Usage:',
      '  node src/index.js doctor [--json]'
    ].join('\n');
  }

  if (action === 'init') {
    return [
      'Usage:',
      '  node src/index.js init'
    ].join('\n');
  }

  return [
    'Angular i18n Translator CLI',
    '',
    'Usage:',
    '  node src/index.js <command> [options]',
    '',
    'Commands:',
    '  translate run                        Run full translation pipeline',
    '  translate step <step>                Run one pipeline step',
    '  xlf-to-csv                           Convert source XLF to CSV',
    '  csv-to-xlf                           Generate target XLF files',
    '  validate                             Validate translation CSV',
    '  clean                                Clean generated artifacts',
    '  doctor                               Validate setup and project health',
    '  init                                 Generate starter config files',
    '  extract                              Print Angular extract-i18n command',
    '',
    'Global options:',
    '  --help, -h                           Show help',
    '  --json                               JSON output mode',
    '  --dry-run                            Plan actions without writing files',
    '  --resume                             Skip already translated batches',
    '  --overwrite                          Re-translate existing translated batches'
  ].join('\n');
}

export default {
  parseArgs,
  normalizeCommand,
  getUsage
};

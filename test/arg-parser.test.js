import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, normalizeCommand } from '../src/cli/arg-parser.js';

test('parseArgs reads global flags', () => {
  const parsed = parseArgs(['translate', 'run', '--json', '--dry-run', '--overwrite']);
  assert.equal(parsed.command, 'translate');
  assert.equal(parsed.subcommand, 'run');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.dryRun, true);
  assert.equal(parsed.flags.overwrite, true);
});

test('normalizeCommand maps translate run', () => {
  const normalized = normalizeCommand(parseArgs(['translate', 'run']));
  assert.equal(normalized.action, 'translate-run');
});

test('normalizeCommand maps translate step', () => {
  const normalized = normalizeCommand(parseArgs(['translate', 'step', 'merge']));
  assert.equal(normalized.action, 'translate-step');
  assert.equal(normalized.step, 'merge');
});

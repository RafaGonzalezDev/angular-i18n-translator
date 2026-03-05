import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, renameSync, rmSync } from 'fs';

function runCli(args, extraEnv = {}) {
  return spawnSync('node', ['src/index.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: 'utf-8'
  });
}

test('doctor reports missing setup with actionable fix', () => {
  const envPath = '.env';
  const backupPath = '.env.test-backup';
  const hadEnv = existsSync(envPath);

  if (hadEnv) {
    renameSync(envPath, backupPath);
  }

  try {
    const result = runCli(['doctor', '--json']);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /fix/i);
  } finally {
    if (hadEnv) {
      renameSync(backupPath, envPath);
    }
  }
});

test('translate run --dry-run completes successfully', () => {
  const result = runCli(
    ['translate', 'run', '--dry-run', '--json'],
    {
      LLM_API_KEY: 'test-key',
      LLM_MODEL: 'test-model',
      LLM_BASE_URL: 'https://example.com/v1'
    }
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /summary/);
});

test('validate command passes with fixture csv', () => {
  copyFileSync('test/fixtures/valid-translations.csv', 'messages.csv');
  try {
    const result = runCli(['validate', '--json']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /success/i);
  } finally {
    rmSync('messages.csv', { force: true });
  }
});

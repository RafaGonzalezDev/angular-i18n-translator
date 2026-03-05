import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInterpolations } from '../src/validator.js';

const validFile = 'test/fixtures/valid-translations.csv';
const invalidFile = 'test/fixtures/invalid-interpolation.csv';

test('validateInterpolations passes with valid fixture', () => {
  const result = validateInterpolations(validFile, ['es', 'fr']);
  assert.equal(result.valid, true);
});

test('validateInterpolations finds missing interpolation', () => {
  const result = validateInterpolations(invalidFile, ['es']);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.issue.includes('Missing interpolation')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCSVContent } from '../src/llm-client.js';

test('extractCSVContent handles markdown code block', () => {
  const input = '```csv\nid,source,es\n1,Hello,Hola\n```';
  const csv = extractCSVContent(input);
  assert.match(csv, /^id,source,es/m);
});

test('extractCSVContent throws on non-csv response', () => {
  assert.throws(() => extractCSVContent('No CSV here'));
});

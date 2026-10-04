import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, parseMessageContent } from '../src/message-content.js';

 test('rejects malformed, invented, altered and missing placeholders', () => {
  const source = 'Hello <x id="PH" disp="{{name}}"/>';
  for (const target of ['Hola <x id="PH">', 'Hola', 'Hola <x id="OTHER"/>', 'Hola <x id="PH" disp="{{other}}"/>']) {
    assert.ok(validateMessage(source, target).length > 0, target);
  }
  assert.deepEqual(validateMessage(source, '<x disp="{{name}}" id="PH"/> Hola'), []);
});

test('literal inline-looking text remains text and malformed entities fail', () => {
  assert.deepEqual(validateMessage('Show &lt;x id="FAKE"/&gt;', 'Mostrar &lt;x id="FAKE"/&gt;'), []);
  assert.ok(validateMessage('Show &lt;x id="FAKE"/&gt;', 'Mostrar <x id="FAKE"/>').length);
  assert.throws(() => parseMessageContent('Tom & Jerry'), /entity|XML/i);
  assert.throws(() => parseMessageContent('Bad &#0;'), /XML|character/i);
  assert.throws(() => parseMessageContent('<!DOCTYPE test>'), /DOCTYPE|XML/i);
});

test('ICU requires variable, type, other, explicit cases and nested validity', () => {
  const source = '{count, plural, =0 {None} other {# items}}';
  for (const target of ['{otro, plural, =0 {Ninguno} other {items}}', '{count, plural, =0 {Ninguno} one {item}}', '{count, plural, other {items}}', '{count, plural, other {items}', '{count, plural, other {a} other {b}}']) {
    assert.ok(validateMessage(source, target).length, target);
  }
  assert.deepEqual(validateMessage(source, '{count, plural, =0 {Ninguno} one {Uno} few {Pocos} other {# elementos}}'), []);
  const nested = '{n, plural, other {{gender, select, male {His} other {Their}} items}}';
  assert.ok(validateMessage(nested, '{n, plural, other {{gender, select, male {Su}} elementos}}').length);
  assert.ok(validateMessage('{g, select, male {His} other {Their}}', '{g, select, other {Su}}').length);
});

test('interpolation multiplicity and placeholder nesting are preserved', () => {
  assert.ok(validateMessage('{{name}} {{name}}', '{{name}}').length);
  assert.ok(validateMessage('Hello', 'Hola {{invented}}').length);
  assert.ok(validateMessage('<g id="a"><x id="b"/></g>', '<g id="a"></g><x id="b"/>').length);
  assert.deepEqual(validateMessage('OK', 'OK'), []);
  assert.ok(validateMessage('<x id="START_TAG_SPAN"/>text<x id="CLOSE_TAG_SPAN"/>', '<x id="CLOSE_TAG_SPAN"/>texto<x id="START_TAG_SPAN"/>').length);
  assert.ok(validateMessage('<bx id="a" rid="1"/>text<ex id="b" rid="1"/>', '<ex id="b" rid="1"/>texto<bx id="a" rid="1"/>').length);
});

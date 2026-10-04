import { DOMParser } from '@xmldom/xmldom';
import { XmlParser } from '@angular/compiler';

const INLINE_TAGS = new Set(['x', 'g', 'bx', 'ex', 'ph', 'bpt', 'ept', 'sub', 'mrk', 'it']);
const XML_PARSER = new XmlParser();

export function isMissingTranslation(source, target) {
  return source !== '' && (target === '' || (Boolean(source.trim()) && !target.trim()));
}

export function escapeText(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttribute(value = '') {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function assertCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) {
      throw new Error('Invalid XML character');
    }
  }
}

export function parseXmlDocument(content) {
  if (typeof content !== 'string') throw new Error('Invalid XML: content must be a string');
  assertCharacters(content);
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('Invalid XML: DOCTYPE and custom entities are not supported');
  // CDATA and comments contain literal ampersands, not entity references.
  const entityContent = content.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(entityContent)) {
    throw new Error('Invalid XML entity reference; escape literal ampersands as &amp;');
  }
  for (const [, decimal, hex] of entityContent.matchAll(/&#(?:(\d+)|x([\da-fA-F]+));/g)) {
    const code = Number.parseInt(decimal || hex, decimal ? 10 : 16);
    if (!Number.isFinite(code) || code > 0x10ffff) throw new Error('Invalid XML character reference');
    assertCharacters(String.fromCodePoint(code));
  }
  const issues = [];
  let document;
  try {
    document = new DOMParser({ onError: (level, message) => issues.push(`${level}: ${message}`) }).parseFromString(content, 'application/xml');
  } catch (error) {
    throw new Error(`Invalid XML: ${error.message}`);
  }
  if (issues.length || !document?.documentElement) throw new Error(`Invalid XML: ${issues[0] || 'missing root element'}`);
  return document;
}

export function parseMessageContent(content) {
  const document = parseXmlDocument(`<message>${content}</message>`);
  const root = document.documentElement;
  function inspect(node) {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 1) {
        if (!INLINE_TAGS.has(child.tagName)) throw new Error(`Unsupported inline XML element: <${child.tagName}>`);
        inspect(child);
      } else if (![3, 4].includes(child.nodeType)) {
        throw new Error('Invalid XML message: comments and processing instructions are not supported');
      }
    }
  }
  inspect(root);
  return root;
}

/** Canonical content retains the text/element distinction, including CDATA. */
export function serializeContent(element) {
  return Array.from(element?.childNodes || []).map(node => {
    if (node.nodeType === 3 || node.nodeType === 4) return escapeText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const attributes = Array.from(node.attributes || []).map(attribute => `${attribute.name}="${escapeAttribute(attribute.value)}"`).join(' ');
    const start = `<${node.tagName}${attributes ? ` ${attributes}` : ''}`;
    return node.childNodes.length ? `${start}>${serializeContent(node)}</${node.tagName}>` : `${start}/>`;
  }).join('');
}

function difference(left, right) {
  const remaining = [...right];
  return left.filter(value => {
    const index = remaining.indexOf(value);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function codeText(nodes) {
  return nodes.map(node => node.name === 'sub' ? '' : typeof node.value === 'string' ? node.value : codeText(node.children || [])).join('');
}

function signatures(nodes, ancestors = [], result = { placeholders: [], interpolations: [] }) {
  for (const node of nodes) {
    // ICU branches are compared independently, including new plural categories.
    if (node.cases) continue;
    if (typeof node.value === 'string') result.interpolations.push(...(node.value.match(/\{\{[^}]+\}\}/g) || []));
    if (!node.name) continue;
    const attrs = (node.attrs || []).map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b));
    for (const [, value] of attrs) result.interpolations.push(...(value.match(/\{\{[^}]+\}\}/g) || []));
    const protectedCode = ['ph', 'bpt', 'ept', 'it'].includes(node.name) ? codeText(node.children || []) : null;
    const signature = JSON.stringify([node.name, attrs, protectedCode]);
    result.placeholders.push(JSON.stringify([...ancestors, signature]));
    signatures(node.children || [], [...ancestors, signature], result);
  }
  return result;
}

function comparePlain(sourceNodes, targetNodes, errors) {
  const source = signatures(sourceNodes);
  const target = signatures(targetNodes);
  for (const signature of difference(source.placeholders, target.placeholders)) errors.push(`Missing placeholder or altered attributes/nesting: ${signature}`);
  for (const signature of difference(target.placeholders, source.placeholders)) errors.push(`Extra placeholder or altered attributes/nesting: ${signature}`);
  for (const value of difference(source.interpolations, target.interpolations)) errors.push(`Missing interpolation: ${value}`);
  for (const value of difference(target.interpolations, source.interpolations)) errors.push(`Extra interpolation: ${value}`);
}

function readIcu(content) {
  const result = XML_PARSER.parse(content, 'message', { tokenizeExpansionForms: true });
  if (result.errors.length) throw new Error(`Invalid ICU/XML: ${result.errors[0].msg}`);
  function inspect(nodes) {
    const pairs = [];
    for (const node of nodes) {
      const attribute = name => node.attrs?.find(attr => attr.name === name)?.value;
      const id = attribute('id') || '';
      const interpolation = attribute('equiv') === 'interpolation' || /\{\{/.test(attribute('equiv-text') || attribute('disp') || '');
      if (node.name === 'x' && !interpolation && id.startsWith('START_')) pairs.push(`angular:${id.slice(6)}`);
      if (node.name === 'x' && !interpolation && id.startsWith('CLOSE_') && pairs.pop() !== `angular:${id.slice(6)}`) throw new Error('Invalid Angular placeholder pair or nesting');
      const pairId = attribute('rid') || id;
      if (['bx', 'bpt'].includes(node.name)) pairs.push(`${node.name}:${pairId}`);
      if (['ex', 'ept'].includes(node.name) && pairs.pop() !== `${node.name === 'ex' ? 'bx' : 'bpt'}:${pairId}`) throw new Error('Invalid XLIFF placeholder pair or nesting');
      if (node.cases) {
        if (!['plural', 'select', 'selectordinal'].includes(node.type)) throw new Error(`Invalid ICU type: ${node.type}`);
        const keys = node.cases.map(item => item.value);
        if (new Set(keys).size !== keys.length) throw new Error('Duplicate ICU case');
        if (!keys.includes('other')) throw new Error('ICU requires an other case');
        if (node.type !== 'select' && keys.some(key => !/^(?:zero|one|two|few|many|other|=\d+)$/.test(key))) {
          throw new Error('Invalid ICU plural category');
        }
        for (const item of node.cases) inspect(item.expression);
      }
      if (node.children) inspect(node.children);
    }
    if (pairs.length) throw new Error('Unclosed inline placeholder pair');
  }
  inspect(result.rootNodes);
  return result.rootNodes;
}

function expansions(nodes, ancestors = []) {
  return nodes.flatMap(node => {
    if (node.cases) return [{ expansion: node, context: JSON.stringify(ancestors) }];
    const attrs = (node.attrs || []).map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b));
    return node.children ? expansions(node.children, [...ancestors, [node.name, attrs]]) : [];
  });
}

function compareIcu(sourceNodes, targetNodes, errors) {
  comparePlain(sourceNodes, targetNodes, errors);
  const sourceExpansions = expansions(sourceNodes);
  const remaining = [...expansions(targetNodes)];
  for (const entry of sourceExpansions) {
    const source = entry.expansion;
    const index = remaining.findIndex(target => target.context === entry.context && target.expansion.switchValue === source.switchValue && target.expansion.type === source.type);
    if (index < 0) {
      errors.push(`Missing or altered ICU: ${source.switchValue}, ${source.type}`);
      continue;
    }
    const target = remaining.splice(index, 1)[0].expansion;
    const sourceCases = new Map(source.cases.map(item => [item.value, item]));
    const targetCases = new Map(target.cases.map(item => [item.value, item]));
    const required = [...sourceCases.keys()].filter(key => source.type === 'select' || key === 'other' || key.startsWith('='));
    for (const key of required) if (!targetCases.has(key)) errors.push(`Missing ICU case: ${key}`);
    for (const [key, item] of targetCases) {
      if ((source.type === 'select' || key.startsWith('=')) && !sourceCases.has(key)) {
        errors.push(`Extra ICU case: ${key}`);
      } else {
        const sourceCase = sourceCases.get(key) || sourceCases.get('other');
        if (sourceCase) compareIcu(sourceCase.expression, item.expression, errors);
      }
    }
  }
  if (remaining.length) errors.push('Extra or altered ICU expression');
}

/** Pure structural validation, shared by the LLM, CSV validation and export. */
export function validateMessage(source, target) {
  const errors = [];
  try { parseMessageContent(source); } catch (error) { return [`Source ${error.message}`]; }
  try { parseMessageContent(target); } catch (error) { return [`Target ${error.message}`]; }
  try { compareIcu(readIcu(source), readIcu(target), errors); } catch (error) { errors.push(error.message); }
  return errors;
}

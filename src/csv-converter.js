/**
 * CSV Converter Module
 *
 * Converts between XLIFF 1.2 (XLF) files and CSV files.
 *
 * Inline XML placeholders used by Angular (`<x/>`, `<g>`, ...) are kept as
 * raw markup inside the CSV so they can be inspected and edited manually.
 * When writing XLF back, only free text is XML-escaped; inline tags are
 * passed through untouched and each unit is validated before writing.
 */

import { parse as csvParseSync } from 'csv-parse/sync';
import { stringify as csvStringifySync } from 'csv-stringify/sync';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { DOMParser } from '@xmldom/xmldom';

// XLIFF namespaces
const XLIFF12_NS = 'urn:oasis:names:tc:xliff:document:1.2';
const XLIFF2_NS = 'urn:oasis:names:tc:xliff:document:2.0';

// Inline XLIFF elements that may appear inside source/target content
const INLINE_TAGS = ['x', 'g', 'bx', 'ex', 'ph', 'bpt', 'ept', 'sub', 'mrk', 'it'];
const INLINE_TAG_RE = new RegExp(
  `</?(?:${INLINE_TAGS.join('|')})\\b[^>]*\\/?>`,
  'gi'
);

// ============================================================================
// XML HELPERS
// ============================================================================

/**
 * Escapes XML special characters in text content.
 * Inline markup is NOT expected here; use escapeXmlContent for values that
 * may contain inline XLIFF tags.
 */
function escapeText(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes a value for use inside a double-quoted XML attribute.
 */
function escapeAttr(str) {
  if (!str) return '';
  return escapeText(str).replace(/"/g, '&quot;');
}

/**
 * Escapes free text while passing inline XLIFF tags through unchanged.
 * @param {string} str - Content possibly containing inline tags
 * @returns {string} XML-safe content
 */
function escapeXmlContent(str) {
  if (!str) return '';

  let out = '';
  let last = 0;

  for (const match of str.matchAll(INLINE_TAG_RE)) {
    out += escapeText(str.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  out += escapeText(str.slice(last));

  return out;
}

/**
 * Parses XML content collecting parser errors instead of logging them.
 * @param {string} content - XML content
 * @returns {{doc: Document|null, errors: string[]}}
 */
function parseXml(content) {
  const errors = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (msg) => errors.push(String(msg)),
      fatalError: (msg) => errors.push(String(msg)),
    },
  });

  let doc = null;
  try {
    doc = parser.parseFromString(content, 'application/xml');
  } catch (error) {
    errors.push(error.message);
  }

  return { doc, errors };
}

/**
 * Checks whether a fragment is well-formed XML by probing it inside a
 * wrapper document.
 * @param {string} xmlFragment - Fragment such as `<source>...</source>`
 * @returns {boolean}
 */
function isWellFormedXml(xmlFragment) {
  const { errors } = parseXml(`<?xml version="1.0"?><probe>${xmlFragment}</probe>`);
  return errors.length === 0;
}

/**
 * Checks that inline XLIFF tags inside a value are properly balanced
 * (xmldom is too lenient to detect unclosed elements on its own).
 * @param {string} str - Content possibly containing inline tags
 * @returns {boolean}
 */
function inlineTagsBalanced(str) {
  const stack = [];

  for (const match of str.matchAll(INLINE_TAG_RE)) {
    const tag = match[0];
    if (tag.endsWith('/>')) continue;

    const name = /^<\/?([a-z]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!name) return false;

    if (tag.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }

  return stack.length === 0;
}

/**
 * Serializes an element's content to a string, keeping inline XLIFF tags
 * as raw markup and decoding text nodes. Attribute values are re-escaped so
 * the serialized form is valid XML.
 * @param {Element} element - The XML element
 * @returns {string}
 */
function serializeElementContent(element) {
  if (!element) return '';

  let result = '';

  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];

    if (child.nodeType === 3) { // Text node (already decoded by the parser)
      result += child.nodeValue;
    } else if (child.nodeType === 1) { // Element node
      const tagName = child.tagName || child.localName;
      const attributes = [];

      if (child.attributes) {
        for (let j = 0; j < child.attributes.length; j++) {
          const attr = child.attributes[j];
          attributes.push(`${attr.name}="${escapeAttr(attr.value)}"`);
        }
      }

      const attrString = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
      const childContent = serializeElementContent(child);

      if (childContent === '') {
        result += `<${tagName}${attrString}/>`;
      } else {
        result += `<${tagName}${attrString}>${childContent}</${tagName}>`;
      }
    }
    // Skip comments and other node types
  }

  return result;
}

/**
 * Gets the first child element with the given tag name.
 */
function getChildElement(parent, tagName) {
  if (!parent) return null;

  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const childTagName = child.tagName || child.localName;
      if (childTagName === tagName) {
        return child;
      }
    }
  }
  return null;
}

/**
 * Gets all child elements with the given tag name.
 */
function getChildElements(parent, tagName) {
  const elements = [];
  if (!parent) return elements;

  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType === 1) {
      const childTagName = child.tagName || child.localName;
      if (childTagName === tagName) {
        elements.push(child);
      }
    }
  }
  return elements;
}

// ============================================================================
// XLF PARSING
// ============================================================================

/**
 * Parses XLF (XLIFF 1.2) content from a string.
 *
 * @param {string} content - XLF content
 * @returns {Array<{id: string, source: string, target: string, note: string, meaning: string}>}
 * @throws {Error} On invalid XML, unsupported XLIFF version, or no units
 */
export function parseXLFString(content) {
  if (!content || typeof content !== 'string') {
    throw new Error(`Invalid content: expected non-empty string, got ${typeof content}`);
  }

  const { doc, errors } = parseXml(content);

  if (errors.length > 0 || !doc || !doc.documentElement) {
    throw new Error(
      `Invalid XML in XLF content: ${errors[0] || 'document could not be parsed'}\n` +
      `Please ensure the file contains well-formed XML.`
    );
  }

  const root = doc.documentElement;
  const rootTag = root.tagName || root.localName;
  const version = root.getAttribute ? root.getAttribute('version') : '';

  if (root.namespaceURI === XLIFF2_NS || /^2\./.test(version || '')) {
    throw new Error(
      'XLIFF 2.0 files are not supported. Extract translations in XLIFF 1.2 ' +
      '(the Angular CLI default): ng extract-i18n --format xlf'
    );
  }

  if (rootTag !== 'xliff') {
    throw new Error(`Not an XLIFF document: root element is <${rootTag}>`);
  }

  const allTransUnits = doc.getElementsByTagName('trans-unit');
  const translationUnits = [];

  for (let i = 0; i < allTransUnits.length; i++) {
    const unit = allTransUnits[i];
    const id = unit.getAttribute ? unit.getAttribute('id') : null;

    if (!id) continue;

    const sourceElement = getChildElement(unit, 'source');
    const targetElement = getChildElement(unit, 'target');
    const meaningElement = getChildElement(unit, 'meaning');
    const noteElements = getChildElements(unit, 'note');

    translationUnits.push({
      id,
      source: sourceElement ? serializeElementContent(sourceElement) : '',
      target: targetElement ? serializeElementContent(targetElement) : '',
      meaning: meaningElement ? serializeElementContent(meaningElement) : '',
      note: noteElements.map(note => serializeElementContent(note)).join('\n'),
    });
  }

  if (translationUnits.length === 0) {
    throw new Error(
      'No translation units (<trans-unit>) found in the XLF file. ' +
      'Verify that the file was generated by ng extract-i18n and is not empty.'
    );
  }

  return translationUnits;
}

// ============================================================================
// XLF GENERATION
// ============================================================================

/**
 * Generates an XLF 1.2 file from translation units.
 *
 * Text content is XML-escaped; inline XLIFF tags present in the values are
 * preserved as markup. Units whose content would produce malformed XML fall
 * back to fully escaped text and are reported in `issues`.
 *
 * @param {Array} translations - Translation objects (id, source, target, note, meaning)
 * @param {string} targetLanguage - Target language code (e.g. 'es')
 * @param {string} outputPath - Output file path
 * @param {Object} options - Options
 * @param {string} options.sourceLanguage - Source language code (default 'en')
 * @param {string} options.original - Original document name (default 'messages')
 * @returns {{path: string, issues: string[]}} Absolute output path and issues found
 * @throws {Error} If validation or writing fails
 */
export function generateXLF(translations, targetLanguage, outputPath, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';

  if (!Array.isArray(translations)) {
    throw new Error(`Invalid translations parameter: expected array, got ${typeof translations}`);
  }
  if (!targetLanguage || typeof targetLanguage !== 'string') {
    throw new Error(`Invalid target language: ${targetLanguage}`);
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error(`Invalid output path: ${outputPath}`);
  }

  const issues = [];
  let fallbackCount = 0;
  let sourceFallbackCount = 0;

  let xliff = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xliff += `<xliff version="1.2" xmlns="${XLIFF12_NS}">\n`;
  xliff += `  <file source-language="${escapeAttr(sourceLanguage)}" target-language="${escapeAttr(targetLanguage)}" original="${escapeAttr(original)}">\n`;
  xliff += `    <body>\n`;

  for (const trans of translations) {
    if (!trans.id) {
      issues.push('Skipped translation unit without id');
      continue;
    }

    const id = escapeAttr(trans.id);
    const source = renderContent(trans.source || '', trans.id, 'source');
    const hasTarget = Boolean(trans.target);
    const target = hasTarget
      ? renderContent(trans.target, trans.id, 'target')
      : source;
    const meaning = renderContent(trans.meaning || '', trans.id, 'meaning');
    const note = renderContent(trans.note || '', trans.id, 'note');

    if (!hasTarget) {
      sourceFallbackCount++;
    }

    xliff += `      <trans-unit id="${id}">\n`;
    if (meaning) {
      xliff += `        <meaning>${meaning}</meaning>\n`;
    }
    xliff += `        <source>${source}</source>\n`;
    xliff += `        <target>${target}</target>\n`;
    if (note) {
      xliff += `        <note>${note}</note>\n`;
    }
    xliff += `      </trans-unit>\n`;
  }

  xliff += `    </body>\n`;
  xliff += `  </file>\n`;
  xliff += `</xliff>`;

  if (fallbackCount > 0) {
    issues.push(
      `${fallbackCount} unit(s) contained malformed inline markup and were fully escaped ` +
      `(placeholders may appear as literal text). Review the translations.`
    );
  }
  if (sourceFallbackCount > 0) {
    issues.push(
      `${sourceFallbackCount} unit(s) had no translation; <target> was filled with the source text.`
    );
  }

  const absolutePath = resolve(outputPath);
  try {
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(absolutePath, xliff, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write XLF file: ${error.message}`);
  }

  return { path: absolutePath, issues };

  /**
   * Renders a field value keeping inline tags intact. Falls back to fully
   * escaped text when the result would be malformed XML.
   */
  function renderContent(value, unitId, field) {
    if (!value) return '';

    if (inlineTagsBalanced(value)) {
      const preserved = escapeXmlContent(value);
      if (isWellFormedXml(`<${field}>${preserved}</${field}>`)) {
        return preserved;
      }
    }

    fallbackCount++;
    issues.push(`Unit "${unitId}": malformed inline markup in ${field}; content was fully escaped`);
    return escapeText(value);
  }
}

// ============================================================================
// XLF <-> CSV CONVERSION
// ============================================================================

/**
 * Converts an XLF file to a CSV file with one column per target language.
 *
 * Target language columns are seeded with the source text so the CSV stays
 * self-describing; run `validate` after translating to detect rows that were
 * never translated (translation identical to source).
 *
 * @param {string} xlfFilePath - Path to the source XLF file
 * @param {string} csvOutputPath - Path for the output CSV file
 * @param {string[]} targetLanguages - Target language codes (e.g. ['es', 'fr'])
 * @param {Object} options - Options
 * @param {string} options.sourceLanguage - Source language code (default 'en')
 * @returns {string} Output CSV path
 * @throws {Error} If the file does not exist or conversion fails
 */
export function xlfToCsv(xlfFilePath, csvOutputPath, targetLanguages, options = {}) {
  if (!xlfFilePath || typeof xlfFilePath !== 'string') {
    throw new Error(`Invalid XLF file path: ${xlfFilePath}`);
  }
  if (!csvOutputPath || typeof csvOutputPath !== 'string') {
    throw new Error(`Invalid CSV output path: ${csvOutputPath}`);
  }
  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    throw new Error(`Invalid target languages: ${targetLanguages}`);
  }

  if (!existsSync(xlfFilePath)) {
    throw new Error(`XLF file not found: ${xlfFilePath}`);
  }

  let xlfContent;
  try {
    xlfContent = readFileSync(xlfFilePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read XLF file: ${error.message}`);
  }

  const translationUnits = parseXLFString(xlfContent);

  const columns = ['id', 'source', 'note', 'meaning', ...targetLanguages];
  const csvData = translationUnits.map(unit => {
    const row = {
      id: unit.id || '',
      source: unit.source || '',
      note: unit.note || '',
      meaning: unit.meaning || '',
    };
    for (const lang of targetLanguages) {
      row[lang] = unit.source || '';
    }
    return row;
  });

  try {
    const csvOutput = csvStringifySync(csvData, {
      columns,
      header: true,
      quoted_string: true,
    });

    const outputDir = dirname(resolve(csvOutputPath));
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(csvOutputPath, csvOutput, 'utf-8');
    return csvOutputPath;
  } catch (error) {
    throw new Error(`Failed to write CSV file: ${error.message}`);
  }
}

/**
 * Converts a translated CSV back to one XLF file per language.
 *
 * @param {string} csvFilePath - Path to the translated CSV file
 * @param {string} outputDir - Output directory for XLF files
 * @param {string[]} languages - Target language codes
 * @param {Object} options - Options
 * @param {string} options.sourceLanguage - Source language code (default 'en')
 * @param {string} options.original - Original document name (default 'messages')
 * @param {Object<string, string>} options.fileNames - Optional map of language
 *   code to output file name (defaults to `<original>.<lang>.xlf`)
 * @returns {{files: Object<string, string>, issues: string[]}}
 * @throws {Error} If the CSV file does not exist or conversion fails
 */
export function csvToXlf(csvFilePath, outputDir, languages, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';
  const fileNames = options.fileNames || {};

  if (!csvFilePath || typeof csvFilePath !== 'string') {
    throw new Error(`Invalid CSV file path: ${csvFilePath}`);
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error(`Invalid output directory: ${outputDir}`);
  }
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error(`Invalid languages array: ${languages}`);
  }

  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  let csvContent;
  try {
    csvContent = readFileSync(csvFilePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read CSV file: ${error.message}`);
  }

  let csvData;
  try {
    csvData = csvParseSync(csvContent, {
      columns: true,
      skip_empty_lines: true,
    });
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }

  const resolvedOutputDir = resolve(outputDir);
  if (!existsSync(resolvedOutputDir)) {
    mkdirSync(resolvedOutputDir, { recursive: true });
  }

  const files = {};
  const issues = [];

  for (const lang of languages) {
    const translations = csvData
      .map(row => ({
        id: row.id || '',
        source: row.source || '',
        target: row[lang] || '',
        note: row.note || '',
        meaning: row.meaning || '',
      }))
      .filter(trans => trans.id);

    const fileName = fileNames[lang] || `${original}.${lang}.xlf`;
    const outputPath = resolve(resolvedOutputDir, fileName);

    try {
      const { path, issues: unitIssues } = generateXLF(translations, lang, outputPath, {
        sourceLanguage,
        original,
      });
      files[lang] = path;
      issues.push(...unitIssues.map(issue => `[${lang}] ${issue}`));
    } catch (error) {
      throw new Error(`Failed to generate XLF for language ${lang}: ${error.message}`);
    }
  }

  return { files, issues };
}

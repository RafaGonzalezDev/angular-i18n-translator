import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'csv-stringify/sync';
import { CONTENT_FORMAT, FORMAT_COLUMN, parseCsvRecords, assertUniqueIds } from './csv-records.js';
import { parseXmlDocument, parseMessageContent, serializeContent, escapeText, escapeAttribute, validateMessage, isMissingTranslation } from './message-content.js';
import { validateRecords } from './validator.js';
import { registerArtifacts, readArtifactManifest } from './artifacts.js';
import { resolveSafeOutputPath, assertSafeDirectory } from './paths.js';

const XLIFF12_NS = 'urn:oasis:names:tc:xliff:document:1.2';
const XLIFF2_NS = 'urn:oasis:names:tc:xliff:document:2.0';

function childElements(parent, name) {
  return Array.from(parent?.childNodes || []).filter(node => node.nodeType === 1 && node.localName === name);
}

export function parseXLFString(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Invalid XML: expected non-empty XLF content');
  const doc = parseXmlDocument(content);
  const root = doc.documentElement;
  const version = root.getAttribute('version');
  if (root.namespaceURI === XLIFF2_NS || /^2\./.test(version)) throw new Error('XLIFF 2.0 files are not supported. Use ng extract-i18n --format xlf');
  if (root.localName !== 'xliff' || version !== '1.2' || (root.namespaceURI && root.namespaceURI !== XLIFF12_NS)) throw new Error('Expected an XLIFF 1.2 document');
  const units = Array.from(doc.getElementsByTagNameNS('*', 'trans-unit')).map(unit => {
    const source = childElements(unit, 'source');
    if (source.length !== 1) throw new Error(`Unit "${unit.getAttribute('id')}": expected exactly one source`);
    const target = childElements(unit, 'target');
    if (target.length > 1) throw new Error('Duplicate target element');
    const notes = childElements(unit, 'note');
    const meanings = notes.filter(note => note.getAttribute('from') === 'meaning');
    const descriptions = notes.filter(note => note.getAttribute('from') !== 'meaning');
    const result = {
      id: unit.getAttribute('id') || '',
      source: serializeContent(source[0]),
      target: target[0] ? serializeContent(target[0]) : '',
      note: descriptions.map(note => note.textContent).join('\n'),
      meaning: [...meanings, ...childElements(unit, 'meaning')].map(note => note.textContent).join('\n'),
    };
    const sourceIssues = validateMessage(result.source, result.source);
    if (sourceIssues.length) throw new Error(`Unit "${result.id}": ${sourceIssues.join('; ')}`);
    return result;
  });
  if (!units.length) throw new Error('No translation units (<trans-unit>) found in the XLF file');
  assertUniqueIds(units);
  return units;
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = resolve(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    // This exact absolute temporary path was created by this operation only.
    if (existsSync(temporary)) rmSync(temporary);
    throw error;
  }
}

function renderXlf(translations, targetLanguage, options) {
  if (!Array.isArray(translations) || !translations.length) throw new Error('No translation units to export');
  assertUniqueIds(translations);
  const rendered = translations.map(unit => {
    const source = unit.source || '';
    const target = unit.target || '';
    if (isMissingTranslation(source, target)) throw new Error(`Unit "${unit.id}": missing translation; source fallback is not allowed`);
    const errors = validateMessage(source, target);
    if (errors.length) throw new Error(`Unit "${unit.id}": ${errors.join('; ')}`);
    // Re-serialization normalizes entities without turning literal text into tags.
    const sourceXml = serializeContent(parseMessageContent(source));
    const targetXml = serializeContent(parseMessageContent(target));
    const notes = `${unit.meaning ? `        <note from="meaning">${escapeText(unit.meaning)}</note>\n` : ''}${unit.note ? `        <note from="description">${escapeText(unit.note)}</note>\n` : ''}`;
    return `      <trans-unit id="${escapeAttribute(unit.id)}">\n        <source>${sourceXml}</source>\n        <target>${targetXml}</target>\n${notes}      </trans-unit>`;
  });
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="${XLIFF12_NS}">\n  <file source-language="${escapeAttribute(options.sourceLanguage || 'en')}" target-language="${escapeAttribute(targetLanguage)}" datatype="plaintext" original="${escapeAttribute(options.original || 'messages')}">\n    <body>\n${rendered.join('\n')}\n    </body>\n  </file>\n</xliff>\n`;
  parseXmlDocument(content);
  return content;
}

export function generateXLF(translations, targetLanguage, outputPath, options = {}) {
  if (!targetLanguage || typeof outputPath !== 'string') throw new Error('Target language and output path are required');
  const projectRoot = options.projectRoot || dirname(resolve(outputPath));
  const protectedPaths = [options.sourceFile, options.configFile].filter(Boolean);
  const path = resolveSafeOutputPath(outputPath, { projectRoot, protectedPaths });
  const content = renderXlf(translations, targetLanguage, options);
  readArtifactManifest({ projectRoot, protectedPaths });
  registerArtifacts([path], { projectRoot, protectedPaths });
  atomicWrite(path, content);
  return { path, issues: [] };
}

export function xlfToCsv(xlfFilePath, csvOutputPath, targetLanguages, options = {}) {
  if (!Array.isArray(targetLanguages) || !targetLanguages.length) throw new Error('Target languages are required');
  if (new Set(targetLanguages).size !== targetLanguages.length || targetLanguages.some(lang => ['id', 'source', 'note', 'meaning', FORMAT_COLUMN].includes(lang))) throw new Error('Invalid or duplicate target languages');
  const projectRoot = options.projectRoot || dirname(resolve(csvOutputPath));
  const protectedPaths = [resolve(xlfFilePath), options.configFile].filter(Boolean);
  const path = resolveSafeOutputPath(csvOutputPath, { projectRoot, protectedPaths });
  const units = parseXLFString(readFileSync(xlfFilePath, 'utf8'));
  const columns = ['id', 'source', 'note', 'meaning', FORMAT_COLUMN, ...targetLanguages];
  const records = units.map(unit => ({
    id: unit.id, source: unit.source, note: unit.note, meaning: unit.meaning,
    [FORMAT_COLUMN]: CONTENT_FORMAT,
    ...Object.fromEntries(targetLanguages.map(lang => [lang, unit.source])),
  }));
  const content = stringify(records, { header: true, columns, quoted_string: true });
  readArtifactManifest({ projectRoot, protectedPaths });
  registerArtifacts([path], { projectRoot, protectedPaths });
  atomicWrite(path, content);
  return path;
}

export function csvToXlf(csvFilePath, outputDir, languages, options = {}) {
  if (!Array.isArray(languages) || !languages.length) throw new Error('Target languages are required');
  const parsed = parseCsvRecords(readFileSync(csvFilePath, 'utf8'), { requireFormat: true });
  const report = validateRecords(parsed.records, languages, { ...parsed, strict: options.strict });
  if (!report.summary.allValid) throw new Error(report.issues.filter(issue => issue.severity === 'error' || options.strict).map(issue => `${issue.language}/${issue.id}:${issue.line} ${issue.issue}`).join('\n'));
  const projectRoot = options.projectRoot || dirname(resolve(csvFilePath));
  const protectedPaths = [options.sourceFile, options.configFile].filter(Boolean);
  const inputProtection = [resolve(csvFilePath), ...protectedPaths];
  const directory = assertSafeDirectory(outputDir, { projectRoot, protectedPaths: inputProtection });
  const plans = languages.map(language => {
    const fileName = options.fileNames?.[language] || `${options.original || 'messages'}.${language}.xlf`;
    if (basename(fileName) !== fileName || !/\.xlf$/i.test(fileName)) throw new Error(`Unsafe XLF file name: ${fileName}`);
    const path = resolveSafeOutputPath(resolve(directory, fileName), { projectRoot, protectedPaths: inputProtection });
    const units = parsed.records.map(row => ({ id: row.id, source: row.source, target: row[language], note: row.note || '', meaning: row.meaning || '' }));
    return { language, path, content: renderXlf(units, language, options) };
  });
  if (new Set(plans.map(plan => plan.path.toLowerCase())).size !== plans.length) throw new Error('Duplicate output paths');
  readArtifactManifest({ projectRoot, protectedPaths });
  registerArtifacts(plans.map(plan => plan.path), { projectRoot, protectedPaths });
  for (const plan of plans) atomicWrite(plan.path, plan.content);
  return {
    files: Object.fromEntries(plans.map(plan => [plan.language, plan.path])),
    issues: report.issues.filter(issue => issue.severity === 'warning').map(issue => `${issue.language}/${issue.id}:${issue.line} ${issue.issue}`),
  };
}

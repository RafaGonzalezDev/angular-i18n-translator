import { parse as csvParseSync } from 'csv-parse/sync';
import { stringify as csvStringifySync } from 'csv-stringify/sync';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { DOMParser } from '@xmldom/xmldom';

// XLIFF namespace
const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:1.2';

/**
 * Converts an XLF file to CSV format with multiple language columns
 * @param {string} xlfFilePath - Path to the source XLF file
 * @param {string} csvOutputPath - Path for the output CSV file
 * @param {string[]} targetLanguages - Array of target language codes (e.g., ['es', 'fr'])
 * @param {Object} options - Optional configuration
 * @param {string} options.sourceLanguage - Source language code (default: 'en')
 * @throws {Error} If file doesn't exist or conversion fails
 */
export function xlfToCsv(xlfFilePath, csvOutputPath, targetLanguages, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';

  // Validate inputs
  if (!xlfFilePath || typeof xlfFilePath !== 'string') {
    throw new Error(
      `Invalid XLF file path: ${xlfFilePath}\n` +
      `Please provide a valid file path.`
    );
  }

  if (!csvOutputPath || typeof csvOutputPath !== 'string') {
    throw new Error(
      `Invalid CSV output path: ${csvOutputPath}\n` +
      `Please provide a valid output file path.`
    );
  }

  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    throw new Error(
      `Invalid target languages: ${targetLanguages}\n` +
      `Please provide an array of target language codes (e.g., ['es', 'fr']).`
    );
  }

  // Read and parse XLF file
  if (!existsSync(xlfFilePath)) {
    throw new Error(`XLF file not found: ${xlfFilePath}`);
  }

  let xlfContent;
  try {
    xlfContent = readFileSync(xlfFilePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read XLF file: ${error.message}`);
  }

  // Parse XLF content
  const translationUnits = parseXLFString(xlfContent);

  // Build CSV data
  const columns = ['id', 'source', 'note', 'meaning', ...targetLanguages];
  const csvData = translationUnits.map(unit => {
    const row = {
      id: unit.id || '',
      source: unit.source || '',
      note: unit.note || '',
      meaning: unit.meaning || ''
    };

    // Add target language columns with source as placeholder
    // This provides context to the LLM during translation
    for (const lang of targetLanguages) {
      row[lang] = unit.source || '';
    }

    return row;
  });

  // Stringify to CSV
  try {
    const csvOutput = csvStringifySync(csvData, {
      columns: columns,
      header: true,
      quoted_string: true
    });

    // Ensure output directory exists
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
 * Converts CSV back to individual XLF files per language
 * @param {string} csvFilePath - Path to the CSV file
 * @param {string} outputDir - Output directory for XLF files
 * @param {string[]} languages - Array of target language codes (e.g., ['es', 'fr'])
 * @param {Object} options - Optional configuration
 * @param {string} options.sourceLanguage - Source language code (default: 'en')
 * @param {string} options.original - Original file name (default: 'messages')
 * @returns {Object} Object with language codes as keys and file paths as values
 * @throws {Error} If CSV file doesn't exist or conversion fails
 */
export function csvToXlf(csvFilePath, outputDir, languages, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';

  // Validate inputs
  if (!csvFilePath || typeof csvFilePath !== 'string') {
    throw new Error(
      `Invalid CSV file path: ${csvFilePath}\n` +
      `Please provide a valid file path.`
    );
  }

  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error(
      `Invalid output directory: ${outputDir}\n` +
      `Please provide a valid output directory path.`
    );
  }

  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error(
      `Invalid languages array: ${languages}\n` +
      `Please provide an array of language codes (e.g., ['es', 'fr']).`
    );
  }

  // Read CSV file
  if (!existsSync(csvFilePath)) {
    throw new Error(`CSV file not found: ${csvFilePath}`);
  }

  let csvContent;
  try {
    csvContent = readFileSync(csvFilePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read CSV file: ${error.message}`);
  }

  // Parse CSV
  let csvData;
  try {
    csvData = csvParseSync(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }

  // Create output directory if it doesn't exist
  const resolvedOutputDir = resolve(outputDir);
  if (!existsSync(resolvedOutputDir)) {
    mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // Generate XLF file for each language
  const generatedFiles = {};

  for (const lang of languages) {
    const translations = csvData.map(row => ({
      id: row.id || '',
      source: row.source || '',
      target: row[lang] || '', // Get translation for this language
      note: row.note || '',
      meaning: row.meaning || ''
    })).filter(trans => trans.id); // Filter out rows without id

    const outputPath = resolve(resolvedOutputDir, `${original}.${lang}.xlf`);
    
    try {
      generateXLF(translations, lang, outputPath, {
        sourceLanguage,
        original
      });
      generatedFiles[lang] = outputPath;
    } catch (error) {
      throw new Error(`Failed to generate XLF for language ${lang}: ${error.message}`);
    }
  }

  return generatedFiles;
}

/**
 * Parses XLF content from string (standalone function for this module)
 * @param {string} content - XLF content as string
 * @returns {Array} Array of translation units
 */
function parseXLFString(content) {
  if (!content || typeof content !== 'string') {
    throw new Error(`Invalid content: expected non-empty string, got ${typeof content}`);
  }

  let doc;
  try {
    const parser = new DOMParser({
      errorHandler: {
        warning: (msg) => console.warn(`XML Warning: ${msg}`),
        error: (msg) => console.error(`XML Error: ${msg}`),
        fatalError: (msg) => console.error(`XML Fatal Error: ${msg}`)
      }
    });
    doc = parser.parseFromString(content, 'application/xml');
  } catch (error) {
    throw new Error(`Failed to parse XLF XML: ${error.message}`);
  }

  // Check for parsing errors
  const parserError = doc.getElementsByTagName('parsererror');
  if (parserError && parserError.length > 0) {
    throw new Error(`XML parsing error: ${parserError[0].textContent}`);
  }

  // Extract translation units
  const translationUnits = [];
  const allTransUnits = doc.getElementsByTagName('trans-unit');

  for (let i = 0; i < allTransUnits.length; i++) {
    const unit = allTransUnits[i];
    const id = unit.getAttribute ? unit.getAttribute('id') : null;
    
    if (!id) continue;

    const source = extractTextContent(getChildElement(unit, 'source'));
    const target = extractTextContent(getChildElement(unit, 'target'));
    const meaning = extractTextContent(getChildElement(unit, 'meaning'));
    const noteElements = getChildElements(unit, 'note');
    const notes = noteElements.map(note => extractTextContent(note));
    const note = notes.join('\n');

    translationUnits.push({
      id,
      source,
      target,
      note,
      meaning
    });
  }

  return translationUnits;
}

/**
 * Extracts text content from an element, preserving XML structure
 * @param {Element} element - The XML element
 * @returns {string} - The text content with preserved structure
 */
function extractTextContent(element) {
  if (!element) return '';
  
  let result = '';
  
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    
    if (child.nodeType === 3) { // Text node
      result += child.nodeValue;
    } else if (child.nodeType === 1) { // Element node
      const tagName = child.tagName || child.localName;
      const attributes = [];
      
      if (child.attributes) {
        for (let j = 0; j < child.attributes.length; j++) {
          const attr = child.attributes[j];
          attributes.push(`${attr.name}="${attr.value}"`);
        }
      }
      
      const attrString = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
      const childContent = extractTextContent(child);
      
      // Self-closing tags for placeholders
      if (childContent === '' && (tagName === 'x' || tagName === 'g' || tagName === 'bx' || tagName === 'ex')) {
        result += `<${tagName}${attrString}/>`;
      } else {
        result += `<${tagName}${attrString}>${childContent}</${tagName}>`;
      }
    }
  }
  
  return result;
}

/**
 * Gets a child element by tag name
 * @param {Element} parent - Parent element
 * @param {string} tagName - Tag name to search for
 * @returns {Element|null} - Found element or null
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
 * Gets all child elements by tag name
 * @param {Element} parent - Parent element
 * @param {string} tagName - Tag name to search for
 * @returns {Element[]} - Array of found elements
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

/**
 * Generates an XLF file from translation units
 * @param {Array} translations - Array of translation objects with id, source, target, note, meaning
 * @param {string} targetLanguage - Target language code (e.g., 'es', 'fr')
 * @param {string} outputPath - Output file path
 * @param {Object} options - Optional configuration
 * @param {string} options.sourceLanguage - Source language code (default: 'en')
 * @param {string} options.original - Original file name (default: 'messages')
 * @throws {Error} If validation fails or file write fails
 */
function generateXLF(translations, targetLanguage, outputPath, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';

  // Validate inputs
  if (!Array.isArray(translations)) {
    throw new Error(`Invalid translations parameter: expected array, got ${typeof translations}`);
  }

  if (!targetLanguage || typeof targetLanguage !== 'string') {
    throw new Error(`Invalid target language: ${targetLanguage}`);
  }

  // Generate XML
  let xliff = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xliff += `<xliff version="1.2" xmlns="${XLIFF_NS}">\n`;
  xliff += `  <file source-language="${sourceLanguage}" target-language="${targetLanguage}" original="${original}">\n`;
  xliff += `    <body>\n`;

  for (const trans of translations) {
    if (!trans.id) {
      console.warn(`Warning: Skipping translation unit without id`);
      continue;
    }

    const id = escapeXml(trans.id);
    const source = escapeXml(trans.source || '');
    const target = escapeXml(trans.target || trans.source || '');
    const meaning = escapeXml(trans.meaning || '');
    const note = escapeXml(trans.note || '');

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

  // Write to file
  const absolutePath = resolve(outputPath);
  try {
    // Ensure directory exists
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(absolutePath, xliff, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write XLF file: ${error.message}`);
  }

  return absolutePath;
}

/**
 * Escapes special XML characters
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

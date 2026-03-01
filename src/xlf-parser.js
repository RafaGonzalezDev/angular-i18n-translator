import { DOMParser } from '@xmldom/xmldom';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// XLIFF namespace
const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:1.2';

/**
 * Extracts text content from an element, preserving XML structure
 * @param {Element} element - The XML element
 * @returns {string} - The text content with preserved structure
 */
function extractElementContent(element) {
  if (!element) return '';
  
  let result = '';
  
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    
    if (child.nodeType === 3) { // Text node
      result += child.nodeValue;
    } else if (child.nodeType === 1) { // Element node
      // Preserve XML elements like <x/>, <g/>, <bx/>, <ex/>, etc.
      const tagName = child.tagName || child.localName;
      const attributes = [];
      
      if (child.attributes) {
        for (let j = 0; j < child.attributes.length; j++) {
          const attr = child.attributes[j];
          attributes.push(`${attr.name}="${attr.value}"`);
        }
      }
      
      const attrString = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
      const childContent = extractElementContent(child);
      
      // Self-closing tags for placeholders
      if (childContent === '' && (tagName === 'x' || tagName === 'g' || tagName === 'bx' || tagName === 'ex')) {
        result += `<${tagName}${attrString}/>`;
      } else {
        result += `<${tagName}${attrString}>${childContent}</${tagName}>`;
      }
    }
    // Skip comment nodes (nodeType 8) and others
  }
  
  return result;
}

/**
 * Gets an element by local name within a namespace-aware manner
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
 * Gets all child elements by local name
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
 * Parses an XLF file and extracts translation units
 * @param {string} filePath - Path to the XLF file
 * @returns {Array} Array of translation units with id, source, target, note, meaning
 * @throws {Error} If file doesn't exist or parsing fails
 */
export function parseXLF(filePath) {
  // Check if file exists
  if (!existsSync(filePath)) {
    throw new Error(
      `XLF file not found: ${filePath}\n` +
      `Please verify the file path is correct and the file exists.`
    );
  }

  // Read file content
  let fileContent;
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read XLF file: ${error.message}\n` +
      `File: ${filePath}`
    );
  }

  // Parse XML
  let doc;
  try {
    const parser = new DOMParser({
      errorHandler: {
        warning: (msg) => console.warn(`XML Warning: ${msg}`),
        error: (msg) => console.error(`XML Error: ${msg}`),
        fatalError: (msg) => console.error(`XML Fatal Error: ${msg}`)
      }
    });
    doc = parser.parseFromString(fileContent, 'application/xml');
  } catch (error) {
    throw new Error(
      `Failed to parse XLF XML: ${error.message}\n` +
      `File: ${filePath}\n` +
      `Please ensure the file contains valid XML.`
    );
  }

  // Check for parsing errors
  const parserError = doc.getElementsByTagName('parsererror');
  if (parserError && parserError.length > 0) {
    throw new Error(
      `XML parsing error in ${filePath}:\n${parserError[0].textContent}`
    );
  }

  // Extract translation units
  const translationUnits = [];

  // Find all trans-unit elements (handle namespace)
  const transUnits = getChildElements(doc.documentElement, 'trans-unit');
  
  // Also try without namespace if not found
  const transUnitsAlt = doc.getElementsByTagName('trans-unit');
  const allTransUnits = transUnits.length > 0 ? transUnits : transUnitsAlt;

  for (let i = 0; i < allTransUnits.length; i++) {
    const unit = allTransUnits[i];
    
    // Get id attribute
    const id = unit.getAttribute ? unit.getAttribute('id') : null;
    
    if (!id) {
      console.warn(`Warning: Found trans-unit without id attribute, skipping`);
      continue;
    }

    // Extract source
    const sourceElement = getChildElement(unit, 'source');
    const source = sourceElement ? extractElementContent(sourceElement) : '';

    // Extract target
    const targetElement = getChildElement(unit, 'target');
    const target = targetElement ? extractElementContent(targetElement) : '';

    // Extract meaning (context)
    const meaningElement = getChildElement(unit, 'meaning');
    const meaning = meaningElement ? extractElementContent(meaningElement) : '';

    // Extract notes (can be multiple)
    const noteElements = getChildElements(unit, 'note');
    const notes = noteElements.map(note => extractElementContent(note));
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
 * Generates an XLF file from translation units
 * @param {Array} translations - Array of translation objects with id, source, target, note, meaning
 * @param {string} targetLanguage - Target language code (e.g., 'es', 'fr')
 * @param {string} outputPath - Output file path
 * @param {Object} options - Optional configuration
 * @param {string} options.sourceLanguage - Source language code (default: 'en')
 * @param {string} options.original - Original file name (default: 'messages')
 * @throws {Error} If validation fails or file write fails
 */
export function generateXLF(translations, targetLanguage, outputPath, options = {}) {
  const sourceLanguage = options.sourceLanguage || 'en';
  const original = options.original || 'messages';

  // Validate inputs
  if (!Array.isArray(translations)) {
    throw new Error(
      `Invalid translations parameter: expected array, got ${typeof translations}\n` +
      `Please provide an array of translation objects.`
    );
  }

  if (!targetLanguage || typeof targetLanguage !== 'string') {
    throw new Error(
      `Invalid target language: ${targetLanguage}\n` +
      `Please provide a valid target language code (e.g., 'es', 'fr').`
    );
  }

  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error(
      `Invalid output path: ${outputPath}\n` +
      `Please provide a valid output file path.`
    );
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
    writeFileSync(absolutePath, xliff, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to write XLF file: ${error.message}\n` +
      `Output path: ${outputPath}\n` +
      `Please check file permissions and path.`
    );
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

/**
 * Parses XLF from string content (useful for testing or in-memory XLF)
 * @param {string} content - XLF content as string
 * @returns {Array} Array of translation units
 */
export function parseXLFString(content) {
  if (!content || typeof content !== 'string') {
    throw new Error(
      `Invalid content: expected non-empty string, got ${typeof content}\n` +
      `Please provide valid XLF content as a string.`
    );
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
    throw new Error(
      `Failed to parse XLF XML: ${error.message}\n` +
      `Please ensure the content contains valid XML.`
    );
  }

  // Check for parsing errors
  const parserError = doc.getElementsByTagName('parsererror');
  if (parserError && parserError.length > 0) {
    throw new Error(
      `XML parsing error:\n${parserError[0].textContent}`
    );
  }

  // Extract translation units
  const translationUnits = [];
  const transUnits = getChildElements(doc.documentElement, 'trans-unit');
  const transUnitsAlt = doc.getElementsByTagName('trans-unit');
  const allTransUnits = transUnits.length > 0 ? transUnits : transUnitsAlt;

  for (let i = 0; i < allTransUnits.length; i++) {
    const unit = allTransUnits[i];
    const id = unit.getAttribute ? unit.getAttribute('id') : null;
    
    if (!id) continue;

    const sourceElement = getChildElement(unit, 'source');
    const source = sourceElement ? extractElementContent(sourceElement) : '';

    const targetElement = getChildElement(unit, 'target');
    const target = targetElement ? extractElementContent(targetElement) : '';

    const meaningElement = getChildElement(unit, 'meaning');
    const meaning = meaningElement ? extractElementContent(meaningElement) : '';

    const noteElements = getChildElements(unit, 'note');
    const notes = noteElements.map(note => extractElementContent(note));
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

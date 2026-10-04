import { parse } from 'csv-parse/sync';

export const CONTENT_FORMAT = 'xliff-fragment-v1';
export const FORMAT_COLUMN = '__content_format';

/** Parse once, preserving content and physical record positions. */
export function parseCsvRecords(content, { requiredColumns = ['id', 'source'], requireFormat = false } = {}) {
  let columns = [];
  const parsed = parse(content, {
    bom: true,
    skip_empty_lines: true,
    raw: true,
    info: true,
    columns(headers) {
      columns = headers;
      if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
        throw new Error('CSV headers must be non-empty and unique');
      }
      return headers;
    },
  });
  const missing = requiredColumns.filter(column => !columns.includes(column));
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}`);
  if (requireFormat && !columns.includes(FORMAT_COLUMN)) {
    throw new Error('Legacy CSV format is ambiguous. Preserve this file, regenerate CSV from the original XLF and reapply reviewed translations.');
  }
  const records = parsed.map(entry => entry.record);
  const lines = parsed.map(({ raw, info }) => {
    const newlines = (raw.match(/\r\n|\r|\n/g) || []).length;
    const trailing = /(?:\r\n|\r|\n)$/.test(raw) ? 1 : 0;
    const leading = /^(?:(?:\r\n|\r|\n))*/.exec(raw)[0];
    return info.lines - newlines + trailing + (leading.match(/\r\n|\r|\n/g) || []).length;
  });
  if (requireFormat && records.some(row => row[FORMAT_COLUMN] !== CONTENT_FORMAT)) {
    throw new Error(`Unknown or mixed CSV content format; expected ${CONTENT_FORMAT}`);
  }
  return { records, columns, lines };
}

export function assertUniqueIds(records, lines = []) {
  const seen = new Map();
  records.forEach((row, index) => {
    const line = lines[index] || index + 2;
    if (typeof row.id !== 'string' || !row.id.trim()) throw new Error(`Missing id at line ${line}`);
    if (seen.has(row.id)) throw new Error(`Duplicate id "${row.id}" at lines ${seen.get(row.id)} and ${line}`);
    seen.set(row.id, line);
  });
}

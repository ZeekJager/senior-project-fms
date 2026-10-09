import { validationFailed } from '../errors/app-error';

/**
 * Parses CSV text (RFC 4180) into records of fields: comma-separated, fields
 * in double quotes may contain commas, line breaks and doubled quotes ("").
 * Accepts CRLF or LF line endings and a leading byte-order mark (spreadsheet
 * exports). Blank lines are skipped. An unterminated quote is a 400.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += c;
    }
  }
  if (quoted) throw validationFailed([{ field: 'body', reason: 'unterminated_quote' }], 'The CSV has a quoted field that is never closed.');
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

// A report as a PDF (FMS-91, docs/reports.md): a title, a line about what it covers, and a table that runs over as
// many landscape A4 pages as it needs, its header repeated on each, a totals row at the end and page numbers below.
// Written by hand rather than with a library: the standard Helvetica fonts every PDF reader has (no fonts to embed),
// Windows-1252 text (other characters become "?"), and uncompressed content, which is all a table needs.

export interface PdfTable {
  title: string;
  /** Under the title: depot, month, when it was made and how current the data is. */
  subtitle: string;
  columns: readonly { label: string; align: 'left' | 'right' }[];
  /** Cells as text, already formatted. */
  rows: readonly (readonly string[])[];
  totals: readonly string[] | null;
  /** Bottom left of every page. */
  footer: string;
}

const PAGE_W = 842; // A4 landscape, points
const PAGE_H = 595;
const MARGIN = 36;
const FONT_SIZE = 8;
const ROW_H = 15;
const PAD = 4;
const TITLE_SIZE = 16;
const TABLE_TOP = PAGE_H - MARGIN - 52;
const TABLE_BOTTOM = MARGIN + 22;
/** Rows below the header on one page. */
export const ROWS_PER_PAGE = Math.floor((TABLE_TOP - TABLE_BOTTOM) / ROW_H) - 1;

// Advance widths (1/1000 em) of ASCII 32..126, from the Adobe metrics of the standard fonts.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters outside Latin-1 that Windows-1252 has, and their bytes. */
const CP1252: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

/** The text as Windows-1252 bytes; a character it lacks becomes "?". */
export function encodeText(text: string): number[] {
  return [...text].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) return code;
    if (code >= 0xa0 && code <= 0xff) return code;
    return CP1252[ch] ?? 0x3f;
  });
}

function charWidth(byte: number, bold: boolean): number {
  if (byte >= 32 && byte <= 126) return (bold ? HELVETICA_BOLD : HELVETICA)[byte - 32];
  if (byte === 0x85 || byte === 0x97) return 1000;
  if (byte === 0x91 || byte === 0x92) return bold ? 278 : 222;
  return 556;
}

/** Width in points of the text at `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  return (encodeText(text).reduce((w, b) => w + charWidth(b, bold), 0) * size) / 1000;
}

/** The text cut to fit `width`, with "…" when it was cut. */
export function fitText(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  const chars = [...text];
  while (chars.length > 0 && textWidth(`${chars.join('')}…`, size, bold) > width) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** A PDF string literal: bytes, with ( ) \ escaped and anything outside ASCII as octal. */
function pdfString(text: string): string {
  return `(${encodeText(text)
    .map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x80 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`))
    .join('')})`;
}

/**
 * Column widths that fit the page: each as wide as its widest cell, numbers never squeezed; when the text columns do
 * not all fit, they share what is left in proportion, and their cells are cut with "…".
 */
export function columnWidths(table: Pick<PdfTable, 'columns' | 'rows' | 'totals'>, available = PAGE_W - 2 * MARGIN): number[] {
  const natural = table.columns.map((c, i) => {
    const cells = [...table.rows, ...(table.totals ? [table.totals] : [])].map((r) => textWidth(r[i] ?? '', FONT_SIZE, false));
    return Math.max(textWidth(c.label, FONT_SIZE, true), ...cells) + 2 * PAD;
  });
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= available) {
    // Room to spare goes to the text columns, so a short report still spans the page.
    const text = table.columns.map((c, i) => (c.align === 'left' ? i : -1)).filter((i) => i >= 0);
    const spare = available - total;
    return natural.map((w, i) => (text.includes(i) ? w + spare / text.length : text.length === 0 ? w + spare / natural.length : w));
  }
  const fixed = natural.reduce((sum, w, i) => sum + (table.columns[i].align === 'right' ? w : 0), 0);
  const textTotal = total - fixed;
  const left = Math.max(available - fixed, 0);
  if (left === 0 || textTotal === 0) return natural.map((w) => (w * available) / total);
  return natural.map((w, i) => (table.columns[i].align === 'right' ? w : (w * left) / textTotal));
}

function pageContent(table: PdfTable, widths: number[], rows: readonly (readonly string[])[], last: boolean, page: number, pages: number): string {
  const ops: string[] = [];
  const text = (x: number, y: number, size: number, bold: boolean, s: string, gray = 0) =>
    ops.push(`${gray} g BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  const line = (y: number, gray: number, width = 0.5) => ops.push(`${gray} G ${width} w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`);

  text(MARGIN, PAGE_H - MARGIN - TITLE_SIZE, TITLE_SIZE, true, table.title);
  text(MARGIN, PAGE_H - MARGIN - TITLE_SIZE - 16, 9, false, fitText(table.subtitle, PAGE_W - 2 * MARGIN, 9), 0.35);

  const cells = (cellsOf: readonly string[], y: number, bold: boolean) => {
    let x = MARGIN;
    table.columns.forEach((c, i) => {
      const content = fitText(cellsOf[i] ?? '', widths[i] - 2 * PAD, FONT_SIZE, bold);
      const tx = c.align === 'right' ? x + widths[i] - PAD - textWidth(content, FONT_SIZE, bold) : x + PAD;
      text(tx, y + (ROW_H - FONT_SIZE) / 2 + 1.5, FONT_SIZE, bold, content);
      x += widths[i];
    });
  };

  // Header: a shaded band, labels in bold.
  let y = TABLE_TOP - ROW_H;
  ops.push(`0.93 g ${MARGIN} ${y.toFixed(2)} ${PAGE_W - 2 * MARGIN} ${ROW_H} re f`);
  cells(
    table.columns.map((c) => c.label),
    y,
    true,
  );
  line(y, 0.6);
  for (const row of rows) {
    y -= ROW_H;
    cells(row, y, false);
    line(y, 0.88, 0.3);
  }
  if (last && table.totals) {
    y -= ROW_H;
    line(y + ROW_H, 0.2, 0.8);
    cells(table.totals, y, true);
  }

  text(MARGIN, MARGIN, 7, false, fitText(table.footer, PAGE_W / 2, 7), 0.45);
  const pageLabel = `Page ${page} of ${pages}`;
  text(PAGE_W - MARGIN - textWidth(pageLabel, 7), MARGIN, 7, false, pageLabel, 0.45);
  return ops.join('\n');
}

/** The table as a PDF file. At least one page, even with no rows (the header and totals say so). */
export function renderTablePdf(table: PdfTable): Buffer {
  const widths = columnWidths(table);
  const chunks: (readonly (readonly string[])[])[] = [];
  for (let i = 0; i < table.rows.length; i += ROWS_PER_PAGE) chunks.push(table.rows.slice(i, i + ROWS_PER_PAGE));
  // The totals row needs a line of its own on the last page.
  if (chunks.length === 0 || (table.totals && chunks.at(-1)!.length === ROWS_PER_PAGE)) chunks.push([]);

  const objects: string[] = [];
  // An object's number is its place in the list, from 1.
  const add = (body: string) => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES'); // filled in once the pages are numbered
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  chunks.forEach((rows, i) => {
    const content = pageContent(table, widths, rows, i === chunks.length - 1, i + 1, chunks.length);
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`),
    );
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Producer (FMS) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

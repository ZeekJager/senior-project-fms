import { describe, expect, test } from 'vitest';
import { columnWidths, encodeText, fitText, renderTablePdf, ROWS_PER_PAGE, textWidth, type PdfTable } from './table-pdf';

// FMS-91: the report PDF, written by hand. Checked the way a reader opens it: the header, every object where the
// cross-reference table says it is, the page count, and the text in the content streams.

function table(rows: number, overrides: Partial<PdfTable> = {}): PdfTable {
  return {
    title: 'Fuel report, October 2026',
    subtitle: 'Addis Ababa Central · 2026-10-01 to 2026-10-31',
    columns: [
      { label: 'Vehicle', align: 'left' },
      { label: 'Fuel (L)', align: 'right' },
    ],
    rows: Array.from({ length: rows }, (_, i) => [`AA 3-${10000 + i}`, (i * 1.5).toFixed(1)]),
    totals: ['Total', '999.0'],
    footer: 'Fuel report, October 2026',
    ...overrides,
  };
}

/** The objects as the xref table places them, and the page count the page tree gives. */
function read(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe('xref');
  const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(startxref))!;
  const entries = text.slice(startxref).split('\n').slice(3, 2 + Number(count));
  entries.forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  return { text, pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1]) };
}

describe('report PDF (FMS-91)', () => {
  test('a valid file: the header, objects where the cross-reference table says, the fonts every reader has', () => {
    const pdf = renderTablePdf(table(3));
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const { text, pages } = read(pdf);
    expect(pages).toBe(1);
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('(Fuel report, October 2026) Tj');
    expect(text).toContain('(AA 3-10002) Tj');
    expect(text).toContain('(Total) Tj');
    expect(text).toContain('(Page 1 of 1) Tj');
  });

  test('as many pages as the rows need, the header on each, the totals on the last', () => {
    const { text, pages } = read(renderTablePdf(table(ROWS_PER_PAGE * 2 + 5)));
    expect(pages).toBe(3);
    expect(text.match(/\(Vehicle\) Tj/g)).toHaveLength(3);
    expect(text.match(/\(Total\) Tj/g)).toHaveLength(1);
    expect(text).toContain('(Page 3 of 3) Tj');
    // A full last page puts the totals on a page of their own.
    expect(read(renderTablePdf(table(ROWS_PER_PAGE))).pages).toBe(2);
    // No rows still makes a page.
    expect(read(renderTablePdf(table(0, { totals: null }))).pages).toBe(1);
  });

  test('text: brackets and backslashes escaped, Windows-1252 as octal, anything else as "?"', () => {
    expect(encodeText('Addis – Adama…')).toEqual([...Buffer.from('Addis ', 'latin1'), 0x96, ...Buffer.from(' Adama', 'latin1'), 0x85]);
    expect(encodeText('አዲስ')).toEqual([0x3f, 0x3f, 0x3f]);
    const { text } = read(renderTablePdf(table(1, { rows: [['Bole (east) \\ Addis – Adama', '1.0']] })));
    expect(text).toContain('(Bole \\(east\\) \\\\ Addis \\226 Adama) Tj');
  });

  test('columns fit the page: numbers keep their width, long text is cut with an ellipsis', () => {
    const long = 'Addis Ababa – Dire Dawa via Adama, Awash, Mieso and Hirna, the long way round';
    const t = table(1, { columns: [{ label: 'Route', align: 'left' }, ...Array.from({ length: 6 }, (_, i) => ({ label: `Figure ${i}`, align: 'right' as const }))], rows: [[long, ...Array(6).fill('123456.78')]] });
    const widths = columnWidths(t, 500);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(500, 5);
    expect(widths[1]).toBeGreaterThanOrEqual(textWidth('123456.78', 8));
    const cut = fitText(long, widths[0] - 8, 8);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, 8)).toBeLessThanOrEqual(widths[0] - 8);
  });
});

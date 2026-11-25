import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatValue, isNumeric, type ColumnKind, type ReportColumn, type ReportRow, type ReportValue } from '../domain/reports';
import type { ReportDocument } from '../application/report.service';

// The reports' Excel and PDF files (FMS-160, ADR-11, docs/reports.md). Excel: typed cells (numbers as numbers in
// their display units, dates as dates), a frozen and filtered header, the totals row, each extra table a sheet of its
// own, and a sheet listing the filters. PDF: a cover page with the filters and a chart, then the table, in Abyssinica
// SIL, which has Latin and Ethiopic script, so Amharic names print.

/** The font the PDFs embed (OFL, assets/fonts/OFL.txt). */
export const PDF_FONT = join(process.cwd(), 'assets', 'fonts', 'AbyssinicaSIL-Regular.ttf');

/** A stored value in its display unit: litres, birr, km, hours, L/100 km, a rate. */
function displayNumber(kind: ColumnKind, value: number): number {
  switch (kind) {
    case 'litres':
    case 'km':
      return value / 1000;
    case 'etb':
      return value / 100;
    case 'l_per_100km':
    case 'rate':
      return value / 10;
    case 'hours':
      return value / 60;
    default:
      return value;
  }
}

const NUM_FMT: Partial<Record<ColumnKind, string>> = {
  count: '#,##0',
  litres: '#,##0.0',
  etb: '#,##0.00',
  km: '#,##0.0',
  l_per_100km: '0.0',
  pct: '0',
  hours: '#,##0.0',
  rate: '0.0',
  datetime: 'yyyy-mm-dd hh:mm',
};

/** An ISO instant as the Addis Ababa wall-clock time a spreadsheet shows (Excel dates have no time zone). */
const addisDate = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3_600_000);

function cellValue(kind: ColumnKind, value: ReportValue): ExcelJS.CellValue {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return isNumeric(kind) ? displayNumber(kind, value) : value;
  if (kind === 'datetime') return addisDate(value);
  return value;
}

function addTable(sheet: ExcelJS.Worksheet, columns: readonly ReportColumn[], rows: readonly ReportRow[], totals: ReportRow | null): void {
  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.min(40, Math.max(10, c.label.length + 2)),
    style: NUM_FMT[c.kind] ? { numFmt: NUM_FMT[c.kind] } : {},
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } };
  for (const r of rows) sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, cellValue(c.kind, r[c.key] ?? null)])));
  // The header stays in view and filters the rows (not the totals).
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };
  if (totals) {
    const row = sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, cellValue(c.kind, totals[c.key] ?? null)])));
    row.font = { bold: true };
  }
}

/** The report as an .xlsx workbook. */
export async function writeXlsx(doc: ReportDocument): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'FMS';
  book.created = new Date();
  addTable(book.addWorksheet('Report'), doc.columns, doc.rows, doc.totals);
  for (const section of doc.sections) addTable(book.addWorksheet(section.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ')), section.columns, section.rows, null);
  const filters = book.addWorksheet('Filters');
  filters.columns = [{ header: doc.title, key: 'line', width: 90 }];
  filters.getRow(1).font = { bold: true, size: 13 };
  filters.addRow({ line: doc.subtitle });
  for (const line of doc.filterLines) filters.addRow({ line });
  return Buffer.from(await book.xlsx.writeBuffer());
}

const MARGIN = 36;

/** The report as a PDF: a cover page (title, filters, a chart of the first measure), then the table. */
export function writePdf(doc: ReportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: doc.title, Creator: 'FMS' } });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    if (existsSync(PDF_FONT)) pdf.registerFont('Body', PDF_FONT);
    const font = existsSync(PDF_FONT) ? 'Body' : 'Helvetica';
    const width = pdf.page.width - 2 * MARGIN;

    // The cover page.
    pdf.font(font).fontSize(20).fillColor('#0f172a').text(doc.title, { width });
    pdf.moveDown(0.4).fontSize(10).fillColor('#475569').text(doc.subtitle, { width });
    pdf.moveDown(0.8).fontSize(11).fillColor('#0f172a');
    for (const line of doc.filterLines) pdf.text(line, { width });
    drawChart(pdf, doc, font, width);

    // The table, its header on every page.
    const columns = doc.columns;
    const colWidth = width / Math.max(1, columns.length);
    const rowHeight = 16;
    const bottom = pdf.page.height - MARGIN - 20;
    const header = () => {
      pdf.fontSize(8).fillColor('#0f172a');
      let x = MARGIN;
      for (const c of columns) {
        pdf.text(c.label, x + 2, pdf.y, { width: colWidth - 4, align: isNumeric(c.kind) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += colWidth;
      }
      pdf.moveDown(0.2);
      pdf.moveTo(MARGIN, pdf.y).lineTo(MARGIN + width, pdf.y).strokeColor('#cbd5e1').stroke();
      pdf.y += 4;
    };
    const line = (r: ReportRow, bold: boolean) => {
      if (pdf.y + rowHeight > bottom) {
        pdf.addPage();
        header();
      }
      const y = pdf.y;
      let x = MARGIN;
      pdf.fontSize(8).fillColor(bold ? '#0f172a' : '#1e293b');
      for (const c of columns) {
        pdf.text(formatValue(c.kind, r[c.key] ?? null, { grouped: true }), x + 2, y, { width: colWidth - 4, align: isNumeric(c.kind) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += colWidth;
      }
      pdf.y = y + rowHeight;
    };
    pdf.addPage();
    header();
    for (const r of doc.rows) line(r, false);
    if (doc.totals) line(doc.totals, true);
    for (const section of doc.sections) {
      pdf.addPage();
      pdf.fontSize(13).fillColor('#0f172a').text(section.title, MARGIN, MARGIN);
      pdf.moveDown(0.5);
      const w = width / section.columns.length;
      const cells = (texts: string[], bold: boolean) => {
        if (pdf.y + rowHeight > bottom) pdf.addPage();
        const y = pdf.y;
        pdf.fontSize(9).fillColor(bold ? '#0f172a' : '#1e293b');
        section.columns.forEach((c, i) => pdf.text(texts[i], MARGIN + i * w + 2, y, { width: w - 4, align: isNumeric(c.kind) ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        pdf.y = y + rowHeight;
      };
      cells(section.columns.map((c) => c.label), true);
      for (const r of section.rows) cells(section.columns.map((c) => formatValue(c.kind, r[c.key] ?? null, { grouped: true })), false);
    }
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.fontSize(7).fillColor('#64748b').text(`${doc.footer} · page ${i + 1} of ${range.count}`, MARGIN, pdf.page.height - MARGIN - 8, { width, lineBreak: false });
    }
    pdf.end();
  });
}

/** A horizontal bar chart of the report's first measure, its 10 largest rows. */
function drawChart(pdf: PDFKit.PDFDocument, doc: ReportDocument, font: string, width: number): void {
  const label = doc.columns.find((c) => !isNumeric(c.kind));
  const measure = doc.columns.find((c) => isNumeric(c.kind) && c.kind !== 'pct' && c.kind !== 'rate') ?? doc.columns.find((c) => isNumeric(c.kind));
  if (!label || !measure) return;
  const rows = doc.rows
    .filter((r) => typeof r[measure.key] === 'number')
    .sort((a, b) => Number(b[measure.key]) - Number(a[measure.key]))
    .slice(0, 10);
  if (rows.length === 0) return;
  const max = Math.max(...rows.map((r) => Number(r[measure.key])), 1);
  pdf.moveDown(1.2).font(font).fontSize(12).fillColor('#0f172a').text(`${measure.label}: the ${rows.length} largest`, { width });
  pdf.moveDown(0.4);
  const labelWidth = 160;
  const barMax = width - labelWidth - 90;
  for (const r of rows) {
    const y = pdf.y;
    const v = Number(r[measure.key]);
    pdf.fontSize(8).fillColor('#1e293b').text(String(r[label.key] ?? ''), MARGIN, y, { width: labelWidth - 6, lineBreak: false, ellipsis: true });
    pdf.rect(MARGIN + labelWidth, y + 1, Math.max(1, (v / max) * barMax), 9).fill('#2563eb');
    pdf.fillColor('#1e293b').text(formatValue(measure.kind, v, { grouped: true }), MARGIN + labelWidth + barMax + 6, y, { width: 84, lineBreak: false });
    pdf.y = y + 14;
  }
}

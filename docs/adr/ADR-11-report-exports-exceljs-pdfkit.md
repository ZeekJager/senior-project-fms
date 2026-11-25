# ADR-11: Excel and Unicode PDF Exports With exceljs and pdfkit

- **Status:** Accepted
- **Date:** 2026-11-25
- **Card:** FMS-160 (SE-204)

## Context

The FMS-91 reports export CSV and a PDF the API writes by hand (`table-pdf.ts`), on purpose with no new dependency. That PDF uses the standard Helvetica fonts, so it can only print Windows-1252: an Amharic driver name comes out as "?". FMS-160 asks for two things the hand-written exports can't give:

- **Excel (.xlsx)** that opens in Excel and LibreOffice with numbers as numbers, a frozen and filtered header, a totals row and a sheet listing the filters.
- **A PDF** with a cover page, charts and an embedded Unicode font, so Ge'ez script prints.

The card says to record the new dependencies in one ADR.

## Decision

- **exceljs 4.4.0** writes the workbook: typed cells (numbers in display units, with a number format), a frozen first row, an auto-filter over the header, a bold totals row, one sheet per extra section (compliance's cost by system and by vendor) and a "Filters" sheet. It is MIT licensed and pure JavaScript, with no native build.
- **pdfkit 0.20.2** writes the PDF: landscape A4, a cover page with the period, the filters and a bar chart of the top ten rows drawn with vector shapes, then the table with its header repeated on each page and the totals on the last, then each section, with page numbers. It is MIT licensed and pure JavaScript. It embeds a TrueType font as a subset with a ToUnicode map, so the text is also searchable and copyable.
- **The font is Abyssinica SIL 2.300** (SIL Open Font License 1.1), in `packages/backend/assets/fonts` with its licence. It covers Latin and Ethiopic. The Dockerfile copies `assets/` into the image. It is the one font for the whole PDF, so a name in any of the fleet's scripts prints in the same face.
- **The writers sit behind an interface.** `report-writers.ts` gets a document (title, filter lines, columns, rows, totals, sections) and returns bytes. The service doesn't import either library, and `table-pdf.ts` stays as the fallback when no writer is wired.
- **Both are pinned exactly** (`--save-exact`), with `@types/pdfkit` 0.17.7 for development. `npm audit` reports no high or critical advisory for either.

## Alternatives

- **Write .xlsx by hand** (a zip of SpreadsheetML): no dependency, but the zip container, shared strings, styles and the auto-filter are a lot of format to own and test. The CSV already covers the dependency-free case.
- **Extend `table-pdf.ts` to embed a TrueType font**: subsetting, the CIDFont dictionaries and a ToUnicode CMap are the hard part of PDF, and Ethiopic needs all of them.
- **A headless browser (Puppeteer) rendering HTML to PDF**: the best layout, but a Chromium binary in the API image (hundreds of MB), a process per export and a much larger attack surface.
- **SheetJS**: its current builds are no longer published to npm, and the npm version has known advisories.
- **Noto Sans Ethiopic with a separate Latin font**: two fonts mean switching faces inside a cell. Abyssinica SIL covers both scripts, under the same open licence.

## Consequences

- The API image grows by the two libraries and a 0.3 MB font. Neither runs native code.
- Excel and PDF files are built in memory. An export over 20,000 rows is made in the background by the `report-exports` job rather than in the request ([reports.md](../reports.md#exports)).
- A dependency update to either library is tested by `test/integration/reports-kpis.test.ts`: it opens the workbook with exceljs and checks typed cells, the frozen header and the Filters sheet, and checks the PDF embeds the font with Ge'ez letters in its ToUnicode map.

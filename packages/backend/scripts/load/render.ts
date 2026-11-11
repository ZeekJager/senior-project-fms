/**
 * Renders the page for a load report already written (FMS-61): `npm run load-report -w fms-backend -- <report.json>`
 * writes `<report>.html` beside it. For a report from CI or an earlier run; a run writes its own page.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderHtml, type LoadReport } from './html';

const file = process.argv[2];
if (!file) {
  console.error('✖ Usage: npm run load-report -w fms-backend -- <report.json>');
  process.exit(1);
}
const report = JSON.parse(readFileSync(file, 'utf8')) as LoadReport;
const page = path.resolve(file).replace(/(\.json)?$/i, '.html');
writeFileSync(page, renderHtml(report));
console.log(`Page: ${page}`);

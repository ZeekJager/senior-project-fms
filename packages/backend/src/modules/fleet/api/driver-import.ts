import { z } from 'zod';
import { parseCsv } from '../../../shared/http/csv';
import type { DriverImportRow, ImportProblem } from '../application/driver.service';
import { driverFields } from './driver.schemas';

/** Most rows one import may hold; split larger files. */
export const MAX_IMPORT_ROWS = 500;

const COLUMNS = ['email', 'license_number', 'license_expiry', 'license_categories', 'depot_code', 'depot_id', 'hire_date', 'emergency_phone'];
const REQUIRED = ['email', 'license_number', 'license_expiry'];

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** One CSV row. Categories are one cell, separated by spaces, commas, semicolons or bars ("B CE", "B;CE"). */
const rowSchema = z
  .object({
    email: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().pipe(z.email().max(255))),
    license_number: z.preprocess(blankToUndefined, driverFields.license_number),
    license_expiry: z.preprocess(blankToUndefined, driverFields.license_expiry),
    license_categories: z.preprocess(
      (v) => (typeof v === 'string' ? v.split(/[\s,;|]+/).filter(Boolean).map((c) => c.toUpperCase()) : v),
      driverFields.license_categories,
    ),
    depot_code: z.preprocess(blankToUndefined, z.string().trim().min(1).max(50).optional()),
    depot_id: z.preprocess(blankToUndefined, z.uuid().optional()),
    hire_date: z.preprocess(blankToUndefined, driverFields.hire_date),
    emergency_phone: z.preprocess(blankToUndefined, driverFields.emergency_phone),
  })
  .refine((r) => r.depot_code !== undefined || r.depot_id !== undefined, {
    message: 'Give depot_code or depot_id.',
    path: ['depot_code'],
    params: { reason: 'required' },
  });

/**
 * CSV text to import rows. Row numbers are as in a spreadsheet: the header
 * is row 1. Problems found here (unknown or missing columns, too many rows,
 * bad field values) are returned with the rows that passed, so the service
 * can check those too and report every problem at once.
 */
export function parseDriverImport(text: string): { rows: DriverImportRow[]; problems: ImportProblem[] } {
  const records = parseCsv(text);
  const problems: ImportProblem[] = [];
  if (records.length === 0) return { rows: [], problems: [{ row: 1, reason: 'empty_file' }] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  for (const column of header) if (!COLUMNS.includes(column)) problems.push({ row: 1, field: column, reason: 'unknown_column' });
  for (const column of REQUIRED) if (!header.includes(column)) problems.push({ row: 1, field: column, reason: 'missing_column' });
  if (!header.includes('depot_code') && !header.includes('depot_id')) problems.push({ row: 1, field: 'depot_code', reason: 'missing_column' });
  if (records.length - 1 > MAX_IMPORT_ROWS) problems.push({ row: 1, reason: `too_many_rows_max_${MAX_IMPORT_ROWS}` });
  if (records.length === 1) problems.push({ row: 1, reason: 'no_rows' });
  if (problems.length > 0) return { rows: [], problems };

  const rows: DriverImportRow[] = [];
  records.slice(1).forEach((record, i) => {
    const row = i + 2;
    const cells = Object.fromEntries(header.map((h, j) => [h, record[j] ?? '']));
    const parsed = rowSchema.safeParse(cells);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const reason = issue.code === 'custom' && typeof issue.params?.reason === 'string' ? issue.params.reason : issue.code;
        problems.push({ row, field: String(issue.path[0] ?? ''), reason: issue.code === 'invalid_value' ? 'invalid_enum' : reason });
      }
      return;
    }
    const { email, depot_code, depot_id, ...licence } = parsed.data;
    rows.push({ row, email, depot: depot_code !== undefined ? { code: depot_code } : { id: depot_id! }, licence });
  });
  return { rows, problems };
}

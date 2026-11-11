// Monthly reports (FMS-91, docs/reports.md): what each report has, and how a value reads in a download. A report
// is a table: one row per vehicle, trip or driver, and a totals row. Values stay in integer base units (ml, cents,
// metres, minutes) as the rest of the analytics API keeps them; the CSV and PDF write them in litres, birr, km and
// hours, in Addis Ababa time.

export const REPORT_KINDS = ['fuel', 'maintenance', 'cost', 'trips', 'drivers'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_FORMATS = ['json', 'csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * How a column's values are kept and shown:
 * - `text`, `count`: as they are;
 * - `litres`: ml, shown in litres to 1 decimal;
 * - `etb`: cents, shown in birr to 2 decimals;
 * - `km`: metres, shown in km to 1 decimal;
 * - `l_per_100km`: ml per km, shown as litres per 100 km to 1 decimal;
 * - `pct`: a whole percentage;
 * - `hours`: minutes, shown in hours to 1 decimal;
 * - `datetime`: an ISO instant, shown as Addis Ababa date and time.
 */
export type ColumnKind = 'text' | 'count' | 'litres' | 'etb' | 'km' | 'l_per_100km' | 'pct' | 'hours' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}

export type ReportValue = string | number | null;
export type ReportRow = Record<string, ReportValue>;

interface ReportDefinition {
  title: string;
  /** One row is one of these. */
  rowNoun: { one: string; many: string };
  columns: readonly ReportColumn[];
}

const col = (key: string, label: string, kind: ColumnKind): ReportColumn => ({ key, label, kind });

export const REPORTS: Record<ReportKind, ReportDefinition> = {
  fuel: {
    title: 'Fuel report',
    rowNoun: { one: 'vehicle', many: 'vehicles' },
    columns: [
      col('registration_number', 'Vehicle', 'text'),
      col('depot', 'Depot', 'text'),
      col('fuel_type', 'Fuel type', 'text'),
      col('fill_ups', 'Fill-ups', 'count'),
      col('fuel_ml', 'Fuel (L)', 'litres'),
      col('fuel_cost_cents', 'Cost (ETB)', 'etb'),
      col('distance_m', 'Distance (km)', 'km'),
      col('consumption_ml_per_km', 'Used (L/100 km)', 'l_per_100km'),
      col('rated_ml_per_km', 'Rated (L/100 km)', 'l_per_100km'),
      col('cost_per_km_cents', 'Cost per km (ETB)', 'etb'),
    ],
  },
  maintenance: {
    title: 'Maintenance report',
    rowNoun: { one: 'vehicle', many: 'vehicles' },
    columns: [
      col('registration_number', 'Vehicle', 'text'),
      col('depot', 'Depot', 'text'),
      col('completed', 'Repairs done', 'count'),
      col('preventive', 'Preventive', 'count'),
      col('corrective', 'Corrective', 'count'),
      col('other', 'Inspection and other', 'count'),
      col('open', 'Open at month end', 'count'),
      col('labour_minutes', 'Labour (h)', 'hours'),
      col('cost_cents', 'Cost (ETB)', 'etb'),
    ],
  },
  cost: {
    title: 'Cost report',
    rowNoun: { one: 'vehicle', many: 'vehicles' },
    columns: [
      col('registration_number', 'Vehicle', 'text'),
      col('depot', 'Depot', 'text'),
      col('distance_m', 'Distance (km)', 'km'),
      col('fuel_cost_cents', 'Fuel (ETB)', 'etb'),
      col('maintenance_cost_cents', 'Maintenance (ETB)', 'etb'),
      col('total_cost_cents', 'Total (ETB)', 'etb'),
      col('cost_per_km_cents', 'Per km (ETB)', 'etb'),
    ],
  },
  trips: {
    title: 'Trip history',
    rowNoun: { one: 'trip', many: 'trips' },
    columns: [
      col('scheduled_start', 'Scheduled', 'datetime'),
      col('route', 'Route', 'text'),
      col('registration_number', 'Vehicle', 'text'),
      col('driver', 'Driver', 'text'),
      col('status', 'Status', 'text'),
      col('actual_start', 'Started', 'datetime'),
      col('actual_end', 'Ended', 'datetime'),
      col('planned_distance_m', 'Planned (km)', 'km'),
      col('actual_distance_m', 'Driven (km)', 'km'),
      col('on_time', 'On time', 'text'),
    ],
  },
  drivers: {
    title: 'Driver performance',
    rowNoun: { one: 'driver', many: 'drivers' },
    // Rank and score (FMS-146, docs/analytics.md) only for the roles allowed tracking:read: ReportService drops them
    // for the others. A driver with no score has its reason in the score column ("Not enough trips").
    columns: [
      col('rank', 'Rank', 'count'),
      col('driver', 'Driver', 'text'),
      col('depot', 'Depot', 'text'),
      col('score', 'Score (0-100)', 'count'),
      col('trips_completed', 'Trips', 'count'),
      col('distance_m', 'Distance (km)', 'km'),
      col('driving_minutes', 'Driving (h)', 'hours'),
      col('on_time_pct', 'On time (%)', 'pct'),
      col('speeding', 'Speeding', 'count'),
      col('idling', 'Idling', 'count'),
      col('incidents', 'Incidents', 'count'),
    ],
  },
};

/** A trip ending this long after its scheduled end is still on time (the analytics KPIs' rule). */
export { ON_TIME_GRACE_MINUTES } from './kpis';

/** Consumption is judged on at least this many km driven: a few km says nothing about a vehicle. */
export const MIN_JUDGED_METRES = 100_000;

/** Cents per km driven, or null without a km. */
export const centsPerKm = (cents: number, metres: number): number | null => (metres >= 1000 ? Math.round((cents * 1000) / metres) : null);

/** Ml per km driven, or null under MIN_JUDGED_METRES. */
export const mlPerKmDriven = (ml: number, metres: number): number | null => (metres >= MIN_JUDGED_METRES ? Math.round((ml * 1000) / metres) : null);

/** A whole percentage, or null of nothing. */
export const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 100) / whole) : null);

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  assigned: 'Assigned',
  en_route: 'Under way',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const tripStatusWord = (status: string) => STATUS_WORDS[status] ?? status;

export const FUEL_TYPE_WORDS: Record<string, string> = { petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Hybrid', electric: 'Electric', cng: 'CNG', lpg: 'LPG', other: 'Other' };

const addisDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Addis_Ababa',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "2026-10-03 08:15", Addis Ababa. */
export function formatAddisDateTime(iso: string | Date): string {
  const parts = Object.fromEntries(addisDateTime.formatToParts(typeof iso === 'string' ? new Date(iso) : iso).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const fixed = (value: number, divisor: number, decimals: number) => (value / divisor).toFixed(decimals);

/** "1234567.5" -> "1,234,567.5". */
const group = (text: string) => text.replace(/^(-?\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+$)/g, ','));

/**
 * A value as a download writes it, blank for none. Plain numbers by default, as a spreadsheet reads them from a CSV;
 * `grouped` adds thousands separators, for a PDF read by people.
 */
export function formatValue(kind: ColumnKind, value: ReportValue, { grouped = false } = {}): string {
  if (value === null || value === '') return '';
  if (typeof value === 'string') return kind === 'datetime' ? formatAddisDateTime(value) : value;
  const text = plain(kind, value);
  return grouped ? group(text) : text;
}

function plain(kind: ColumnKind, value: number): string {
  switch (kind) {
    case 'litres':
      return fixed(value, 1000, 1);
    case 'etb':
      return fixed(value, 100, 2);
    case 'km':
      return fixed(value, 1000, 1);
    case 'l_per_100km':
      return fixed(value, 10, 1);
    case 'hours':
      return fixed(value, 60, 1);
    default:
      return String(value);
  }
}

/** "October 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A cell as CSV: quoted when it holds a comma, quote or line break; a leading = + - @ is defused so a spreadsheet never runs it. */
function csvCell(text: string, numeric: boolean): string {
  let t = text;
  if (!numeric && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

const NUMERIC: readonly ColumnKind[] = ['count', 'litres', 'etb', 'km', 'l_per_100km', 'pct', 'hours'];
export const isNumeric = (kind: ColumnKind) => NUMERIC.includes(kind);

/** The report as CSV: a header row, the rows, then the totals row; CRLF line ends and a byte-order mark for Excel. */
export function toCsv(columns: readonly ReportColumn[], rows: readonly ReportRow[], totals: ReportRow | null): string {
  const line = (cells: string[]) => cells.join(',');
  const body = [line(columns.map((c) => csvCell(c.label, false)))];
  for (const row of [...rows, ...(totals ? [totals] : [])]) {
    body.push(line(columns.map((c) => csvCell(formatValue(c.kind, row[c.key] ?? null), isNumeric(c.kind) && typeof row[c.key] === 'number'))));
  }
  return `﻿${body.join('\r\n')}\r\n`;
}

import { describe, expect, test } from 'vitest';
import { centsPerKm, formatAddisDateTime, formatValue, mlPerKmDriven, monthTitle, percent, REPORT_KINDS, REPORTS, toCsv } from './reports';

// FMS-91: how a report's values read in a download.

describe('report values (FMS-91)', () => {
  test('integers in base units are written in litres, birr, km, hours and L/100 km', () => {
    expect(formatValue('litres', 41_250)).toBe('41.3');
    expect(formatValue('etb', 1_234_567)).toBe('12345.67');
    expect(formatValue('km', 98_760)).toBe('98.8');
    expect(formatValue('l_per_100km', 318)).toBe('31.8');
    expect(formatValue('hours', 95)).toBe('1.6');
    // A PDF groups thousands for reading; a CSV never does.
    expect(formatValue('etb', 123_456_789, { grouped: true })).toBe('1,234,567.89');
    expect(formatValue('count', 12_000, { grouped: true })).toBe('12,000');
    expect(formatValue('etb', -100_000, { grouped: true })).toBe('-1,000.00');
    expect(formatValue('l_per_100km', 318, { grouped: true })).toBe('31.8');
    expect(formatValue('count', 12)).toBe('12');
    expect(formatValue('pct', 87)).toBe('87');
    expect(formatValue('km', null)).toBe('');
  });

  test('times are Addis Ababa date and time; months read as words', () => {
    expect(formatAddisDateTime('2026-10-03T05:15:00Z')).toBe('2026-10-03 08:15');
    expect(formatValue('datetime', '2026-10-31T21:30:00Z')).toBe('2026-11-01 00:30');
    expect(monthTitle('2026-10')).toBe('October 2026');
  });

  test('ratios: per km only past a kilometre, consumption only past 100 km, a percentage of nothing is none', () => {
    expect(centsPerKm(50_000, 20_000)).toBe(2500);
    expect(centsPerKm(500, 999)).toBeNull();
    expect(mlPerKmDriven(32_000, 100_000)).toBe(320);
    expect(mlPerKmDriven(5_000, 40_000)).toBeNull();
    expect(percent(7, 8)).toBe(88);
    expect(percent(0, 0)).toBeNull();
  });

  test('CSV: a header, the rows and the totals, CRLF, with a byte-order mark; text a spreadsheet would run is defused', () => {
    const columns = [
      { key: 'name', label: 'Vehicle', kind: 'text' as const },
      { key: 'fuel', label: 'Fuel (L)', kind: 'litres' as const },
      { key: 'note', label: 'Note, if any', kind: 'text' as const },
    ];
    const csv = toCsv(columns, [{ name: '=HYPERLINK("x")', fuel: 41_250, note: 'Said "ok", then left' }], { name: 'Total', fuel: 41_250, note: null });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual(['Vehicle,Fuel (L),"Note, if any"', `"'=HYPERLINK(""x"")",41.3,"Said ""ok"", then left"`, 'Total,41.3,', '']);
  });

  test('every report has a title, a first column and labels of its own', () => {
    for (const kind of REPORT_KINDS) {
      const { title, columns } = REPORTS[kind];
      expect(title).not.toBe('');
      expect(new Set(columns.map((c) => c.key)).size).toBe(columns.length);
      expect(new Set(columns.map((c) => c.label)).size).toBe(columns.length);
    }
  });
});

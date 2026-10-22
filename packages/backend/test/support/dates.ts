import { operatingToday } from '../../src/modules/fleet/domain/attendance';

/**
 * A date `days` from today in Addis Ababa, `YYYY-MM-DD` (FMS-123). The API judges expiry, attendance and
 * licences by the Addis Ababa date (UTC+3), so a test that compares with a date must use it too: from
 * 21:00 UTC the UTC date is a day behind, and a date built with `toISOString().slice(0, 10)` is off by one.
 * `from` is the instant whose Addis Ababa day counts as today (default now), e.g. a window's start.
 */
export function addisDate(days = 0, from: Date = new Date()): string {
  const d = new Date(`${operatingToday(from)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

import { z } from 'zod';

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /audit-logs and /trips). */
const ADDIS_OFFSET = '+03:00';

/** A date `to` covers that whole day: the bound is the next local midnight. */
export function bound(value: string, end: boolean): Date {
  if (value.includes('T')) return new Date(value);
  if (!end) return new Date(`${value}T00:00:00${ADDIS_OFFSET}`);
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(`${next.toISOString().slice(0, 10)}T00:00:00${ADDIS_OFFSET}`);
}

/** A filter bound: an instant with its offset, or a date (an Addis Ababa day). */
export const instantOrDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

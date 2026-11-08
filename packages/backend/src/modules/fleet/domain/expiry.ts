import type { Queryable } from '../../../shared/infrastructure/queryable';

// Expiry warnings for documents, driving licences and warranties (FMS-26,
// which absorbs FMS-47's rules; warranties FMS-133). A date within 30 days is amber, within 7 days red. Each
// level is raised once per subject and expiry date: a re-run, a missed day
// or the check on upload never repeats one, and a new expiry date (a renewed
// licence, a replacement document) starts again.

/**
 * Raised from this many days before the expiry date (amber): the default of the expiry_warning_days setting
 * (FMS-80), which the daily check uses. The vehicle list's "expiring" filter keeps this.
 */
export const EXPIRY_WINDOW_DAYS = 30;
/** From this many days before (red). The expiry day itself is day 0, still red. */
export const RED_WITHIN_DAYS = 7;

export type ExpiryLevel = 'amber' | 'red';
export type ExpirySubject = 'document' | 'licence' | 'warranty';

/**
 * The level for `daysLeft` days to expiry, or null outside the window. An
 * expiry already past is not "expiring": dispatch checks block it already,
 * and these warnings exist to come before that point.
 */
export function expiryLevel(daysLeft: number, windowDays = EXPIRY_WINDOW_DAYS): ExpiryLevel | null {
  if (daysLeft < 0 || daysLeft > windowDays) return null;
  return daysLeft <= RED_WITHIN_DAYS ? 'red' : 'amber';
}

/** Events for the alert engine (FMS-92 turns them into alerts). Payloads carry public ids only. */
export const EXPIRY_EVENTS = {
  /** `document_id`, `owner_type`, `owner_id`, `document_type`, `expires_on`, `days_left`, `level` */
  documentExpiring: 'DocumentExpiring',
  /** `driver_id`, `user_id`, `depot_id`, `license_expiry`, `days_left`, `level` */
  licenceExpiring: 'LicenceExpiring',
  /** `warranty_id`, `vehicle_id`, `provider`, `component`, `ends_on`, `days_left`, `level` (FMS-133) */
  warrantyExpiring: 'WarrantyExpiring',
} as const;

/** A warranty ending within the window (maintenance module, FMS-133). Internal ids; dates YYYY-MM-DD. */
export interface EndingWarranty {
  id: string;
  publicId: string;
  vehicleId: string;
  provider: string;
  component: string | null;
  endsOn: string;
  daysLeft: number;
}

/** The warranties ending from `today` to `today + window` days (YYYY-MM-DD), oldest end first. */
export type WarrantyExpirySource = (db: Queryable, today: string, window: number) => Promise<EndingWarranty[]>;

export interface ExpiryRunResult extends Record<string, unknown> {
  checked: number;
  raised: number;
}

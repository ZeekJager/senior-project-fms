// Expiry warnings for documents and driving licences (FMS-26, which absorbs
// FMS-47's rules). A date within 30 days is amber, within 7 days red. Each
// level is raised once per subject and expiry date: a re-run, a missed day
// or the check on upload never repeats one, and a new expiry date (a renewed
// licence, a replacement document) starts again.

/** Raised from this many days before the expiry date (amber). */
export const EXPIRY_WINDOW_DAYS = 30;
/** From this many days before (red). The expiry day itself is day 0, still red. */
export const RED_WITHIN_DAYS = 7;

export type ExpiryLevel = 'amber' | 'red';
export type ExpirySubject = 'document' | 'licence';

/**
 * The level for `daysLeft` days to expiry, or null outside the window. An
 * expiry already past is not "expiring": dispatch checks block it already,
 * and these warnings exist to come before that point.
 */
export function expiryLevel(daysLeft: number): ExpiryLevel | null {
  if (daysLeft < 0 || daysLeft > EXPIRY_WINDOW_DAYS) return null;
  return daysLeft <= RED_WITHIN_DAYS ? 'red' : 'amber';
}

/** Events for the alert engine (FMS-92 turns them into alerts). Payloads carry public ids only. */
export const EXPIRY_EVENTS = {
  /** `document_id`, `owner_type`, `owner_id`, `document_type`, `expires_on`, `days_left`, `level` */
  documentExpiring: 'DocumentExpiring',
  /** `driver_id`, `user_id`, `depot_id`, `license_expiry`, `days_left`, `level` */
  licenceExpiring: 'LicenceExpiring',
} as const;

export interface ExpiryRunResult extends Record<string, unknown> {
  checked: number;
  raised: number;
}

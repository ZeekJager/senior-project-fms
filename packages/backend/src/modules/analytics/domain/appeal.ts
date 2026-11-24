import { AppError } from '../../../shared/errors/app-error';

// Driver score appeals and complaints (FMS-159, docs/score-appeals.md). A driver appeals a speeding or idling flag, an
// incident or a month's score; a reviewer claims it, may ask questions in its thread, and approves (correcting the
// score) or rejects it with a note; the driver acknowledges the decision, or it closes itself after a week. Pure: the
// rules, no storage.

export const APPEAL_KINDS = ['appeal', 'complaint'] as const;
export type AppealKind = (typeof APPEAL_KINDS)[number];

export const APPEAL_TARGET_TYPES = ['flag', 'incident', 'score'] as const;
export type AppealTargetType = (typeof APPEAL_TARGET_TYPES)[number];

export const APPEAL_REASONS = ['wrong_data', 'not_my_trip', 'road_conditions', 'vehicle_fault', 'other'] as const;
export type AppealReason = (typeof APPEAL_REASONS)[number];

export const APPEAL_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'closed'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** Still to be decided: one per target at a time, and counted against the review deadline. */
export const OPEN_STATUSES: readonly AppealStatus[] = ['submitted', 'under_review'];

export const APPEAL_OUTCOMES = ['approved', 'rejected', 'withdrawn'] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

/** What an approval takes out of the score: the flag, the incident, or the whole trip with its flags and incidents. */
export const CORRECTIONS = ['exclude_flag', 'exclude_incident', 'exclude_trip'] as const;
export type Correction = (typeof CORRECTIONS)[number];

export const APPEAL_EVENT_TYPES = [
  'submitted',
  'claimed',
  'commented',
  'approved',
  'rejected',
  'withdrawn',
  'escalated',
  'acknowledged',
  'closed',
  'attachment_opened',
] as const;
export type AppealEventType = (typeof APPEAL_EVENT_TYPES)[number];

/** The card's appeal.submitted and the rest, named as CONVENTIONS.md has events. */
export const APPEAL_EVENTS = {
  submitted: 'AppealSubmitted',
  claimed: 'AppealClaimed',
  commented: 'AppealCommented',
  approved: 'AppealApproved',
  rejected: 'AppealRejected',
  withdrawn: 'AppealWithdrawn',
  closed: 'AppealClosed',
  overdue: 'AppealOverdue',
  scoreCorrected: 'ScoreCorrected',
} as const;

export const MIN_EXPLANATION = 20;
export const MAX_EXPLANATION = 2000;
export const MAX_NOTE = 2000;
export const MAX_COMMENT = 2000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** A decision the driver has not acknowledged closes itself this long after it was made. */
export const AUTO_CLOSE_DAYS = 7;

export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** JPEG, PNG, WebP or PDF from the first bytes; the filename and the declared type are the client's claim and ignored. */
export function sniffAttachment(bytes: Buffer): AttachmentType | null {
  const starts = (offset: number, ...sig: number[]) => bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // RIFF....WEBP
  if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (starts(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

/** What a reviewer or driver may do to an appeal. */
export type AppealAction = 'claim' | 'comment' | 'decide' | 'withdraw' | 'acknowledge' | 'close';

/** The statuses each action is allowed from (Submitted -> Under review -> Approved or Rejected -> Closed). */
const ALLOWED: Record<AppealAction, readonly AppealStatus[]> = {
  claim: ['submitted'],
  comment: ['submitted', 'under_review'],
  decide: ['under_review'],
  withdraw: ['submitted', 'under_review'],
  acknowledge: ['approved', 'rejected'],
  close: ['approved', 'rejected'],
};

export const canDo = (status: AppealStatus, action: AppealAction): boolean => ALLOWED[action].includes(status);

/** 409 for any step the status flow does not have (the card's invalid_transition). */
export function assertCan(status: AppealStatus, action: AppealAction): void {
  if (!canDo(status, action)) throw invalidTransition(status, action);
}

/** The corrections an approval of an appeal against this target may make. A score appeal names the item it corrects. */
export function correctionsFor(target: AppealTargetType, hasTrip: boolean): readonly Correction[] {
  const trip: Correction[] = hasTrip ? ['exclude_trip'] : [];
  if (target === 'flag') return ['exclude_flag', ...trip];
  if (target === 'incident') return ['exclude_incident', ...trip];
  return ['exclude_flag', 'exclude_incident', 'exclude_trip'];
}

/** One open appeal per flag, per incident, and per driver's month. */
export function targetKey(target: { type: 'flag' | 'incident'; id: string } | { type: 'score'; driverId: string; month: string }): string {
  return target.type === 'score' ? `score:${target.driverId}:${target.month}` : `${target.type}:${target.id}`;
}

/** Whether something that happened at `eventAt` may still be appealed at `now`, within `days`. */
export function withinWindow(eventAt: Date, now: Date, days: number): boolean {
  return now.getTime() - eventAt.getTime() <= days * 86_400_000 && eventAt.getTime() <= now.getTime() + 60_000;
}

/** Addis Ababa is UTC+3 all year. */
const ADDIS_OFFSET_MS = 3 * 3_600_000;

/**
 * The review deadline: `days` working days (Monday to Friday in Addis Ababa) after `from`, at the same time of day. An
 * appeal sent at the weekend starts counting on Monday. Public holidays are not known, so not skipped.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const local = new Date(from.getTime() + ADDIS_OFFSET_MS);
  let added = 0;
  while (added < days) {
    local.setUTCDate(local.getUTCDate() + 1);
    const weekday = local.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return new Date(local.getTime() - ADDIS_OFFSET_MS);
}

/** The end of a month (`YYYY-MM`) in Addis Ababa: when its score is final, and when its appeal window opens. */
export function monthEnd(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - ADDIS_OFFSET_MS);
}

/** The start of a month (`YYYY-MM`) in Addis Ababa. */
export function monthStart(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - ADDIS_OFFSET_MS);
}

/** The Addis Ababa month (`YYYY-MM`) a moment falls in. */
export function monthOf(at: Date): string {
  return new Date(at.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 7);
}

/** Median of a list of numbers, null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** An appeal as the API shows it. Ids are public ids. */
export interface AppealView {
  id: string;
  kind: AppealKind;
  status: AppealStatus;
  outcome: AppealOutcome | null;
  target: {
    type: AppealTargetType;
    /** The flag's or incident's public id; null for a score. */
    id: string | null;
    /** `YYYY-MM` for a score. */
    month: string | null;
    trip_id: string | null;
    event_at: string;
  };
  reason: AppealReason;
  explanation: string;
  driver: { id: string; name: string };
  depot: { id: string; name: string } | null;
  submitted_at: string;
  due_at: string;
  overdue: boolean;
  escalated_at: string | null;
  claimed_by: { id: string; name: string } | null;
  claimed_at: string | null;
  decided_by: { id: string; name: string } | null;
  decided_at: string | null;
  decision_note: string | null;
  correction: Correction | null;
  /** The month's score before and after an approval corrected it ("Corrected after appeal"). */
  score_before: number | null;
  score_after: number | null;
  acknowledged_at: string | null;
  closed_at: string | null;
  attachments: { id: string; content_type: AttachmentType; size_bytes: number; filename: string | null }[];
  version: number;
}

export interface AppealEventView {
  id: string;
  type: AppealEventType;
  actor: { id: string; name: string } | null;
  body: string | null;
  at: string;
}

export const appealNotFound = () => new AppError(404, 'NOT_FOUND', 'Appeal not found.');
export const targetNotFound = () => new AppError(404, 'NOT_FOUND', 'There is no such flag, incident or score of yours to appeal.');
export const attachmentNotFound = () => new AppError(404, 'NOT_FOUND', 'Attachment not found.');
export const invalidTransition = (status: AppealStatus, action: AppealAction) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `An appeal that is ${status.replace('_', ' ')} cannot be ${PAST[action]}.`, [
    { field: 'status', reason: 'invalid_transition' },
  ]);
const PAST: Record<AppealAction, string> = {
  claim: 'claimed',
  comment: 'commented on',
  decide: 'decided',
  withdraw: 'withdrawn',
  acknowledge: 'acknowledged',
  close: 'closed',
};
export const appealOpen = () =>
  new AppError(409, 'CONFLICT_APPEAL_OPEN', 'There is already an open appeal against this. Follow it in My appeals.', [
    { field: 'target', reason: 'appeal_open' },
  ]);
export const windowClosed = (days: number) =>
  new AppError(409, 'CONFLICT_APPEAL_WINDOW_CLOSED', `This can no longer be appealed: appeals are taken within ${days} days.`, [
    { field: 'target', reason: 'appeal_window_closed' },
  ]);
export const ownReport = () =>
  new AppError(409, 'CONFLICT_OWN_REPORT', 'You reported or reviewed what this appeal is against, so another reviewer must decide it.', [
    { field: 'reviewer', reason: 'own_report' },
  ]);
export const tooManyFiles = () =>
  new AppError(400, 'VALIDATION_FAILED', `Attach at most ${MAX_ATTACHMENTS} files.`, [{ field: 'files', reason: 'too_many' }]);
export const fileTooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'Each file must be 5 MB or less.');
export const unsupportedFile = () =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Attach photos (JPEG, PNG or WebP) or PDF files only.');
export const linkExpired = () => new AppError(401, 'AUTH_TOKEN_EXPIRED', 'This attachment link has expired. Open the appeal again for a new one.');
export const linkInvalid = () => new AppError(401, 'AUTH_TOKEN_INVALID', 'This attachment link is not valid.');

import { AppError } from '../../../shared/errors/app-error';

// Admin-to-driver feedback (FMS-158, docs/driver-feedback.md). A manager gives a driver feedback on a trip, a month's
// score or their performance overall; the driver reads it, acknowledges it and may reply once, or disagrees by
// appealing (FMS-159). The author may correct it for 24 hours; after that it can only be retracted. Pure: the rules,
// no storage.

export const FEEDBACK_SUBJECTS = ['trip', 'month', 'overall'] as const;
export type FeedbackSubject = (typeof FEEDBACK_SUBJECTS)[number];

export const FEEDBACK_TONES = ['praise', 'needs_improvement', 'information'] as const;
export type FeedbackTone = (typeof FEEDBACK_TONES)[number];

export const MIN_MESSAGE = 10;
export const MAX_MESSAGE = 2000;
export const MAX_REPLY = 1000;
export const MAX_RETRACTION_REASON = 500;
export const MAX_TEMPLATE_TITLE = 80;

/** How long the author may correct an item. */
export const EDIT_WINDOW_MS = 24 * 3_600_000;
/** An item the driver has not acknowledged this long is flagged on the manager's view. */
export const UNACKNOWLEDGED_DAYS = 7;
/** The manager's counts per category cover this many days. */
export const COUNT_DAYS = 90;

/** The card's feedback.given and the rest, named as CONVENTIONS.md has events. */
export const FEEDBACK_EVENTS = {
  given: 'FeedbackGiven',
  edited: 'FeedbackEdited',
  retracted: 'FeedbackRetracted',
  acknowledged: 'FeedbackAcknowledged',
  replied: 'FeedbackReplied',
} as const;

/** What the caller may do with an item now. */
export interface FeedbackAbilities {
  edit: boolean;
  retract: boolean;
  acknowledge: boolean;
  reply: boolean;
  disagree: boolean;
}

export interface FeedbackState {
  authorId: string;
  editableUntil: Date;
  retractedAt: Date | null;
  acknowledgedAt: Date | null;
  repliedAt: Date | null;
}

/** Whether the author may still correct it: theirs, not retracted, within 24 hours of giving it. */
export function canEdit(item: FeedbackState, userId: string | null, now: Date): boolean {
  return userId !== null && item.authorId === userId && item.retractedAt === null && now.getTime() < item.editableUntil.getTime();
}

export function abilities(item: FeedbackState, as: { manager: boolean; canWrite: boolean; driver: boolean; userId: string | null }, now: Date): FeedbackAbilities {
  const live = item.retractedAt === null;
  return {
    edit: as.manager && as.canWrite && canEdit(item, as.userId, now),
    retract: as.manager && as.canWrite && live,
    acknowledge: as.driver && live && item.acknowledgedAt === null,
    reply: as.driver && live && item.repliedAt === null,
    disagree: as.driver && live,
  };
}

/** Flagged on the manager's view: live, never acknowledged, given at least 7 days ago. */
export function unacknowledgedTooLong(item: { createdAt: Date; acknowledgedAt: Date | null; retractedAt: Date | null }, now: Date): boolean {
  return item.retractedAt === null && item.acknowledgedAt === null && now.getTime() - item.createdAt.getTime() >= UNACKNOWLEDGED_DAYS * 86_400_000;
}

/** The oldest an item may be before the retention job deletes it: `months` calendar months before `now`. */
export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  // The same day of that month, or its last day (31 March less a month is 28 or 29 February).
  const last = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, last));
  return cutoff;
}

export const feedbackNotFound = () => new AppError(404, 'NOT_FOUND', 'Feedback not found.');
export const templateNotFound = () => new AppError(404, 'NOT_FOUND', 'Template not found.');
export const otherDepot = () => new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', "This driver is not in your depot: you cannot read or give their feedback.");
export const editLocked = () =>
  new AppError(409, 'CONFLICT_FEEDBACK_LOCKED', 'Feedback can be corrected by its author for 24 hours. After that it can only be retracted, with a reason.', [
    { field: 'message', reason: 'edit_window_closed' },
  ]);
export const alreadyReplied = () => new AppError(409, 'CONFLICT_FEEDBACK_REPLIED', 'You have already replied to this feedback.', [{ field: 'body', reason: 'already_replied' }]);
export const retracted = () => new AppError(409, 'CONFLICT_FEEDBACK_RETRACTED', 'This feedback was retracted.', [{ field: 'feedback', reason: 'retracted' }]);

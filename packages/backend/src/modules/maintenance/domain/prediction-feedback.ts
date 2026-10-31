import { AppError } from '../../../shared/errors/app-error';
import type { FailureComponent } from './failure';

// What a technician found when they inspected a vehicle the model flagged (FMS-128, docs/ml-scoring.md):
// the only way to know whether a high-risk prediction was right, and the label for retraining.

/** As in maintenance.prediction_outcome (migration 043). */
export const PREDICTION_OUTCOMES = ['confirmed_issue', 'no_issue_found', 'already_fixed', 'not_inspected'] as const;
export type PredictionOutcome = (typeof PREDICTION_OUTCOMES)[number];

/** The author may change their feedback for this long after giving it; then it stands. */
export const FEEDBACK_EDIT_DAYS = 7;

/** Months of the confirmed share a model's registry entry lists, this month included. */
export const FEEDBACK_MONTHS = 12;

export const PREDICTION_FEEDBACK_EVENTS = { recorded: 'PredictionFeedbackRecorded' } as const;

/** POST body: the outcome, and for a confirmed issue what was found and the failure it led to. */
export interface FeedbackInput {
  outcome: PredictionOutcome;
  component?: FailureComponent | null;
  /** The failure record (FMS-125) the confirmed issue led to: the same vehicle's, in scope. */
  failure_event_id?: string | null;
  comment?: string | null;
}

/** PATCH body: the fields to change; null clears one. */
export type FeedbackPatch = Partial<FeedbackInput>;

/** A prediction's feedback as the API returns it. Public ids only. */
export interface PredictionFeedbackView {
  id: string;
  prediction_id: string;
  outcome: PredictionOutcome;
  component: FailureComponent | null;
  failure_event_id: string | null;
  comment: string | null;
  /** The user who gave it. */
  recorded_by: string | null;
  created_at: Date;
  updated_at: Date;
  /** Until when the author may change it. */
  editable_until: Date;
  /** The caller is the author and the time has not passed. */
  can_edit: boolean;
}

/** The confirmed share of one model version's high-risk predictions (GET /ml-models). */
export interface ModelFeedbackStats {
  /** Scored predictions of this version at risk level high. */
  high_risk_predictions: number;
  /** Of those, how many have feedback. */
  with_feedback: number;
  confirmed_issue: number;
  no_issue_found: number;
  already_fixed: number;
  not_inspected: number;
  /** confirmed_issue + no_issue_found + already_fixed: the ones an inspection judged. not_inspected says nothing. */
  reviewed: number;
  /** confirmed_issue / reviewed, three decimals; null when nothing is reviewed yet. */
  precision: number | null;
  /** Newest month first, only months with a judgement; the month is the one feedback was given (Addis Ababa). */
  by_month: { month: string; reviewed: number; confirmed_issue: number; precision: number | null }[];
}

/** The confirmed share of the judged predictions, to three decimals; null when none was judged. */
export function precisionOf(confirmed: number, reviewed: number): number | null {
  return reviewed === 0 ? null : Math.round((confirmed / reviewed) * 1000) / 1000;
}

/** When the author's window closes. */
export const editableUntil = (createdAt: Date): Date => new Date(createdAt.getTime() + FEEDBACK_EDIT_DAYS * 86_400_000);

export const predictionNotFound = () => new AppError(404, 'NOT_FOUND', 'Prediction not found.');

export const feedbackNotFound = () => new AppError(404, 'NOT_FOUND', 'This prediction has no feedback yet.');

export const feedbackAlreadyRecorded = (feedbackId: string) =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'This prediction already has feedback: the author can change it for 7 days.', [
    { reason: 'already_recorded', record_id: feedbackId },
  ]);

export const feedbackNotAuthor = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only the technician who gave this feedback can change it.', [{ reason: 'not_author' }]);

export const feedbackWindowClosed = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `Feedback can be changed for ${FEEDBACK_EDIT_DAYS} days after it was given.`, [
    { reason: 'edit_window_closed' },
  ]);

export const foundWithoutIssue = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'What was found, and the failure it led to, can only be given for a confirmed issue.', [
    { field, reason: 'only_for_confirmed_issue' },
  ]);

export const feedbackFailureNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The failure record does not exist or is outside your depots.', [{ field: 'failure_event_id', reason: 'references_missing_record' }]);

export const feedbackFailureOtherVehicle = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The failure record is about another vehicle.', [{ field: 'failure_event_id', reason: 'failure_other_vehicle' }]);

export const feedbackComponentMismatch = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The component is not the one of the failure record.', [{ field: 'component', reason: 'component_mismatch' }]);

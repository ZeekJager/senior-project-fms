import { AppError } from '../../../shared/errors/app-error';
import type { AssignmentWarning } from './trip';

// Approved exceptions to the assignment rules (FMS-151, docs/assignment-exceptions.md). The two assignment warnings,
// the driver's attendance and a previous trip running over, are each "warn" (the assignment goes ahead, as before)
// or "approve" (it is held as an exception request until a fleet manager decides), per depot. The safety rules,
// BR-1 overlap, BR-2 maintenance and BR-8 licence, refuse outright and are never an exception, for anyone.

export const EXCEPTION_POLICIES = ['warn', 'approve'] as const;
export type ExceptionPolicy = (typeof EXCEPTION_POLICIES)[number];

/** A depot's policy for each warning: its own row's, else the fleet's (tracking.rule_thresholds). */
export interface ExceptionPolicies {
  attendance: ExceptionPolicy;
  overrun: ExceptionPolicy;
}

export const DEFAULT_EXCEPTION_POLICIES: ExceptionPolicies = { attendance: 'warn', overrun: 'warn' };

export const EXCEPTION_STATUSES = ['pending', 'approved', 'refused', 'withdrawn'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

const policyOf = (w: AssignmentWarning, p: ExceptionPolicies): ExceptionPolicy => (w.warning === 'DRIVER_ATTENDANCE' ? p.attendance : p.overrun);

/** The warnings an assignment raised that the depot holds for approval. */
export function heldWarnings(warnings: readonly AssignmentWarning[], policies: ExceptionPolicies): AssignmentWarning[] {
  return warnings.filter((w) => policyOf(w, policies) === 'approve');
}

/** One warning is another: the same rule, about the same driver or vehicle, and the same trip still under way. */
function sameWarning(a: AssignmentWarning, b: AssignmentWarning): boolean {
  if (a.warning !== b.warning || a.field !== b.field) return false;
  return a.warning === 'PREVIOUS_TRIP_OVERRUN' && b.warning === 'PREVIOUS_TRIP_OVERRUN' ? a.trip_id === b.trip_id : true;
}

/** The held warnings an approval of `approved` does not cover: an approval covers that trip and those warnings only. */
export function uncovered(held: readonly AssignmentWarning[], approved: readonly AssignmentWarning[]): AssignmentWarning[] {
  return held.filter((w) => !approved.some((a) => sameWarning(w, a)));
}

/** An assignment held for approval, as the API returns it. Public ids. */
export interface AssignmentExceptionView {
  id: string;
  trip_id: string;
  status: ExceptionStatus;
  driver_id: string;
  vehicle_id: string;
  warnings: AssignmentWarning[];
  /** Why the dispatcher asks. */
  reason: string;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: Date;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  /** Why it was refused (required), or a note with an approval. */
  decision_reason: string | null;
}

/** How each warning is named in an error's details. */
const detailOf = (w: AssignmentWarning) =>
  w.warning === 'DRIVER_ATTENDANCE'
    ? { field: w.field, reason: `driver_${w.attendance}` }
    : { field: w.field, reason: 'previous_trip_overrun', record_id: w.trip_id };

/** The assignment raises a warning the depot holds: ask again with a reason, and a fleet manager decides. */
export const approvalRequired = (held: readonly AssignmentWarning[]) =>
  new AppError(
    409,
    'CONFLICT_APPROVAL_REQUIRED',
    'This assignment needs a fleet manager’s approval. Give a reason and it is sent to them.',
    held.map(detailOf),
  );

/** At approval the trip raises a warning the request did not ask about: refuse it, and the dispatcher asks again. */
export const exceptionOutdated = (held: readonly AssignmentWarning[]) =>
  new AppError(
    409,
    'CONFLICT_APPROVAL_REQUIRED',
    'The trip now raises a warning this request did not ask about. Refuse it; the dispatcher can ask again.',
    held.map(detailOf),
  );

export const exceptionNotFound = () => new AppError(404, 'NOT_FOUND', 'Exception request not found.');

export const exceptionDecided = (status: ExceptionStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `This request is already ${status}.`, [{ field: 'status', reason: `exception_${status}` }]);

/** Someone else decides: a request is never approved by the one who made it. */
export const ownRequest = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Another fleet manager decides on a request you made.', [{ field: 'exception_id', reason: 'own_request' }]);

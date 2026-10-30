import { AppError } from '../../../shared/errors/app-error';

/** fuel.anomaly_status. Open and reviewed anomalies still need someone; dismissed and resolved ones are closed. */
export const ANOMALY_STATUSES = ['open', 'reviewed', 'dismissed', 'resolved'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

/** How a person closes an anomaly (FMS-42): it was real and dealt with, or it was not a problem. */
export const ANOMALY_OUTCOMES = ['resolved', 'dismissed'] as const;
export type AnomalyOutcome = (typeof ANOMALY_OUTCOMES)[number];

export const MAX_NOTES = 2000;

/** A fuel anomaly as the API returns it (api-contract §9.1). Public ids; integers; the vehicle and depot named. */
export interface FuelAnomalyView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  depot_id: string;
  depot_name: string;
  /** The fill-up a per-event rule flagged (FMS-82); null for a month's reconciliation (FMS-41). */
  fuel_log_id: string | null;
  anomaly_type: string;
  severity: string;
  status: AnomalyStatus;
  /** The period a reconciliation judged, [from, to); null for a fill-up. */
  period_from: Date | null;
  period_to: Date | null;
  distance_km: number | null;
  expected_ml: number | null;
  actual_ml: number | null;
  deviation_pct: number | null;
  detected_at: Date;
  /** Who closed it, and when: the user's public id and name. */
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  notes: string | null;
}

export const anomalyNotFound = () => new AppError(404, 'NOT_FOUND', 'Fuel anomaly not found.');

export const anomalyClosed = (status: AnomalyStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `The anomaly is already ${status}.`, [{ field: 'status', reason: 'already_closed' }]);

export const notesRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Say why the anomaly is dismissed.', [{ field: 'notes', reason: 'required_to_dismiss' }]);

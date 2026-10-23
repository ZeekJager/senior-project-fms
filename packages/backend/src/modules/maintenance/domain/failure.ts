import { AppError } from '../../../shared/errors/app-error';

/** As in maintenance.failure_component, failure_mode and failure_detection (migration 036, docs/maintenance.md). */
export const FAILURE_COMPONENTS = [
  'engine',
  'cooling',
  'brakes',
  'tyres',
  'transmission',
  'electrical',
  'suspension',
  'steering',
  'fuel_system',
  'exhaust',
  'body',
  'other',
] as const;
export const FAILURE_MODES = ['wear', 'leak', 'overheating', 'electrical_fault', 'breakage', 'puncture', 'other'] as const;
export const FAILURE_DETECTIONS = ['driver_report', 'dvir', 'technician', 'telematics', 'breakdown'] as const;

export type FailureComponent = (typeof FAILURE_COMPONENTS)[number];
export type FailureMode = (typeof FAILURE_MODES)[number];
export type FailureDetection = (typeof FAILURE_DETECTIONS)[number];

/** At most this many failures in one request: a repair with more is a fleet of repairs. */
export const MAX_FAILURES_PER_REQUEST = 10;

/** One failure as the API takes it (POST .../failures, and `failures` on create and complete). */
export interface FailureInput {
  component: FailureComponent;
  failure_mode: FailureMode;
  unplanned: boolean;
  detected_by?: FailureDetection;
  /** When it failed; the repair's opening when not sent. */
  occurred_at?: string;
  /** The repair's odometer when not sent. */
  odometer_km?: number | null;
  /** The incident that reported it: the same vehicle's, in scope. */
  incident_id?: string | null;
  notes?: string | null;
}

/** A failure event as the API returns it. Public ids only. */
export interface FailureEventView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  maintenance_record_id: string | null;
  incident_id: string | null;
  component: FailureComponent;
  failure_mode: FailureMode;
  unplanned: boolean;
  detected_by: FailureDetection;
  occurred_at: Date;
  odometer_km: number | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: Date;
}

export const FAILURE_EVENTS = {
  recorded: 'FailureRecorded',
} as const;

export const failureRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Say what failed before completing a corrective repair.', [{ field: 'failures', reason: 'failure_required' }]);

export const failureInFuture = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'A failure cannot happen in the future.', [{ field, reason: 'in_future' }]);

export const failureIncidentNotFound = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'The incident does not exist or is outside your depots.', [{ field, reason: 'references_missing_record' }]);

export const failureIncidentOtherVehicle = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'The incident is about another vehicle.', [{ field, reason: 'incident_other_vehicle' }]);

export const failureOnCancelled = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'The repair was cancelled: it found no failure to record.');

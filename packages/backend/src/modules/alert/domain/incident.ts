import { AppError } from '../../../shared/errors/app-error';
import type { AlertSeverity } from './alert';

// Incident reports (FMS-38, api-contract §12.2): what a driver (or staff) saw happen on the road,
// recorded as soon as they report it. A critical one sets the vehicle's maintenance flag in the same
// transaction and becomes an alert (FMS-92); every one reaches the command center live.

/** What happened. `other` is the default (api-contract §12.2). */
export const INCIDENT_TYPES = ['accident', 'breakdown', 'tyre', 'theft', 'vandalism', 'injury', 'road_hazard', 'other'] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_STATUSES = ['open', 'investigating', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The severity that flags the vehicle for maintenance and raises an alert. */
export const CRITICAL: AlertSeverity = 'critical';

/** An incident is stamped with when it happened; an offline queue may deliver it late, but not by more than this. */
export const MAX_REPORT_AGE_DAYS = 30;
/** Phones' clocks drift: a time this far ahead of the server is still believed. */
export const CLOCK_SKEW_MS = 5 * 60_000;

export const INCIDENT_EVENTS = {
  /**
   * A new incident. The real-time gateway forwards it as `incident.created`; the alert engine raises an
   * alert for a critical one; fleet drops the cached vehicle (its maintenance flag may have changed).
   */
  reported: 'IncidentReported',
} as const;

/** An incident as the API returns it (api-contract §12.2). Public ids only. */
export interface IncidentView {
  id: string;
  incident_type: string;
  severity: AlertSeverity;
  status: IncidentStatus;
  description: string;
  vehicle_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  depot_id: string | null;
  /** The user who reported it. */
  reported_by: string;
  latitude: number | null;
  longitude: number | null;
  occurred_at: Date;
  created_at: Date;
}

export const incidentNotFound = () => new AppError(404, 'NOT_FOUND', 'Incident not found.');

export const incidentVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is outside your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const incidentVehicleRetired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle has been retired: report the incident without it, or name the vehicle in use.', [
    { field: 'vehicle_id', reason: 'vehicle_retired' },
  ]);

export const incidentTripNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip does not exist or is not yours to see.', [{ field: 'trip_id', reason: 'references_missing_record' }]);

export const incidentTripVehicleMismatch = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The trip is assigned to a different vehicle.', [{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]);

export const incidentDriverNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The driver does not exist or is outside your depots.', [{ field: 'driver_id', reason: 'references_missing_record' }]);

/** A driver reports as themselves. */
export const incidentDriverNotWritable = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A driver reports as themselves: leave driver_id out.', [{ field: 'driver_id', reason: 'not_writable' }]);

export const incidentInFuture = () => new AppError(400, 'VALIDATION_FAILED', 'occurred_at cannot be in the future.', [{ field: 'occurred_at', reason: 'in_future' }]);

export const incidentTooOld = () =>
  new AppError(400, 'VALIDATION_FAILED', `occurred_at cannot be more than ${MAX_REPORT_AGE_DAYS} days ago.`, [{ field: 'occurred_at', reason: 'too_old' }]);

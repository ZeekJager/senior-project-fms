import { AppError } from '../../../shared/errors/app-error';

/**
 * EV fleet management (FMS-96, architecture §13, docs/ev.md): electric vehicles' battery state, their charging sessions
 * and the charging stations. Tables in the ev schema (migration 009).
 */

/** A charging session's life (ev.charging_status): planned, then under way, then done one way or another. */
export const SESSION_STATUSES = ['planned', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Where a session may go from each status. completed, failed and cancelled are final. */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const isFinal = (status: SessionStatus) => SESSION_TRANSITIONS[status].length === 0;
export const canMove = (from: SessionStatus, to: SessionStatus) => SESSION_TRANSITIONS[from].includes(to);

/**
 * Where a record came from (ev.*.source, migration 084): typed through the API, a charging provider's webhook, or
 * fabricated (the generator and the simulated charging provider, FMS-97: there is no real EV data source, decision
 * D-06). The screens badge synthetic records. A caller may write manual or synthetic; provider is the webhook's.
 */
export const RECORD_SOURCES = ['manual', 'provider', 'synthetic'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];
export const WRITABLE_SOURCES = ['manual', 'synthetic'] as const;

/** Days the battery summary's trend covers by default, and at most. */
export const SUMMARY_DAYS_DEFAULT = 30;
export const SUMMARY_DAYS_MAX = 365;

export const EV_EVENTS = {
  /** A battery observation was recorded. */
  batteryLogged: 'BatteryLogged',
  /** A session started charging. */
  sessionStarted: 'ChargingSessionStarted',
  /** A session finished charging: its energy, cost and end state of charge. */
  sessionCompleted: 'ChargingSessionCompleted',
  /** A session stopped without charging fully (the charger, the connector, the vehicle). */
  sessionFailed: 'ChargingSessionFailed',
} as const;

/** How far along its life a status is: a provider's delivery only ever moves a session forward (FMS-97). */
export const SESSION_STAGE: Readonly<Record<SessionStatus, number>> = { planned: 0, in_progress: 1, completed: 2, failed: 2, cancelled: 2 };

export interface BatteryLogView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  state_of_charge: number;
  battery_health: number | null;
  battery_temperature_c: number | null;
  voltage_v: number | null;
  current_a: number | null;
  estimated_range_km: number | null;
  energy_wh_per_km: number | null;
  source: RecordSource;
  recorded_at: Date;
}

export interface StationView {
  id: string;
  name: string;
  external_station_id: string;
  latitude: number | null;
  longitude: number | null;
  connector_type: string | null;
  power_kw: number | null;
  status: string;
  source: RecordSource;
}

export interface SessionView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  station: { id: string; name: string } | null;
  status: SessionStatus;
  allowed_transitions: SessionStatus[];
  started_at: Date | null;
  ended_at: Date | null;
  energy_kwh: number | null;
  cost_cents: number | null;
  start_soc: number | null;
  end_soc: number | null;
  external_session_id: string | null;
  source: RecordSource;
  created_at: Date;
  updated_at: Date;
}

export interface BatterySummary {
  vehicle_id: string;
  registration_number: string;
  days: number;
  /** The newest observation, or null when none was recorded. */
  latest: { state_of_charge: number; battery_health: number | null; estimated_range_km: number | null; recorded_at: Date } | null;
  /** One point a day (Addis Ababa) with observations, oldest first. */
  soc_trend: { day: string; average: number; minimum: number; maximum: number; readings: number }[];
  /** Battery health (state of health, %): the newest, the first in the period, and the change between them. */
  health: { current: number | null; at_start: number | null; change: number | null };
  /** Sessions completed in the period: how many, the energy taken and what it cost. */
  charging: { sessions_completed: number; energy_kwh: number; cost_cents: number };
}

/**
 * One electric vehicle on the EV dashboard (FMS-99, GET /ev/fleet): its newest battery reading and the session
 * charging it now. The list comes lowest charge first, vehicles with no reading last.
 */
export interface EvFleetVehicle {
  vehicle_id: string;
  registration_number: string;
  make: string;
  model: string;
  depot: { id: string; name: string } | null;
  latest: { state_of_charge: number; battery_health: number | null; estimated_range_km: number | null; recorded_at: Date; source: RecordSource } | null;
  charging: { id: string; station: { id: string; name: string } | null; started_at: Date | null; start_soc: number | null; source: RecordSource } | null;
}

/** Lowest state of charge first; no reading last; then by plate. */
export function byChargeAscending(a: EvFleetVehicle, b: EvFleetVehicle): number {
  const sa = a.latest?.state_of_charge ?? Number.POSITIVE_INFINITY;
  const sb = b.latest?.state_of_charge ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.registration_number.localeCompare(b.registration_number);
}

export const notElectric = (field = 'vehicle_id') =>
  new AppError(400, 'VALIDATION_FAILED', 'Only an electric vehicle has a battery to log or charge.', [{ field, reason: 'not_electric' }]);

export const evVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is not in your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const evVehicleRetired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired vehicle takes no battery logs or charging sessions.', [{ field: 'vehicle_id', reason: 'vehicle_retired' }]);

/** A vehicle's own page (its sessions, its summary) outside the caller's depots, or not there. */
export const evVehicleMissing = () => new AppError(404, 'NOT_FOUND', 'Vehicle not found.');

export const stationNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The charging station does not exist.', [{ field: 'station_id', reason: 'references_missing_record' }]);

export const sessionNotFound = () => new AppError(404, 'NOT_FOUND', 'Charging session not found.');

export const illegalTransition = (from: SessionStatus, to: SessionStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A ${from.replace('_', ' ')} session cannot become ${to.replace('_', ' ')}.`, [
    { field: 'status', reason: `${from}_to_${to}`, allowed_transitions: [...SESSION_TRANSITIONS[from]] },
  ]);

export const sessionFinal = (status: SessionStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `A ${status} session cannot be changed.`, [{ field: 'status', reason: status, allowed_transitions: [] }]);

export const alreadyCharging = (sessionId: string) =>
  new AppError(409, 'CONFLICT_VEHICLE_IN_USE', 'The vehicle is already charging in another session.', [{ field: 'vehicle_id', reason: 'already_charging', record_id: sessionId }]);

export const sessionDateRange = () =>
  new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', 'A session ends after it starts.', [{ field: 'ended_at', reason: 'before_start' }]);

export const duplicateExternalSession = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'A session with this provider id already exists.', [{ field: 'external_session_id', reason: 'duplicate' }]);

import { AppError } from '../../../shared/errors/app-error';

// Preventive service programs (FMS-129, docs/service-programs.md): a schedule of preventive service by
// distance, time and engine hours, whichever comes first, and each vehicle's service due under it.

/** The measures a program counts in. */
export const SERVICE_MEASURES = ['km', 'days', 'engine_hours'] as const;
export type ServiceMeasure = (typeof SERVICE_MEASURES)[number];

/** As in maintenance.service_due_status, least urgent first. */
export const SERVICE_DUE_STATUSES = ['upcoming', 'due', 'overdue'] as const;
export type ServiceDueStatus = (typeof SERVICE_DUE_STATUSES)[number];

/** As in shared.vehicle_type and shared.fuel_type. */
export const PROGRAM_VEHICLE_TYPES = ['car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other'] as const;
export const PROGRAM_FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const;
export type ProgramVehicleType = (typeof PROGRAM_VEHICLE_TYPES)[number];
export type ProgramFuelType = (typeof PROGRAM_FUEL_TYPES)[number];

export const MAX_PROGRAM_TASKS = 30;
export const MAX_TASK_LENGTH = 200;
/** Interval ceilings: a program past these is a typo (a million km, ten years, 100,000 engine hours). */
export const MAX_INTERVAL = { km: 1_000_000, days: 3650, engine_hours: 100_000 } as const;
/** A lead window left out is a tenth of its interval, rounded: due 1,000 km before a 10,000 km service. */
export const DEFAULT_LEAD_SHARE = 0.1;

export const defaultLead = (interval: number): number => Math.min(Math.round(interval * DEFAULT_LEAD_SHARE), interval - 1);

export const SERVICE_DUE_EVENTS = {
  /** A vehicle's service under a program came within its lead window. */
  due: 'ServiceDue',
  /** A vehicle's service under a program passed its interval. */
  overdue: 'ServiceOverdue',
} as const;

/** What a program asks of a vehicle: an interval and its lead window per measure, null when it does not count it. */
export interface ProgramIntervals {
  intervalKm: number | null;
  leadKm: number | null;
  intervalDays: number | null;
  leadDays: number | null;
  intervalEngineHours: number | null;
  leadEngineHours: number | null;
}

/** Which vehicles a program covers: null matches any. */
export interface ProgramMatch {
  depotId: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  make: string | null;
  model: string | null;
}

/** A vehicle as a program is matched against it. */
export interface MatchedVehicle {
  depotId: string;
  vehicleType: string;
  fuelType: string;
  make: string;
  model: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether a program covers a vehicle: its depot (or every depot), and each of type, fuel, make and model it names. */
export function programApplies(p: ProgramMatch, v: MatchedVehicle): boolean {
  return (
    (p.depotId === null || p.depotId === v.depotId) &&
    (p.vehicleType === null || p.vehicleType === v.vehicleType) &&
    (p.fuelType === null || p.fuelType === v.fuelType) &&
    (p.make === null || same(p.make, v.make)) &&
    (p.model === null || same(p.model, v.model))
  );
}

/** What the count starts from: the last service under the program, or the vehicle's first reading. */
export interface DueSince {
  at: Date;
  km: number;
  /** Engine hours then; null: no engine-hour reading yet, which counts as 0 (they count from the first reading). */
  engineHours: number | null;
}

export interface DueReadings {
  now: Date;
  odometerKm: number;
  /** Null: the vehicle has no engine-hour reading, so the hours are not judged. */
  engineHours: number | null;
}

export interface DueResult {
  nextDueKm: number | null;
  nextDueAt: Date | null;
  /** Null when the program does not count hours, or the vehicle has none to count. */
  nextDueEngineHours: number | null;
  /** Engine hours at the start of the count, as judged (0 before the first reading). */
  sinceEngineHours: number | null;
  status: ServiceDueStatus;
  /** The measures that put it at its status (none while upcoming). */
  dueBy: ServiceMeasure[];
}

const DAY_MS = 86_400_000;
const rank = (s: ServiceDueStatus) => SERVICE_DUE_STATUSES.indexOf(s);
const round1 = (n: number) => Math.round(n * 10) / 10;

function measure(current: number, next: number, lead: number): ServiceDueStatus {
  if (current >= next) return 'overdue';
  return current >= next - lead ? 'due' : 'upcoming';
}

/**
 * Whichever comes first (FMS-129): each measure the program counts falls due its interval after the
 * count started, and is due from its lead window before that. The service is as urgent as its most
 * urgent measure. A vehicle without engine-hour readings is judged on its other measures only.
 */
export function computeDue(p: ProgramIntervals, since: DueSince, now: DueReadings): DueResult {
  const statuses: [ServiceMeasure, ServiceDueStatus][] = [];
  let nextDueKm: number | null = null;
  let nextDueAt: Date | null = null;
  let nextDueEngineHours: number | null = null;
  let sinceEngineHours: number | null = null;

  if (p.intervalKm !== null) {
    nextDueKm = round1(since.km + p.intervalKm);
    statuses.push(['km', measure(now.odometerKm, nextDueKm, p.leadKm ?? 0)]);
  }
  if (p.intervalDays !== null) {
    nextDueAt = new Date(since.at.getTime() + p.intervalDays * DAY_MS);
    statuses.push(['days', measure(now.now.getTime(), nextDueAt.getTime(), (p.leadDays ?? 0) * DAY_MS)]);
  }
  if (p.intervalEngineHours !== null && now.engineHours !== null) {
    sinceEngineHours = since.engineHours ?? 0;
    nextDueEngineHours = round1(sinceEngineHours + p.intervalEngineHours);
    statuses.push(['engine_hours', measure(now.engineHours, nextDueEngineHours, p.leadEngineHours ?? 0)]);
  }

  const status = statuses.reduce<ServiceDueStatus>((worst, [, s]) => (rank(s) > rank(worst) ? s : worst), 'upcoming');
  const dueBy = status === 'upcoming' ? [] : statuses.filter(([, s]) => s === status).map(([m]) => m);
  return { nextDueKm, nextDueAt, nextDueEngineHours, sinceEngineHours, status, dueBy };
}

/** Whether moving from one status to another is news: into due or overdue from anything less urgent. */
export function transitionEvent(previous: ServiceDueStatus | null, next: ServiceDueStatus): string | null {
  if (next === 'upcoming' || (previous !== null && rank(previous) >= rank(next))) return null;
  return next === 'overdue' ? SERVICE_DUE_EVENTS.overdue : SERVICE_DUE_EVENTS.due;
}

/** A program as the API returns it (api-contract §10.5). Public ids only. */
export interface ServiceProgramView {
  id: string;
  name: string;
  description: string | null;
  /** Null: fleet-wide. */
  depot_id: string | null;
  vehicle_type: ProgramVehicleType | null;
  fuel_type: ProgramFuelType | null;
  make: string | null;
  model: string | null;
  interval_km: number | null;
  lead_km: number | null;
  interval_days: number | null;
  lead_days: number | null;
  interval_engine_hours: number | null;
  lead_engine_hours: number | null;
  tasks: string[];
  is_active: boolean;
  /** The caller's vehicles it applies to, by status, as last computed. */
  vehicles: { total: number; upcoming: number; due: number; overdue: number };
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** One vehicle's service under one program (api-contract §10.5, `ServiceDue`). */
export interface ServiceDueView {
  vehicle_id: string;
  registration_number: string;
  depot_id: string;
  program: { id: string; name: string; tasks: string[] };
  status: ServiceDueStatus;
  due_by: ServiceMeasure[];
  /** The completed repair the count starts from; null: none on record, counted from the vehicle's first reading. */
  last_service: { maintenance_record_id: string; completed_at: Date } | null;
  since: { at: Date; odometer_km: number; engine_hours: number | null };
  next_due: { odometer_km: number | null; at: Date | null; engine_hours: number | null };
  /** The readings it was judged on. */
  readings: { odometer_km: number; engine_hours: number | null };
  /** How far to go until it falls due: negative when overdue. Days from now, km and hours from the readings. */
  remaining: { km: number | null; days: number | null; engine_hours: number | null };
  /** Open preventive work for this program on the vehicle, if any is booked. */
  open_record: { id: string; status: string; scheduled_at: Date | null } | null;
  status_changed_at: Date;
  computed_at: Date;
}

export const programNotFound = () => new AppError(404, 'NOT_FOUND', 'Service program not found.');

export const programNameTaken = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'An active program of that name already applies here.', [{ field: 'name', reason: 'duplicate' }]);

export const programDepotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist or is outside your depots.', [{ field: 'depot_id', reason: 'references_missing_record' }]);

/** A depot-scoped user's programs are their depot's: fleet-wide ones are set by those who see every depot. */
export const fleetWideNotAllowed = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only a user who sees every depot can define or change a fleet-wide program.', [
    { field: 'depot_id', reason: 'fleet_wide_not_allowed' },
  ]);

export const intervalRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Give at least one interval: kilometres, days or engine hours.', [
    { field: 'interval_km', reason: 'interval_required' },
  ]);

export const leadNotBelowInterval = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'The lead window must be smaller than its interval.', [{ field, reason: 'not_below_interval' }]);

export const leadWithoutInterval = (field: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'A lead window needs its interval.', [{ field, reason: 'interval_missing' }]);

export const modelNeedsMake = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Name the make as well as the model.', [{ field: 'make', reason: 'required' }]);

/** A repair's program (POST and PATCH /maintenance): not one that exists, is active and is in scope. */
export const recordProgramNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The service program does not exist or is retired.', [
    { field: 'service_program_id', reason: 'references_missing_record' },
  ]);

export const recordProgramNotApplicable = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The service program does not apply to this vehicle.', [
    { field: 'service_program_id', reason: 'program_not_applicable' },
  ]);

export const recordProgramNeedsPreventive = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Only preventive work carries out a service program.', [
    { field: 'service_program_id', reason: 'needs_preventive' },
  ]);

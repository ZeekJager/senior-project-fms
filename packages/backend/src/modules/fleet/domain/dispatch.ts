import type { AttendanceStatus } from './attendance';
import { result, type AvailabilityResult } from './availability';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { VehicleStatus, VehicleType } from './vehicle';

export { drivableTypes } from './licence';

/**
 * The dispatcher's board (FMS-33, S-07): each driver and vehicle of a depot
 * with one state for its colour, and its availability for the trip being
 * staffed. The state is about now; `availability` is about the trip's window.
 */

/** A trip under way that ends within this many minutes (or is already late) is "near its end". */
export const NEAR_END_MINUTES = 30;

/**
 * Drivers: green `idle` (present, or not yet marked, and free); amber
 * `near_end` (under way, finishing within NEAR_END_MINUTES or late); red
 * `en_route`; grey `absent` (absent, on leave or sick today: a warning, they
 * can still be assigned); `unavailable` when blocked for the trip's window
 * (another trip then, licence expired, account not active).
 */
export type DriverBoardState = 'idle' | 'near_end' | 'en_route' | 'absent' | 'unavailable';

/**
 * Vehicles: green `idle`; red `flagged` (maintenance flag, or in the
 * workshop); grey `en_route`; `unavailable` when blocked for the trip's
 * window (another trip then, out of service).
 */
export type VehicleBoardState = 'idle' | 'flagged' | 'en_route' | 'unavailable';

/** A trip a driver or vehicle is on now, as fleet's read model holds it. */
export interface BoardTrip {
  tripId: string;
  /** Its scheduled end. */
  end: Date;
}

const ABSENT: readonly AttendanceStatus[] = ['absent', 'on_leave', 'sick'];

export function driverBoardState(f: { underWay: BoardTrip | null; attendance: AttendanceStatus | null; availability: AvailabilityResult; now: Date }): DriverBoardState {
  if (f.underWay) return f.underWay.end.getTime() - f.now.getTime() <= NEAR_END_MINUTES * 60_000 ? 'near_end' : 'en_route';
  if (f.attendance && ABSENT.includes(f.attendance)) return 'absent';
  if (f.availability.availability === 'unavailable') return 'unavailable';
  return 'idle';
}

export function vehicleBoardState(f: { status: VehicleStatus; maintenanceFlag: boolean; underWay: BoardTrip | null; availability: AvailabilityResult }): VehicleBoardState {
  if (f.maintenanceFlag || f.status === 'maintenance') return 'flagged';
  if (f.underWay) return 'en_route';
  if (f.availability.availability === 'unavailable') return 'unavailable';
  return 'idle';
}

/** The open maintenance work behind a flag, as much as dispatch needs to see (it holds no maintenance:read). */
export interface OpenWorkSummary {
  id: string;
  description: string;
  status: string;
  priority: string;
  opened_at: Date;
}

/**
 * A vehicle's preventive service due or overdue (FMS-129): a warning on the board, never a block. The
 * vehicle's most urgent status, and each program at it or below.
 */
export interface ServiceDueSummary {
  status: 'due' | 'overdue';
  programs: { program_id: string; name: string; status: 'due' | 'overdue'; due_by: string[] }[];
}

/**
 * The trip risk model's chances for one available driver on the trip being staffed (FMS-155, docs/ml-trip-risk.md),
 * and the two inputs that raise each most, with their values. Advice for one trip: never a block or a ranking of people.
 */
export interface DriverTripRisk {
  late_probability: number;
  safety_event_probability: number;
  factors: { late: { feature: string; value: number }[]; safety_event: { feature: string; value: number }[] };
}

/** Whether the board carries the model's chances, and why not (FMS-155): the analytics module's TripRiskSummary. */
export interface BoardTripRisk {
  status: 'ok' | 'not_enough_trips' | 'off' | 'unavailable';
  reason: string | null;
  model_version: string | null;
  demonstration: boolean;
  trips: number;
  drivers: number;
  minimum: { trips: number; drivers: number };
}

/** The trip risk model, as the board asks it; connected by src/modules/index.ts (the analytics module's tripRisk). */
export interface TripRiskProvider {
  forTrip(tripPublicId: string, driverPublicIds: readonly string[], correlationId: string): Promise<{ summary: BoardTripRisk; drivers: Map<string, DriverTripRisk> }>;
}

/** Who sees the model's chances: as the driver score (FMS-146), behavioural data. */
export const TRIP_RISK_PERMISSION = 'tracking:read';

/** One period of a driver's load-weighted distance with the trip being staffed (FMS-156): the trip module's PeriodStanding. */
export interface BoardDistancePeriod {
  period: 'day' | 'week';
  limit_km: number;
  without_km: number;
  with_km: number;
  /** Left of the limit with the trip; negative when over. */
  left_km: number;
}

/** Where a driver stands against the distance limits on the trip being staffed (FMS-156). */
export interface BoardDistance {
  /** The trip's own load-weighted km. */
  trip_km: number;
  day: BoardDistancePeriod;
  week: BoardDistancePeriod;
  over: BoardDistancePeriod | null;
  near: BoardDistancePeriod | null;
}

/** The distance limits, as the board asks them: the trip module's tripDistanceLimits.forBoard (driver internal ids). */
export type DistanceProvider = (db: Queryable, tripPublicId: string, driverIds: readonly string[]) => Promise<Map<string, BoardDistance> | null>;

/**
 * A driver's availability with the distance limits (FMS-156): past one, unavailable for the trip (a block, as the
 * assignment refuses it); at 80% of one, a warning. Under way or not, the board shows it: the rule decides assignments.
 */
export function withDistance(availability: AvailabilityResult, distance: BoardDistance | null): AvailabilityResult {
  if (!distance) return availability;
  const p = distance.over ?? distance.near;
  if (!p) return availability;
  const reason = { code: distance.over ? ('distance_limit' as const) : ('distance_limit_near' as const), severity: distance.over ? ('block' as const) : ('warning' as const), period: p.period, limit_km: p.limit_km, total_km: p.with_km };
  return result([...availability.reasons, reason]);
}

export interface BoardDriver {
  driver_id: string;
  full_name: string;
  license_categories: string[];
  /** The vehicle types the licence covers. */
  vehicle_types: VehicleType[];
  state: DriverBoardState;
  /** Attendance on the window's first day, if marked. */
  attendance: AttendanceStatus | null;
  availability: AvailabilityResult;
  /** The trip under way now, if any. */
  current_trip: { trip_id: string; end: Date } | null;
  /**
   * The trip risk model's chances on the trip being staffed (FMS-155): with `exclude_trip_id`, `tracking:read`, an active
   * model, and the driver free for the trip. Null otherwise.
   */
  trip_risk: DriverTripRisk | null;
  /** With `exclude_trip_id` (FMS-156): the driver's load-weighted km in the trip's day and week with it, and what is left. Null otherwise. */
  distance: BoardDistance | null;
}

export interface BoardVehicle {
  vehicle_id: string;
  registration_number: string;
  make: string;
  model: string;
  vehicle_type: VehicleType;
  status: VehicleStatus;
  state: VehicleBoardState;
  availability: AvailabilityResult;
  /** The open work behind the flag, when flagged. */
  open_work: OpenWorkSummary | null;
  /** Preventive service due or overdue (FMS-129); null when none is. */
  service_due: ServiceDueSummary | null;
  current_trip: { trip_id: string; end: Date } | null;
}

export interface DispatchBoard {
  depot_id: string;
  window: { start: Date; end: Date };
  /** With a trip and `tracking:read` (FMS-155): whether the drivers carry the model's chances, and why not. Null otherwise. */
  trip_risk: BoardTripRisk | null;
  drivers: BoardDriver[];
  vehicles: BoardVehicle[];
}

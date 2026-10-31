import type { AttendanceStatus } from './attendance';
import type { AvailabilityResult } from './availability';
import { LICENSE_CATEGORY_VEHICLE_TYPES, type LicenseCategory } from './driver';
import { VEHICLE_TYPES, type VehicleStatus, type VehicleType } from './vehicle';

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

/** The vehicle types a driver's licence categories cover, in VEHICLE_TYPES order: the console pairs drivers with vehicles they may drive. */
export function drivableTypes(categories: readonly string[]): VehicleType[] {
  const allowed = new Set(categories.flatMap((c) => (LICENSE_CATEGORY_VEHICLE_TYPES[c as LicenseCategory] as readonly VehicleType[] | undefined) ?? []));
  return VEHICLE_TYPES.filter((t) => allowed.has(t));
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
  drivers: BoardDriver[];
  vehicles: BoardVehicle[];
}

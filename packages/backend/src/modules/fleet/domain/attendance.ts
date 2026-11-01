import { AppError, validationFailed } from '../../../shared/errors/app-error';
import { OPERATING_TIME_ZONE, type LicenseStatus } from './driver';

/** As in chk_attendance_status. The attendance screen toggles the first three. */
export const ATTENDANCE_STATUSES = ['present', 'absent', 'on_leave', 'late', 'sick', 'other'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Statuses that can be planned ahead; the others describe a day that has come. */
const PLANNABLE: readonly AttendanceStatus[] = ['on_leave', 'other'];

/** How far ahead leave can be recorded. */
export const MAX_DAYS_AHEAD = 60;

/** How a check-in or check-out was recorded (FMS-141): the driver scanned the depot's code, or staff entered it. */
export const CHECK_METHODS = ['qr', 'manual'] as const;
export type CheckMethod = (typeof CHECK_METHODS)[number];

/** Statuses that make a driver a dispatch risk for the day (FMS-33 shows a warning, not a block). */
export const UNAVAILABLE_STATUSES: readonly AttendanceStatus[] = ['absent', 'on_leave', 'sick'];

/** One attendance record (fleet.driver_attendance), as the API returns it. */
export interface AttendanceView {
  id: string;
  driver_id: string;
  /** YYYY-MM-DD, the calendar day in Addis Ababa. */
  date: string;
  status: AttendanceStatus;
  notes: string | null;
  /** When the driver arrived and left (FMS-141), and how each was recorded. */
  check_in_at: Date | null;
  check_in_method: CheckMethod | null;
  check_out_at: Date | null;
  check_out_method: CheckMethod | null;
  /** Public id and name of whoever recorded it last. */
  logged_by: string;
  logged_by_name: string;
  created_at: Date;
  updated_at: Date;
}

/** One driver on the day's roster (GET /attendance?date=): their record, or null if not marked yet. */
export interface RosterEntry {
  driver_id: string;
  full_name: string;
  email: string;
  depot_id: string | null;
  license_status: LicenseStatus;
  date: string;
  attendance: Omit<AttendanceView, 'driver_id' | 'date'> | null;
}

export const ATTENDANCE_EVENTS = { recorded: 'AttendanceRecorded' } as const;

/** Today's date where the fleet operates, `YYYY-MM-DD`. */
export function operatingToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OPERATING_TIME_ZONE }).format(now);
}

/** Days from `from` to `to` (YYYY-MM-DD), without time-zone drift. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Presence is recorded for days that have come: today or earlier. Leave can
 * be booked up to MAX_DAYS_AHEAD days ahead.
 */
export function checkAttendanceDate(date: string, status: AttendanceStatus, today: string = operatingToday()): void {
  const ahead = daysBetween(today, date);
  if (ahead <= 0) return;
  if (!PLANNABLE.includes(status)) {
    throw validationFailed([{ field: 'date', reason: 'in_future' }], `${status} can only be recorded for today or an earlier day.`);
  }
  if (ahead > MAX_DAYS_AHEAD) {
    throw validationFailed([{ field: 'date', reason: 'too_far_ahead' }], `Leave can be recorded at most ${MAX_DAYS_AHEAD} days ahead.`);
  }
}

/** A clock may run a little fast: a time this far ahead of the server is still now. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Check-in and check-out times entered by hand (FMS-141): on the record's day in Addis Ababa, not in the
 * future, a check-out only after a check-in and not before it.
 */
export function checkManualTimes(date: string, times: { in: Date | null; out: Date | null }, now: Date = new Date()): void {
  for (const [field, at] of [
    ['check_in_at', times.in],
    ['check_out_at', times.out],
  ] as const) {
    if (!at) continue;
    if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) throw validationFailed([{ field, reason: 'in_future' }], 'A check-in or check-out time cannot be in the future.');
    if (operatingToday(at) !== date) throw validationFailed([{ field, reason: 'not_on_date' }], `The time must be on ${date} (Addis Ababa).`);
  }
  if (times.out && !times.in) throw validationFailed([{ field: 'check_out_at', reason: 'without_check_in' }], 'A check-out needs a check-in first.');
  if (times.out && times.in && times.out < times.in) throw validationFailed([{ field: 'check_out_at', reason: 'before_check_in' }], 'The check-out is before the check-in.');
}

/** A driver records their arrival by scanning at the depot, never by typing a time (FMS-141). */
export const timesByScanOnly = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Check in and out by scanning the depot code; times are not entered by hand.', [
    { field: 'check_in_at', reason: 'scan_only' },
  ]);

export const attendanceNotFound = () => new AppError(404, 'NOT_FOUND', 'Attendance record not found.');

export const attendanceDriverNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The driver does not exist or is outside your depots.', [
    { field: 'driver_id', reason: 'references_missing_record' },
  ]);

export const attendanceDriverRetired = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A retired driver has no attendance to record.');

export const attendanceDuplicate = () =>
  new AppError(409, 'CONFLICT_ATTENDANCE_DUPLICATE', 'Attendance is already recorded for this driver and day. Update it with PUT /attendance/{id}.', [
    { field: 'date', reason: 'already_exists' },
  ]);

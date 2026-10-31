// The depot's attendance code (FMS-141, docs/attendance-check-in.md): what the depot screen shows as a QR and a
// driver's phone scans to check in or out. HMAC-signed, naming the depot and a 30-second window; good for 60 s.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../shared/errors/app-error';
import { OPERATING_TIME_ZONE } from './driver';

/** The screen shows a new code every window. */
export const CODE_WINDOW_SECONDS = 30;
/** A code is accepted until this long after its window began: the window it was shown in and the next. */
export const CODE_VALID_SECONDS = 60;
/** A second scan sooner than this after checking in is the same scan again, not a check-out. */
export const CHECK_OUT_AFTER_MINUTES = 10;

const PREFIX = 'FMSA1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The signing key, derived from the JWT secret so a deployment needs no new secret; changing either voids every code. */
export const attendanceCodeKey = (jwtSecret: string): Buffer => createHmac('sha256', jwtSecret).update('fms:attendance-code:v1').digest();

const signature = (key: Buffer, depotId: string, window: number) =>
  createHmac('sha256', key).update(`${PREFIX}|${depotId}|${window}`).digest().subarray(0, 16).toString('base64url');

const windowOf = (at: Date) => Math.floor(at.getTime() / (CODE_WINDOW_SECONDS * 1000));

/** A code as GET /attendance/qr returns it. */
export interface AttendanceCode {
  code: string;
  /** When this code's window began; show the next from `refresh_at`. */
  issued_at: Date;
  refresh_at: Date;
  /** The last moment a scan of it is accepted. */
  expires_at: Date;
}

/** The depot's code (public id) for the window `now` falls in. */
export function issueCode(key: Buffer, depotPublicId: string, now: Date): AttendanceCode {
  const window = windowOf(now);
  const start = window * CODE_WINDOW_SECONDS * 1000;
  return {
    code: `${PREFIX}.${depotPublicId}.${window}.${signature(key, depotPublicId, window)}`,
    issued_at: new Date(start),
    refresh_at: new Date(start + CODE_WINDOW_SECONDS * 1000),
    expires_at: new Date(start + CODE_VALID_SECONDS * 1000),
  };
}

/**
 * The depot (public id) a scanned code names. Refused: anything that is not a code this server signed (400
 * `invalid`), and a code more than CODE_VALID_SECONDS past its window's start, or from a window not yet begun
 * (400 `expired`).
 */
export function readCode(key: Buffer, code: string, now: Date): { depotPublicId: string } {
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX || !UUID.test(parts[1]) || !/^\d{1,12}$/.test(parts[2])) throw codeInvalid();
  const [, depotPublicId, w, sig] = parts;
  const window = Number(w);
  const expected = Buffer.from(signature(key, depotPublicId, window));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw codeInvalid();
  const age = now.getTime() - window * CODE_WINDOW_SECONDS * 1000;
  if (age < 0 || age > CODE_VALID_SECONDS * 1000) throw codeExpired();
  return { depotPublicId };
}

/** Minutes since midnight of an instant, in Addis Ababa. */
function localMinutes(at: Date): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: OPERATING_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(at)
    .split(':')
    .map(Number);
  return h * 60 + m;
}

/** Late: checked in after the depot's start (HH:MM or HH:MM:SS) plus its grace, Addis Ababa time. On the minute itself is on time. */
export function isLate(checkInAt: Date, depot: { workStartsAt: string; lateAfterMinutes: number }): boolean {
  const [h, m] = depot.workStartsAt.split(':').map(Number);
  return localMinutes(checkInAt) > h * 60 + m + depot.lateAfterMinutes;
}

const codeError = (reason: string, message: string) => new AppError(400, 'VALIDATION_FAILED', message, [{ field: 'code', reason }]);

export const codeInvalid = () => codeError('invalid', 'This is not a depot attendance code.');
export const codeExpired = () => codeError('expired', 'This code has expired. Scan the code on the depot screen again.');
export const codeOtherDepot = () => codeError('other_depot', "This code is for another depot. Scan your own depot's code.");

export const notADriver = () => new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only a driver checks in by scanning.');

export const alreadyScanned = (reason: 'just_checked_in' | 'already_checked_out') =>
  new AppError(
    409,
    'CONFLICT_ATTENDANCE_DUPLICATE',
    reason === 'just_checked_in' ? `You checked in less than ${CHECK_OUT_AFTER_MINUTES} minutes ago.` : 'You have already checked out today.',
    [{ field: 'code', reason }],
  );

import type { PoolClient } from 'pg';
import { depotInScope, depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { validationFailed } from '../../../shared/errors/app-error';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserAccount } from '../../auth';
import {
  ATTENDANCE_EVENTS,
  attendanceDriverNotFound,
  attendanceDriverRetired,
  attendanceDuplicate,
  attendanceNotFound,
  checkAttendanceDate,
  checkManualTimes,
  operatingToday,
  timesByScanOnly,
  type AttendanceStatus,
  type AttendanceView,
  type RosterEntry,
} from '../domain/attendance';
import {
  alreadyScanned,
  CHECK_OUT_AFTER_MINUTES,
  codeOtherDepot,
  isLate,
  issueCode,
  notADriver,
  readCode,
  type AttendanceCode,
} from '../domain/attendance-code';
import type { AttendanceRepository, AttendanceRow, CheckTimes } from '../infrastructure/attendance.repository';
import type { DriverRow } from '../infrastructure/driver.repository';
import type { Caller } from './caller';

export interface AttendanceCreate {
  driver_id: string;
  date: string;
  /** Left out only with a check-in time: present, or late after the depot's start and grace. */
  status?: AttendanceStatus;
  notes?: string | null;
  /** Entered by hand (FMS-141): staff only. */
  check_in_at?: Date | null;
  check_out_at?: Date | null;
}

export interface AttendanceUpdate {
  status?: AttendanceStatus;
  notes?: string | null;
  check_in_at?: Date | null;
  check_out_at?: Date | null;
}

/** GET /attendance/qr: the depot's code now, and its rules (FMS-141). */
export interface DepotAttendanceCode extends AttendanceCode {
  depot_id: string;
  depot_name: string;
  work_starts_at: string;
  late_after_minutes: number;
  /** The server's clock when it answered: the screen times its refresh from this, not from its own clock. */
  generated_at: Date;
}

/** POST /attendance/check-in: what the scan did, and the day's record. */
export interface CheckInResult {
  action: 'checked_in' | 'checked_out';
  attendance: AttendanceView;
}

type DepotRules = { publicId: string; name: string; workStartsAt: string; lateAfterMinutes: number };

export interface RosterQuery {
  page: number;
  page_size: number;
  date: string;
  depot_id?: string;
  driver_id?: string;
  status?: AttendanceStatus | 'unmarked';
  search?: string;
}

export interface AttendanceServiceDeps {
  attendance: Pick<AttendanceRepository, 'inTransaction' | 'findByPublicId' | 'findById' | 'lockForWrite' | 'lockForDay' | 'roster' | 'insert' | 'update'>;
  drivers: {
    findByPublicId(db: Queryable, publicId: string): Promise<DriverRow | null>;
    findByUserId(db: Queryable, userId: string): Promise<DriverRow | null>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
    attendanceRules(db: Queryable, depotId: string): Promise<DepotRules | null>;
  };
  events: EventBus;
  /** Signs and checks the depot attendance codes (FMS-141). */
  codeKey: Buffer;
  now?: () => Date;
}

/**
 * Driver attendance (FMS-21): one record per driver and day (Addis Ababa
 * calendar), replacing the paper sheet. Staff see and record the drivers of
 * their depots; a driver sees and records only their own day.
 */
export class AttendanceService {
  constructor(private readonly deps: AttendanceServiceDeps) {}

  /** GET /attendance?date=: every driver the caller may see, with the day's record or null. */
  async roster(caller: Caller, query: RosterQuery): Promise<{ items: RosterEntry[]; total: number }> {
    const { attendance, depots } = this.deps;
    return attendance.inTransaction(async (client) => {
      const own = ownDriverScope(caller.user);
      const scope = own.kind === 'own' ? ({ kind: 'all' } as const) : depotScope(caller.user);
      let depotId: string | undefined;
      if (query.depot_id) {
        // A depot outside the caller's scope filters to nothing, like an unknown one.
        const resolved = await depots.resolveInScope(client, query.depot_id, depotScope(caller.user));
        if (!resolved) return { items: [], total: 0 };
        depotId = resolved;
      }
      const { rows, total } = await attendance.roster(client, {
        page: query.page,
        page_size: query.page_size,
        date: query.date,
        scope,
        ownUserId: own.kind === 'own' ? own.userId : undefined,
        depotId,
        driverPublicId: query.driver_id,
        status: query.status,
        search: query.search,
      });
      const names = await this.names(client, rows.flatMap((r) => (r.record ? [r.record.loggedBy] : [])));
      const depotPublic = await depots.publicIds(client, [...new Set(rows.map((r) => r.depotId).filter((d): d is string => d !== null))]);
      const items = rows.map(
        (r): RosterEntry => ({
          driver_id: r.driverPublicId,
          full_name: r.fullName,
          email: r.email,
          depot_id: r.depotId === null ? null : (depotPublic.get(r.depotId) ?? null),
          license_status: r.licenseStatus,
          date: query.date,
          attendance: r.record && {
            id: r.record.publicId,
            status: r.record.status,
            notes: r.record.notes,
            check_in_at: r.record.checkInAt,
            check_in_method: r.record.checkInMethod,
            check_out_at: r.record.checkOutAt,
            check_out_method: r.record.checkOutMethod,
            logged_by: names.get(r.record.loggedBy)?.publicId ?? '',
            logged_by_name: names.get(r.record.loggedBy)?.fullName ?? '',
            created_at: r.record.createdAt,
            updated_at: r.record.updatedAt,
          },
        }),
      );
      return { items, total };
    });
  }

  async get(caller: Caller, attendanceId: string): Promise<AttendanceView> {
    const { attendance } = this.deps;
    return attendance.inTransaction(async (client) => {
      const row = await attendance.findByPublicId(client, attendanceId);
      if (!row || !(await this.mayAccess(client, caller, row.driverUserId))) throw attendanceNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /**
   * POST /attendance: the first record for a driver and day. A second is
   * 409 CONFLICT_ATTENDANCE_DUPLICATE (the unique constraint decides, so two
   * clerks at once cannot both succeed); change it with PUT instead.
   * `logged_by` is the caller.
   */
  async create(caller: Caller, input: AttendanceCreate): Promise<AttendanceView> {
    const times = { in: input.check_in_at ?? null, out: input.check_out_at ?? null };
    if ((times.in || times.out) && ownDriverScope(caller.user).kind === 'own') throw timesByScanOnly();
    if (!input.status && !times.in) throw validationFailed([{ field: 'status', reason: 'required' }], 'Give a status, or a check-in time.');
    checkManualTimes(input.date, times, this.now());
    if (input.status) checkAttendanceDate(input.date, input.status);
    const { attendance } = this.deps;
    const view = await attendance.inTransaction(async (client) => {
      const driver = await this.writableDriver(client, caller, input.driver_id);
      const status = input.status ?? (await this.arrivalStatus(client, driver.userId, times.in!));
      let row;
      try {
        row = await attendance.insert(
          mutationContext(caller),
          {
            driver_id: driver.id,
            attendance_date: input.date,
            status,
            notes: input.notes ?? null,
            logged_by: caller.user.id!,
            ...manualColumns({ check_in_at: input.check_in_at, check_out_at: input.check_out_at }),
          },
          client,
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw attendanceDuplicate();
        throw err;
      }
      const created = (await this.views(client, [await attendance.findById(client, row.id as string)]))[0];
      await this.publish(client, caller, created, null);
      return created;
    });
    return view;
  }

  /**
   * PUT / PATCH /attendance/{id}: change the status, notes, or (staff) the check-in and check-out times; the caller
   * becomes `logged_by`. A check-in time without a status makes the day present, or late after the depot's grace.
   */
  async update(caller: Caller, attendanceId: string, patch: AttendanceUpdate): Promise<AttendanceView> {
    const { attendance } = this.deps;
    const timesGiven = patch.check_in_at !== undefined || patch.check_out_at !== undefined;
    if (timesGiven && ownDriverScope(caller.user).kind === 'own') throw timesByScanOnly();
    return attendance.inTransaction(async (client) => {
      const row = await attendance.lockForWrite(client, attendanceId);
      if (!row || !(await this.mayAccess(client, caller, row.driverUserId))) throw attendanceNotFound();
      if (timesGiven) {
        const next = { in: patch.check_in_at !== undefined ? patch.check_in_at : row.checkInAt, out: patch.check_out_at !== undefined ? patch.check_out_at : row.checkOutAt };
        checkManualTimes(row.date, next, this.now());
      }
      const status = patch.status ?? (patch.check_in_at ? await this.arrivalStatus(client, row.driverUserId, patch.check_in_at) : undefined);
      if (status !== undefined) checkAttendanceDate(row.date, status);
      await attendance.update(
        mutationContext(caller),
        row.id,
        {
          ...(status !== undefined ? { status } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...manualColumns(patch),
          logged_by: caller.user.id!,
        },
        client,
      );
      const view = (await this.views(client, [await attendance.findById(client, row.id)]))[0];
      await this.publish(client, caller, view, row.status);
      return view;
    });
  }

  /**
   * GET /attendance/qr (FMS-141): the code the depot screen shows now, for the caller's own depot or `depot_id`
   * (one in their scope). A new one every 30 seconds; each is accepted for 60.
   */
  async code(caller: Caller, depotPublicId?: string): Promise<DepotAttendanceCode> {
    const { attendance, depots } = this.deps;
    const now = this.now();
    return attendance.inTransaction(async (client) => {
      let depotId: string | null = caller.user.depotId;
      if (depotPublicId) depotId = await depots.resolveInScope(client, depotPublicId, depotScope(caller.user));
      else if (!depotId) throw validationFailed([{ field: 'depot_id', reason: 'required' }], 'Choose the depot whose code to show.');
      const rules = depotId ? await depots.attendanceRules(client, depotId) : null;
      if (!rules) throw validationFailed([{ field: 'depot_id', reason: 'references_missing_record' }], 'The depot does not exist or is outside your depots.');
      return {
        depot_id: rules.publicId,
        depot_name: rules.name,
        work_starts_at: rules.workStartsAt,
        late_after_minutes: rules.lateAfterMinutes,
        generated_at: now,
        ...issueCode(this.deps.codeKey, rules.publicId, now),
      };
    });
  }

  /**
   * POST /attendance/check-in (FMS-141): a driver scanned their depot's code. The first scan of the day checks
   * them in, present or late (after the depot's start plus its grace); the next, at least 10 minutes later,
   * checks them out. A record made by hand without a time is checked in by the scan. Audited, and published as
   * AttendanceRecorded like any change.
   */
  async checkIn(caller: Caller, code: string): Promise<CheckInResult> {
    const { attendance, drivers } = this.deps;
    const now = this.now();
    return attendance.inTransaction(async (client) => {
      const driver = caller.user.id ? await drivers.findByUserId(client, caller.user.id) : null;
      if (!driver) throw notADriver();
      if (!driver.isActive) throw attendanceDriverRetired();
      const { depotPublicId } = readCode(this.deps.codeKey, code, now);
      const depot = await this.homeDepot(client, driver.userId);
      if (!depot || depot.publicId !== depotPublicId) throw codeOtherDepot();

      const ctx = mutationContext(caller);
      const date = operatingToday(now);
      const row = await attendance.lockForDay(client, driver.id, date);
      const arrived: AttendanceStatus = isLate(now, depot) ? 'late' : 'present';
      let id: string;
      let action: CheckInResult['action'] = 'checked_in';
      if (!row) {
        try {
          const inserted = await attendance.insert(
            ctx,
            { driver_id: driver.id, attendance_date: date, status: arrived, notes: null, logged_by: caller.user.id!, check_in_at: now, check_in_method: 'qr' },
            client,
          );
          id = inserted.id as string;
        } catch (err) {
          // The same code scanned twice at once: the other scan checked in.
          if ((err as { code?: string }).code === '23505') throw alreadyScanned('just_checked_in');
          throw err;
        }
      } else if (!row.checkInAt) {
        await attendance.update(ctx, row.id, { status: arrived, check_in_at: now, check_in_method: 'qr', logged_by: caller.user.id! }, client);
        id = row.id;
      } else if (!row.checkOutAt) {
        if (now.getTime() - row.checkInAt.getTime() < CHECK_OUT_AFTER_MINUTES * 60_000) throw alreadyScanned('just_checked_in');
        await attendance.update(ctx, row.id, { check_out_at: now, check_out_method: 'qr', logged_by: caller.user.id! }, client);
        id = row.id;
        action = 'checked_out';
      } else {
        throw alreadyScanned('already_checked_out');
      }
      const view = (await this.views(client, [await attendance.findById(client, id)]))[0];
      await this.publish(client, caller, view, row?.status ?? null);
      return { action, attendance: view };
    });
  }

  /** The depot a driver's account is homed in, with its start time and grace. */
  private async homeDepot(db: Queryable, driverUserId: string): Promise<DepotRules | null> {
    const [account] = await this.deps.users.findByIds(db, [driverUserId]);
    return account?.depotId ? this.deps.depots.attendanceRules(db, account.depotId) : null;
  }

  /** Present, or late when `at` is after the driver's depot's start plus its grace. */
  private async arrivalStatus(db: Queryable, driverUserId: string, at: Date): Promise<AttendanceStatus> {
    const depot = await this.homeDepot(db, driverUserId);
    return depot && isLate(at, depot) ? 'late' : 'present';
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The driver a caller may record attendance for: active, in their depots (or themselves, for a driver). */
  private async writableDriver(client: PoolClient, caller: Caller, driverPublicId: string): Promise<DriverRow> {
    const driver = await this.deps.drivers.findByPublicId(client, driverPublicId);
    if (!driver || !(await this.mayAccess(client, caller, driver.userId))) throw attendanceDriverNotFound();
    if (!driver.isActive) throw attendanceDriverRetired();
    return driver;
  }

  /** A driver-only user reaches only their own records; staff, the drivers homed in their depots. */
  private async mayAccess(db: Queryable, caller: Caller, driverUserId: string): Promise<boolean> {
    const own = ownDriverScope(caller.user);
    if (own.kind === 'own') return own.userId === driverUserId;
    const [account] = await this.deps.users.findByIds(db, [driverUserId]);
    return Boolean(account) && depotInScope(depotScope(caller.user), account.depotId);
  }

  private async views(db: Queryable, rows: AttendanceRow[]): Promise<AttendanceView[]> {
    const names = await this.names(db, rows.map((r) => r.loggedBy));
    return rows.map((r) => ({
      id: r.publicId,
      driver_id: r.driverPublicId,
      date: r.date,
      status: r.status,
      notes: r.notes,
      check_in_at: r.checkInAt,
      check_in_method: r.checkInMethod,
      check_out_at: r.checkOutAt,
      check_out_method: r.checkOutMethod,
      logged_by: names.get(r.loggedBy)?.publicId ?? '',
      logged_by_name: names.get(r.loggedBy)?.fullName ?? '',
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  private async names(db: Queryable, userIds: readonly string[]): Promise<Map<string, UserAccount>> {
    const accounts = await this.deps.users.findByIds(db, [...new Set(userIds)]);
    return new Map(accounts.map((a) => [a.id, a]));
  }

  /** Into the outbox on the change's transaction (FMS-73); ordered per attendance record. */
  private publish(client: PoolClient, caller: Caller, view: AttendanceView, previous: AttendanceStatus | null): Promise<void> {
    return this.deps.events.publish(client, [
      createEvent(
        ATTENDANCE_EVENTS.recorded,
        {
          attendance_id: view.id,
          driver_id: view.driver_id,
          date: view.date,
          status: view.status,
          previous_status: previous,
          check_in_at: view.check_in_at,
          check_in_method: view.check_in_method,
          check_out_at: view.check_out_at,
          check_out_method: view.check_out_method,
        },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
        { aggregate: aggregateKey('attendance', view.id) },
      ),
    ]);
  }
}

/** "today" in a query means today in Addis Ababa. */
export function resolveDate(value: string): string {
  return value === 'today' ? operatingToday() : value;
}

/** Times entered by hand are `manual`; a time cleared clears its method. */
function manualColumns(input: { check_in_at?: Date | null; check_out_at?: Date | null }): CheckTimes {
  const columns: CheckTimes = {};
  if (input.check_in_at !== undefined) Object.assign(columns, { check_in_at: input.check_in_at, check_in_method: input.check_in_at ? 'manual' : null });
  if (input.check_out_at !== undefined) Object.assign(columns, { check_out_at: input.check_out_at, check_out_method: input.check_out_at ? 'manual' : null });
  return columns;
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

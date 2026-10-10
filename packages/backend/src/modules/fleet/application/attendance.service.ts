import type { PoolClient } from 'pg';
import { depotInScope, depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import { createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
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
  operatingToday,
  type AttendanceStatus,
  type AttendanceView,
  type RosterEntry,
} from '../domain/attendance';
import type { AttendanceRepository, AttendanceRow } from '../infrastructure/attendance.repository';
import type { DriverRow } from '../infrastructure/driver.repository';
import type { Caller } from './caller';

export interface AttendanceCreate {
  driver_id: string;
  date: string;
  status: AttendanceStatus;
  notes?: string | null;
}

export interface AttendanceUpdate {
  status?: AttendanceStatus;
  notes?: string | null;
}

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
  attendance: Pick<AttendanceRepository, 'inTransaction' | 'findByPublicId' | 'findById' | 'lockForWrite' | 'roster' | 'insert' | 'update'>;
  drivers: { findByPublicId(db: Queryable, publicId: string): Promise<DriverRow | null> };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]> };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  events: EventBus;
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
    checkAttendanceDate(input.date, input.status);
    const { attendance } = this.deps;
    const view = await attendance.inTransaction(async (client) => {
      const driver = await this.writableDriver(client, caller, input.driver_id);
      let row;
      try {
        row = await attendance.insert(
          mutationContext(caller),
          { driver_id: driver.id, attendance_date: input.date, status: input.status, notes: input.notes ?? null, logged_by: caller.user.id! },
          client,
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw attendanceDuplicate();
        throw err;
      }
      return (await this.views(client, [await attendance.findById(client, row.id as string)]))[0];
    });
    await this.publish(caller, view, null);
    return view;
  }

  /** PUT / PATCH /attendance/{id}: change the status or notes; the caller becomes `logged_by`. */
  async update(caller: Caller, attendanceId: string, patch: AttendanceUpdate): Promise<AttendanceView> {
    const { attendance } = this.deps;
    const { view, previous } = await attendance.inTransaction(async (client) => {
      const row = await attendance.lockForWrite(client, attendanceId);
      if (!row || !(await this.mayAccess(client, caller, row.driverUserId))) throw attendanceNotFound();
      if (patch.status !== undefined) checkAttendanceDate(row.date, patch.status);
      await attendance.update(mutationContext(caller), row.id, { ...patch, logged_by: caller.user.id! }, client);
      return { view: (await this.views(client, [await attendance.findById(client, row.id)]))[0], previous: row.status };
    });
    await this.publish(caller, view, previous);
    return view;
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

  private publish(caller: Caller, view: AttendanceView, previous: AttendanceStatus | null): Promise<void> {
    return this.deps.events.publish([
      createEvent(
        ATTENDANCE_EVENTS.recorded,
        { attendance_id: view.id, driver_id: view.driver_id, date: view.date, status: view.status, previous_status: previous },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
      ),
    ]);
  }
}

/** "today" in a query means today in Addis Ababa. */
export function resolveDate(value: string): string {
  return value === 'today' ? operatingToday() : value;
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

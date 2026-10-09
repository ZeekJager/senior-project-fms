import type { PoolClient } from 'pg';
import { depotInScope, depotScope, type Scope } from '../../../shared/authz/scope';
import { createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { UserAccount } from '../../auth';
import {
  DRIVER_EVENTS,
  driverDepotNotFound,
  driverInUse,
  driverNotFound,
  driverRetired,
  unknownDriverAccount,
  type DriverView,
} from '../domain/driver';
import type { DriverListFilter, DriverRepository, DriverRow, DriverSortKey, DriverWrite } from '../infrastructure/driver.repository';
import type { Caller } from './caller';

/** Fields of POST /drivers, after validation and normalization. */
export interface DriverCreate {
  /** The user account's public id. */
  user_id: string;
  license_number: string;
  license_category?: string | null;
  license_expiry: string;
  hire_date?: string | null;
  emergency_phone?: string | null;
  /** The home depot's public id, written to the user account. */
  depot_id: string;
}

export type DriverUpdate = Partial<Omit<DriverCreate, 'user_id'>>;

export interface DriverListQuery {
  page: number;
  page_size: number;
  depot_id?: string;
  license_expiring_before?: string;
  search?: string;
  status?: 'active' | 'retired';
  sort_by: DriverSortKey;
  sort_order: 'asc' | 'desc';
}

export interface DriverServiceDeps {
  drivers: Pick<
    DriverRepository,
    'inTransaction' | 'findByPublicId' | 'findById' | 'lockForWrite' | 'list' | 'hasActiveAssignment' | 'licensedAt' | 'insert' | 'update' | 'retire'
  >;
  /** The auth module's user directory (through its index.ts). */
  users: {
    findByPublicId(db: Queryable, publicId: string): Promise<UserAccount | null>;
    findByIds(db: Queryable, ids: readonly string[]): Promise<UserAccount[]>;
    idsMatching(db: Queryable, filter: { depotIds: readonly string[] | null; search?: string }): Promise<string[]>;
    setDepot(client: PoolClient, ctx: MutationContext, userId: string, depotId: string): Promise<void>;
  };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  /** The trip module's answer: is the driver on an assigned or en-route trip? */
  trips: { driverHasActiveTrip(db: Queryable, driverId: string): Promise<boolean> };
  events: EventBus;
}

/**
 * Driver profiles (FMS-16). A driver is a user account with the driver role
 * plus a fleet.drivers row for the licence. The account owns name, contact and
 * home depot; this service reaches it only through the auth module.
 */
export class DriverService {
  constructor(private readonly deps: DriverServiceDeps) {}

  async list(caller: Caller, query: DriverListQuery): Promise<{ items: DriverView[]; total: number }> {
    const { drivers, users, depots } = this.deps;
    return drivers.inTransaction(async (client) => {
      const scope = depotScope(caller.user);

      // The depots to look in: the requested one if the caller may see it, else the caller's scope.
      let depotIds: string[] | null;
      if (query.depot_id) {
        const id = await depots.resolveInScope(client, query.depot_id, scope);
        depotIds = id ? [id] : [];
      } else {
        depotIds = scope.kind === 'all' ? null : scope.kind === 'depot' ? [scope.depotId] : [];
      }
      if (depotIds?.length === 0) return { items: [], total: 0 };

      const filter: DriverListFilter = {
        page: query.page,
        page_size: query.page_size,
        userIds: depotIds === null ? null : await users.idsMatching(client, { depotIds }),
        status: query.status,
        licenseExpiringBefore: query.license_expiring_before,
        sort_by: query.sort_by,
        sort_order: query.sort_order,
      };
      if (query.search) {
        filter.search = { term: query.search, userIds: await users.idsMatching(client, { depotIds, search: query.search }) };
      }
      const { rows, total } = await drivers.list(client, filter);
      return { items: await this.views(client, rows), total };
    });
  }

  async get(caller: Caller, driverId: string): Promise<DriverView> {
    const { drivers } = this.deps;
    return drivers.inTransaction(async (client) => {
      const row = await drivers.findByPublicId(client, driverId);
      const view = row && (await this.views(client, [row]))[0];
      if (!view || !(await this.inScope(client, caller, row.userId))) throw driverNotFound();
      return view;
    });
  }

  async create(caller: Caller, input: DriverCreate): Promise<DriverView> {
    const { drivers, users } = this.deps;
    const scope = depotScope(caller.user);

    const view = await drivers.inTransaction(async (client) => {
      const account = await users.findByPublicId(client, input.user_id);
      // An account in another depot looks like no account at all.
      if (!account || (account.depotId !== null && !depotInScope(scope, account.depotId))) {
        throw unknownDriverAccount('references_missing_record');
      }
      if (account.status !== 'active') throw unknownDriverAccount('account_not_active');
      if (!account.roles.includes('driver')) throw unknownDriverAccount('not_a_driver');

      const depotId = await this.depotInScope(client, input.depot_id, scope);
      const ctx = mutationContext(caller);
      const row = await drivers.insert(ctx, { ...toColumns(input), user_id: account.id }, client);
      if (account.depotId !== depotId) await users.setDepot(client, ctx, account.id, depotId);
      return (await this.views(client, [await drivers.findById(client, row.id as string)]))[0];
    });

    await this.publish(caller, DRIVER_EVENTS.registered, view);
    return view;
  }

  async update(caller: Caller, driverId: string, patch: DriverUpdate): Promise<DriverView> {
    const { drivers, users } = this.deps;
    return drivers.inTransaction(async (client) => {
      const row = await this.lockInScope(client, caller, driverId);
      if (!row.isActive) throw driverRetired();

      const ctx = mutationContext(caller);
      const data = toColumns(patch);
      if (Object.keys(data).length > 0) await drivers.update(ctx, row.id, data, client);
      if (patch.depot_id !== undefined) {
        const depotId = await this.depotInScope(client, patch.depot_id, depotScope(caller.user));
        const [account] = await users.findByIds(client, [row.userId]);
        if (account.depotId !== depotId) await users.setDepot(client, ctx, row.userId, depotId);
      }
      return (await this.views(client, [await drivers.findById(client, row.id)]))[0];
    });
  }

  /**
   * Soft-retires a driver (DELETE /drivers/{id}); trips and attendance keep
   * their references. Refused while the driver is on an assigned or en-route
   * trip or assigned to a vehicle. Retiring a retired driver succeeds and
   * changes nothing. The user account is left as it is (user administration).
   */
  async retire(caller: Caller, driverId: string): Promise<void> {
    const { drivers, trips } = this.deps;
    const retired = await drivers.inTransaction(async (client) => {
      const row = await this.lockInScope(client, caller, driverId);
      if (!row.isActive) return null;
      if ((await trips.driverHasActiveTrip(client, row.id)) || (await drivers.hasActiveAssignment(client, row.id))) {
        throw driverInUse();
      }
      await drivers.retire(mutationContext(caller), row.id, client);
      return (await this.views(client, [await drivers.findById(client, row.id)]))[0];
    });
    if (retired) await this.publish(caller, DRIVER_EVENTS.retired, retired);
  }

  /**
   * Whether a driver (internal id) may be dispatched at `at`: the driver is
   * not retired, the licence is valid on that date in Addis Ababa, and the
   * user account is active. For the trip module, through fleet's index.ts;
   * pass the caller's transaction client to read in the same transaction.
   */
  async isEligible(db: Queryable, driverId: string, at: Date): Promise<boolean> {
    const own = await this.deps.drivers.licensedAt(db, driverId, at);
    if (!own?.eligible) return false;
    const [account] = await this.deps.users.findByIds(db, [own.userId]);
    return account?.status === 'active';
  }

  /** Rows to API views: the account and depot parts come from the auth module and fleet.depots. */
  private async views(db: Queryable, rows: readonly DriverRow[]): Promise<DriverView[]> {
    const accounts = new Map((await this.deps.users.findByIds(db, rows.map((r) => r.userId))).map((a) => [a.id, a]));
    const depotIds = [...new Set([...accounts.values()].map((a) => a.depotId).filter((d): d is string => d !== null))];
    const depots = await this.deps.depots.publicIds(db, depotIds);

    return rows.map((r) => {
      const account = accounts.get(r.userId)!;
      return {
        id: r.publicId,
        user_id: account.publicId,
        full_name: account.fullName,
        email: account.email,
        phone: account.phone,
        depot_id: account.depotId === null ? null : (depots.get(account.depotId) ?? null),
        license_number: r.licenseNumber,
        license_category: r.licenseCategory,
        license_expiry: r.licenseExpiry,
        hire_date: r.hireDate,
        emergency_phone: r.emergencyPhone,
        status: r.isActive ? 'active' : 'retired',
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  /** Whether the driver's account is in the caller's depot scope (checked in code: the depot lives in auth). */
  private async inScope(db: Queryable, caller: Caller, userId: string): Promise<boolean> {
    const [account] = await this.deps.users.findByIds(db, [userId]);
    return Boolean(account) && depotInScope(depotScope(caller.user), account.depotId);
  }

  private async lockInScope(client: PoolClient, caller: Caller, driverId: string): Promise<DriverRow> {
    const row = await this.deps.drivers.lockForWrite(client, driverId);
    if (!row || !(await this.inScope(client, caller, row.userId))) throw driverNotFound();
    return row;
  }

  private async depotInScope(client: PoolClient, depotPublicId: string, scope: Scope): Promise<string> {
    const depotId = await this.deps.depots.resolveInScope(client, depotPublicId, scope);
    if (!depotId) throw driverDepotNotFound();
    return depotId;
  }

  private publish(caller: Caller, type: string, view: DriverView): Promise<void> {
    const payload = { driver_id: view.id, user_id: view.user_id, depot_id: view.depot_id };
    return this.deps.events.publish([createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId })]);
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

/** API fields to fleet.drivers columns. `depot_id` goes to the user account; `user_id` is set on create only. */
function toColumns(input: DriverUpdate): DriverWrite {
  const data: DriverWrite = {};
  if (input.license_number !== undefined) data.license_number = input.license_number;
  if (input.license_category !== undefined) data.license_category = input.license_category;
  if (input.license_expiry !== undefined) data.license_expiry = input.license_expiry;
  if (input.hire_date !== undefined) data.hire_date = input.hire_date;
  if (input.emergency_phone !== undefined) data.emergency_phone = input.emergency_phone;
  return data;
}

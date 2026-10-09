import { depotScope } from '../../../shared/authz/scope';
import { validationFailed } from '../../../shared/errors/app-error';
import { createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  DEPOT_EVENTS,
  depotNotEmpty,
  depotInactive,
  depotNotFoundById,
  inactiveDepotsForbidden,
  type DepotView,
} from '../domain/depot';
import type { DepotRepository, DepotWrite } from '../infrastructure/depot.repository';
import type { Caller } from './caller';

/** Fields of POST /depots (and PUT), after validation and normalization. */
export interface DepotCreate {
  name: string;
  location: string;
  code?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;
}

export type DepotUpdate = Partial<DepotCreate>;

export interface DepotListQuery {
  page: number;
  page_size: number;
  status: 'active' | 'inactive' | 'all';
  in_scope: boolean;
  search?: string;
}

/** The optional fields, cleared by a PUT that leaves them out. */
const OPTIONAL_FIELDS = ['code', 'address', 'city', 'country', 'timezone', 'latitude', 'longitude', 'capacity'] as const;

export interface DepotServiceDeps {
  depots: Pick<DepotRepository, 'inTransaction' | 'list' | 'findView' | 'findViewById' | 'lockForWrite' | 'occupancy' | 'insert' | 'update' | 'deactivate'>;
  /** The auth module's count of active accounts homed in a depot (through its index.ts). */
  users: { countActiveInDepot(db: Queryable, depotId: string): Promise<number> };
  events: EventBus;
}

/**
 * Depots (FMS-20): every signed-in user may read them (they are what lists
 * filter by); only depot:write (admin, fleet owner) creates, changes,
 * deletes and restores them. Deletion is soft and refused while the depot
 * still has active vehicles, drivers or user accounts.
 */
export class DepotService {
  constructor(private readonly deps: DepotServiceDeps) {}

  list(caller: Caller, query: DepotListQuery): Promise<{ items: DepotView[]; total: number }> {
    if (query.status !== 'active' && !canManage(caller)) throw inactiveDepotsForbidden();
    const { depots } = this.deps;
    return depots.inTransaction((client) =>
      depots.list(client, {
        page: query.page,
        page_size: query.page_size,
        status: query.status,
        search: query.search,
        scope: query.in_scope ? depotScope(caller.user) : undefined,
      }),
    );
  }

  /** A deleted depot is visible only to those who manage depots; to anyone else it does not exist. */
  async get(caller: Caller, depotId: string): Promise<DepotView> {
    const { depots } = this.deps;
    const view = await depots.inTransaction((client) => depots.findView(client, depotId));
    if (!view || (!view.is_active && !canManage(caller))) throw depotNotFoundById();
    return view;
  }

  async create(caller: Caller, input: DepotCreate): Promise<DepotView> {
    checkCoordinates(input.latitude, input.longitude);
    const { depots } = this.deps;
    const view = await depots.inTransaction(async (client) => {
      const row = await depots.insert(mutationContext(caller), toColumns(input), client);
      return depots.findViewById(client, row.id as string);
    });
    await this.publish(caller, DEPOT_EVENTS.created, { depot_id: view.id });
    return view;
  }

  /**
   * PATCH (`replace: false`) changes the fields sent; PUT (`replace: true`)
   * sets every writable field, clearing the optional ones it leaves out.
   * `expectedVersion` from If-Match refuses a stale write.
   */
  async update(caller: Caller, depotId: string, input: DepotUpdate, expectedVersion: number | null, replace = false): Promise<DepotView> {
    const { depots } = this.deps;
    const patch: DepotUpdate = replace ? { ...Object.fromEntries(OPTIONAL_FIELDS.map((k) => [k, null])), ...input } : input;
    const { view, changed } = await depots.inTransaction(async (client) => {
      const current = await depots.lockForWrite(client, depotId);
      if (!current) throw depotNotFoundById();
      if (expectedVersion !== null && expectedVersion !== current.version) throw staleVersion();
      if (!current.isActive) throw depotInactive();
      // Coordinates hold as a pair on the depot after the change.
      const lat = 'latitude' in patch ? patch.latitude : current.latitude;
      const lon = 'longitude' in patch ? patch.longitude : current.longitude;
      checkCoordinates(lat, lon);
      const data = toColumns(patch);
      const changedFields = Object.keys(data).sort();
      if (changedFields.length > 0) await depots.update(mutationContext(caller), current.id, data, client);
      return { view: await depots.findViewById(client, current.id), changed: changedFields };
    });
    if (changed.length > 0) await this.publish(caller, DEPOT_EVENTS.updated, { depot_id: view.id, changed_fields: changed });
    return view;
  }

  /**
   * DELETE /depots/{id}: soft. Refused with 409 CONFLICT_DEPOT_NOT_EMPTY while
   * active vehicles, drivers or user accounts belong to it. The depot row is
   * locked first; writes that put a vehicle or driver into a depot share-lock
   * it (resolveDepotInScope), so the check cannot race them. Deleting a
   * deleted depot changes nothing and succeeds.
   */
  async remove(caller: Caller, depotId: string): Promise<void> {
    const { depots, users } = this.deps;
    const removed = await depots.inTransaction(async (client) => {
      const current = await depots.lockForWrite(client, depotId);
      if (!current) throw depotNotFoundById();
      if (!current.isActive) return null;
      const { vehicles, drivers } = await depots.occupancy(client, current.id);
      const accounts = await users.countActiveInDepot(client, current.id);
      if (vehicles + drivers + accounts > 0) throw depotNotEmpty({ vehicles, drivers, users: accounts });
      await depots.deactivate(mutationContext(caller), current.id, client);
      return depots.findViewById(client, current.id);
    });
    if (removed) await this.publish(caller, DEPOT_EVENTS.deactivated, { depot_id: removed.id });
  }

  /** POST /depots/{id}/reactivate: brings a deleted depot back. Already active: unchanged. */
  async reactivate(caller: Caller, depotId: string): Promise<DepotView> {
    const { depots } = this.deps;
    const { view, changed } = await depots.inTransaction(async (client) => {
      const current = await depots.lockForWrite(client, depotId);
      if (!current) throw depotNotFoundById();
      if (current.isActive) return { view: await depots.findViewById(client, current.id), changed: false };
      await depots.update(mutationContext(caller), current.id, { is_active: true }, client);
      return { view: await depots.findViewById(client, current.id), changed: true };
    });
    if (changed) await this.publish(caller, DEPOT_EVENTS.reactivated, { depot_id: view.id });
    return view;
  }

  private publish(caller: Caller, type: string, payload: Record<string, unknown>): Promise<void> {
    return this.deps.events.publish([createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId })]);
  }
}

function canManage(caller: Caller): boolean {
  return caller.user.permissions.includes('depot:write');
}

/** Latitude and longitude are a pair: both or neither. */
function checkCoordinates(latitude: number | null | undefined, longitude: number | null | undefined): void {
  if ((latitude ?? null) === null !== ((longitude ?? null) === null)) {
    throw validationFailed([{ field: latitude == null ? 'latitude' : 'longitude', reason: 'coordinates_pair' }], 'Give both latitude and longitude, or neither.');
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

function toColumns(input: DepotUpdate): DepotWrite {
  const data: DepotWrite = {};
  for (const key of ['name', 'location', ...OPTIONAL_FIELDS] as const) {
    if (input[key] !== undefined) (data as Record<string, unknown>)[key] = input[key];
  }
  return data;
}

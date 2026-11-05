import { DatabaseError, type PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { notFound } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  duplicateGeofenceName,
  GEOFENCE_EVENTS,
  geofenceInactive,
  geofenceNotFound,
  invalidPolygon,
  MAX_GEOFENCES_PER_DEPOT,
  tooManyGeofences,
  type GeofenceView,
} from '../domain/geofence';
import { areaSquareMetres, boundingBox, normalizePolygon, polygonProblem, type Polygon } from '../domain/geometry';
import type { GeofenceApplies, GeofenceKind } from '../domain/location-rules';
import type { GeofenceRepository, GeofenceRow, GeofenceWrite } from '../infrastructure/geofence.repository';
import type { FlagRecord, TelemetryFlagRepository } from '../infrastructure/telemetry-flag.repository';
import { publishFlagChanges, type FlagEventRefs, type RulesVehicle } from './flag-events';

export interface GeofenceInput {
  depot_id: string;
  name: string;
  description?: string | null;
  kind: GeofenceKind;
  applies?: GeofenceApplies;
  polygon: Polygon;
}

export type GeofencePatch = Partial<GeofenceInput>;

export interface GeofenceListQuery {
  depot_id?: string;
  status: 'active' | 'inactive' | 'all';
}

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

export interface GeofenceServiceDeps {
  db: Queryable;
  geofences: GeofenceRepository;
  flags: Pick<TelemetryFlagRepository, 'resolveForGeofence'>;
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  refs: FlagEventRefs & {
    depots: {
      resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
      publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
    };
    vehicles: { byIds(db: Queryable, ids: readonly string[]): Promise<RulesVehicle[]> };
    users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  };
  events: EventBus;
  /** Called after a change has committed, so the rules on this instance check the new fences from the next ping. */
  onChange: () => void;
  now?: () => Date;
}

/** Changing these changes what the rules judge: the fence's open flags close, and vehicles are judged afresh. */
const RULE_FIELDS = ['depot_id', 'kind', 'applies', 'polygon'] as const;

/**
 * Geofences (FMS-90, docs/geofences.md): tracking:read sees them, in the caller's depot scope; geofence:write
 * (admin) draws, changes, removes (soft) and restores them, each change audited and published as GeofenceChanged.
 * A change to where or how a fence applies closes its open flags (`geofence_changed`), as removing it does
 * (`geofence_removed`), with TelemetryFlagResolved for each.
 */
export class GeofenceService {
  private readonly now: () => Date;

  constructor(private readonly deps: GeofenceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** GET /geofences. A depot outside the caller's scope is 404. */
  async list(user: RequestUser, query: GeofenceListQuery): Promise<GeofenceView[]> {
    const { db, geofences, refs } = this.deps;
    const scope = depotScope(user);
    let depotId: string | null = null;
    if (query.depot_id) {
      depotId = await refs.depots.resolveInScope(db, query.depot_id, scope);
      if (depotId === null) throw notFound('Depot not found.');
    }
    return this.views(db, await geofences.list(db, { scope, depotId, status: query.status }));
  }

  /** GET /geofences/{geofence_id}: in the caller's depot scope, else 404. */
  async get(user: RequestUser, publicId: string): Promise<GeofenceView> {
    const row = await this.deps.geofences.find(this.deps.db, publicId);
    if (!row || !inScope(depotScope(user), row.depotId)) throw geofenceNotFound();
    return (await this.views(this.deps.db, [row]))[0];
  }

  /** POST /geofences. */
  async create(caller: Caller, input: GeofenceInput): Promise<GeofenceView> {
    const polygon = checkedPolygon(input.polygon);
    const view = await this.write(async (client) => {
      const depotId = await this.depotIn(client, caller, input.depot_id);
      if ((await this.deps.geofences.countActive(client, depotId)) >= MAX_GEOFENCES_PER_DEPOT) throw tooManyGeofences();
      const row = await this.deps.geofences.insert(client, ctxOf(caller), {
        depot_id: depotId,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        applies: input.applies ?? 'always',
        ...shapeColumns(polygon),
      });
      await this.publishChange(client, caller, row, 'created', []);
      return (await this.views(client, [row]))[0];
    });
    return view;
  }

  /** PATCH /geofences/{geofence_id}: the fields sent. `expectedVersion` (If-Match) refuses a stale write. */
  async update(caller: Caller, publicId: string, patch: GeofencePatch, expectedVersion: number | null): Promise<GeofenceView> {
    const polygon = patch.polygon ? checkedPolygon(patch.polygon) : null;
    return this.write(async (client) => {
      const current = await this.lockInScope(client, caller, publicId);
      if (expectedVersion !== null && expectedVersion !== current.version) throw staleVersion();
      if (!current.isActive) throw geofenceInactive();
      const data: GeofenceWrite = {};
      if (patch.depot_id !== undefined) {
        const depotId = await this.depotIn(client, caller, patch.depot_id);
        if (depotId !== current.depotId) {
          if ((await this.deps.geofences.countActive(client, depotId)) >= MAX_GEOFENCES_PER_DEPOT) throw tooManyGeofences();
          data.depot_id = depotId;
        }
      }
      if (patch.name !== undefined && patch.name !== current.name) data.name = patch.name;
      if (patch.description !== undefined && (patch.description ?? null) !== current.description) data.description = patch.description ?? null;
      if (patch.kind !== undefined && patch.kind !== current.kind) data.kind = patch.kind;
      if (patch.applies !== undefined && patch.applies !== current.applies) data.applies = patch.applies;
      if (polygon && JSON.stringify(polygon) !== JSON.stringify(current.polygon)) Object.assign(data, shapeColumns(polygon));
      const changed = Object.keys(data).filter((k) => !['min_lat', 'max_lat', 'min_lng', 'max_lng', 'area_m2'].includes(k));
      if (changed.length === 0) return (await this.views(client, [current]))[0];
      const row = await this.deps.geofences.update(client, ctxOf(caller), current.id, data);
      if (changed.some((k) => (RULE_FIELDS as readonly string[]).includes(k))) await this.closeFlags(client, caller, row, 'geofence_changed');
      await this.publishChange(client, caller, row, 'updated', changed.sort());
      return (await this.views(client, [row]))[0];
    });
  }

  /** DELETE /geofences/{geofence_id}: soft. Its open flags close. Removing a removed fence changes nothing. */
  async remove(caller: Caller, publicId: string): Promise<void> {
    await this.write(async (client) => {
      const current = await this.lockInScope(client, caller, publicId);
      if (!current.isActive) return;
      const row = await this.deps.geofences.deactivate(client, ctxOf(caller), current.id);
      await this.closeFlags(client, caller, row, 'geofence_removed');
      await this.publishChange(client, caller, row, 'removed', []);
    });
  }

  /** POST /geofences/{geofence_id}/reactivate: back in force, judged from each vehicle's next crossing. */
  async reactivate(caller: Caller, publicId: string): Promise<GeofenceView> {
    return this.write(async (client) => {
      const current = await this.lockInScope(client, caller, publicId);
      if (current.isActive) return (await this.views(client, [current]))[0];
      if ((await this.deps.geofences.countActive(client, current.depotId)) >= MAX_GEOFENCES_PER_DEPOT) throw tooManyGeofences();
      const row = await this.deps.geofences.reactivate(client, ctxOf(caller), current.id);
      await this.publishChange(client, caller, row, 'reactivated', []);
      return (await this.views(client, [row]))[0];
    });
  }

  /** In a transaction; a name another active fence of the depot has is 409. The rules hear of it after commit. */
  private async write<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await this.deps.transaction(fn);
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'ux_geofences_depot_name') throw duplicateGeofenceName();
      throw err;
    }
    this.deps.onChange();
    return result;
  }

  private async depotIn(client: PoolClient, caller: Caller, depotPublicId: string): Promise<string> {
    const depotId = await this.deps.refs.depots.resolveInScope(client, depotPublicId, depotScope(caller.user));
    if (depotId === null) throw notFound('Depot not found.');
    return depotId;
  }

  private async lockInScope(client: PoolClient, caller: Caller, publicId: string): Promise<GeofenceRow> {
    const row = await this.deps.geofences.lock(client, publicId);
    if (!row || !inScope(depotScope(caller.user), row.depotId)) throw geofenceNotFound();
    return row;
  }

  /** Closes the fence's open flags and publishes TelemetryFlagResolved for each, per vehicle. */
  private async closeFlags(client: PoolClient, caller: Caller, row: GeofenceRow, reason: 'geofence_changed' | 'geofence_removed'): Promise<void> {
    const closed = await this.deps.flags.resolveForGeofence(client, row.id, this.now(), reason);
    if (closed.length === 0) return;
    const byVehicle = new Map<string, FlagRecord[]>();
    for (const flag of closed) byVehicle.set(flag.vehicleId, [...(byVehicle.get(flag.vehicleId) ?? []), flag]);
    const vehicles = await this.deps.refs.vehicles.byIds(client, [...byVehicle.keys()]);
    for (const vehicle of vehicles) {
      const changes = byVehicle.get(vehicle.id)!.map((flag) => ({ kind: 'resolved' as const, flag }));
      await publishFlagChanges(client, this.deps, vehicle, changes, caller.correlationId, { geofencePublicIds: new Map([[row.id, row.publicId]]) });
    }
  }

  private async publishChange(client: PoolClient, caller: Caller, row: GeofenceRow, change: 'created' | 'updated' | 'removed' | 'reactivated', changedFields: string[]): Promise<void> {
    const depots = await this.deps.refs.depots.publicIds(client, [row.depotId]);
    await this.deps.events.publish(client, [
      createEvent(
        GEOFENCE_EVENTS.changed,
        { geofence_id: row.publicId, depot_id: depots.get(row.depotId) ?? null, name: row.name, kind: row.kind, applies: row.applies, change, changed_fields: changedFields },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
        { aggregate: aggregateKey('geofence', row.publicId) },
      ),
    ]);
  }

  private async views(db: Queryable, rows: readonly GeofenceRow[]): Promise<GeofenceView[]> {
    const { refs } = this.deps;
    // One after another: they may share one connection.
    const depots = await refs.depots.publicIds(db, [...new Set(rows.map((r) => r.depotId))]);
    const users = await refs.users.findByIds(db, [...new Set(rows.flatMap((r) => (r.updatedBy ? [r.updatedBy] : [])))]);
    const byUser = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const editor = r.updatedBy ? byUser.get(r.updatedBy) : undefined;
      return {
        geofence_id: r.publicId,
        depot_id: depots.get(r.depotId)!,
        name: r.name,
        description: r.description,
        kind: r.kind,
        applies: r.applies,
        polygon: r.polygon,
        area_m2: r.areaM2,
        is_active: r.isActive,
        version: r.version,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
        updated_by: editor?.publicId ?? null,
        updated_by_name: editor?.fullName ?? null,
      };
    });
  }
}

/** The polygon as stored, or 400 naming what is wrong with it. */
function checkedPolygon(polygon: Polygon): Polygon {
  const normalized = normalizePolygon(polygon);
  const problem = polygonProblem(normalized);
  if (problem) throw invalidPolygon(problem);
  return normalized;
}

function shapeColumns(polygon: Polygon): GeofenceWrite {
  const box = boundingBox(polygon);
  return { polygon, min_lat: box.minLat, max_lat: box.maxLat, min_lng: box.minLng, max_lng: box.maxLng, area_m2: Math.round(areaSquareMetres(polygon)) };
}

function inScope(scope: Scope, depotId: string): boolean {
  return scope.kind === 'all' || (scope.kind === 'depot' && scope.depotId === depotId);
}

function ctxOf(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

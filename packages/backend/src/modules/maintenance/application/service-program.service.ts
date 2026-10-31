import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import type { Caller } from './maintenance.service';
import { maintenanceVehicleMissing } from '../domain/maintenance';
import {
  computeDue,
  defaultLead,
  fleetWideNotAllowed,
  intervalRequired,
  leadNotBelowInterval,
  leadWithoutInterval,
  modelNeedsMake,
  programApplies,
  programDepotNotFound,
  programNameTaken,
  programNotFound,
  recordProgramNotApplicable,
  recordProgramNotFound,
  transitionEvent,
  type ProgramFuelType,
  type ProgramVehicleType,
  type ServiceDueStatus,
  type ServiceDueView,
  type ServiceMeasure,
  type ServiceProgramView,
} from '../domain/service-program';
import type { DueRow, DueWrite, ProgramRow, ProgramWrite, ServiceProgramRepository } from '../infrastructure/service-program.repository';

/** A vehicle as programs see it (fleet's `serviceRefs`). Internal ids. */
interface ServiceVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  depotId: string;
  vehicleType: string;
  fuelType: string;
  make: string;
  model: string;
  odometerKm: number;
  engineHours: number | null;
  firstReadingAt: Date;
  firstReadingKm: number;
}

export interface ServiceProgramServiceDeps {
  programs: Pick<
    ServiceProgramRepository,
    | 'inTransaction'
    | 'list'
    | 'findByPublicId'
    | 'findById'
    | 'byIds'
    | 'lockForWrite'
    | 'active'
    | 'nameTaken'
    | 'insert'
    | 'update'
    | 'lastServices'
    | 'openServices'
    | 'statuses'
    | 'upsertDue'
    | 'deleteStale'
    | 'deleteOtherVehicles'
    | 'listDue'
    | 'dueForVehicles'
    | 'counts'
  >;
  vehicles: {
    /** In service, or those of `ids` among them, with their meters now. */
    service(db: Queryable, ids: readonly string[] | null): Promise<ServiceVehicle[]>;
    metersAt(db: Queryable, asks: readonly { vehicleId: string; at: Date }[]): Promise<{ odometerKm: number | null; engineHours: number | null }[]>;
    findInScope(db: Queryable, by: { publicId: string }, scope: Scope): Promise<{ id: string } | null>;
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
  };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, depotIds: readonly string[]): Promise<Map<string, string>>;
  };
  events: EventBus;
  now?: () => Date;
}

export interface ProgramInput {
  name: string;
  description?: string | null;
  /** Undefined: the caller's depot, or fleet-wide for one who sees every depot. Null: fleet-wide. */
  depot_id?: string | null;
  vehicle_type?: ProgramVehicleType | null;
  fuel_type?: ProgramFuelType | null;
  make?: string | null;
  model?: string | null;
  interval_km?: number | null;
  lead_km?: number | null;
  interval_days?: number | null;
  lead_days?: number | null;
  interval_engine_hours?: number | null;
  lead_engine_hours?: number | null;
  tasks?: string[];
}

export type ProgramUpdate = Partial<ProgramInput> & { is_active?: boolean };

export interface ProgramListQuery {
  page: number;
  page_size: number;
  status: 'active' | 'retired' | 'all';
  depot_id?: string;
}

export interface DueListQuery {
  page: number;
  page_size: number;
  status: readonly ServiceDueStatus[];
  vehicle_id?: string;
  program_id?: string;
  depot_id?: string;
}

/** The dispatcher's board (FMS-33): a vehicle's programs that are due or overdue. */
export interface ServiceDueSummary {
  status: 'due' | 'overdue';
  programs: { program_id: string; name: string; status: 'due' | 'overdue'; due_by: ServiceMeasure[] }[];
}

/** Who a computation runs for: a person (a program change, a completed repair) or the daily job. */
interface Run {
  now: Date;
  correlationId: string;
  actor: string | null;
}

/** Vehicles recomputed per transaction by the daily job. */
const JOB_BATCH = 250;
const MEASURES = [
  ['interval_km', 'lead_km'],
  ['interval_days', 'lead_days'],
  ['interval_engine_hours', 'lead_engine_hours'],
] as const;
const DAY_MS = 86_400_000;

/**
 * Preventive service programs (FMS-129, docs/service-programs.md). A program says how often the
 * vehicles it matches are serviced, by distance, time and engine hours, whichever comes first. Each
 * vehicle's service under each program is computed from its last completed service (or its first
 * reading) and its meters, and stored (maintenance.service_due) with its status: the daily job
 * recomputes every vehicle, a program change its vehicles, a completed service its vehicle, all on the
 * writer's transaction. Moving into due or overdue publishes ServiceDue or ServiceOverdue, once per move.
 */
export class ServiceProgramService {
  constructor(private readonly deps: ServiceProgramServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async list(caller: Caller, query: ProgramListQuery): Promise<{ items: ServiceProgramView[]; total: number }> {
    const { programs, vehicles, depots } = this.deps;
    return programs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      if (scope.kind === 'none' || scope.kind === 'own') return { items: [], total: 0 };
      let depotIds: string[] | null = scope.kind === 'depot' ? [scope.depotId] : null;
      let vehicleScope: Scope = scope;
      if (query.depot_id) {
        const depotId = await depots.resolveInScope(client, query.depot_id, scope);
        if (!depotId) throw programDepotNotFound();
        depotIds = [depotId];
        vehicleScope = { kind: 'depot', depotId };
      }
      const { rows, total } = await programs.list(client, { page: query.page, page_size: query.page_size, depotIds, status: query.status });
      return { items: await this.programViews(client, rows, await vehicles.idsInScope(client, vehicleScope)), total };
    });
  }

  async get(caller: Caller, programId: string): Promise<ServiceProgramView> {
    const { programs, vehicles } = this.deps;
    return programs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      const row = await programs.findByPublicId(client, programId);
      if (!row || !visible(row, scope)) throw programNotFound();
      return (await this.programViews(client, [row], await vehicles.idsInScope(client, scope)))[0];
    });
  }

  /** POST /service-programs: the program, then its vehicles computed, on one transaction. */
  async create(caller: Caller, input: ProgramInput): Promise<ServiceProgramView> {
    const { programs, vehicles } = this.deps;
    return programs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      const depotId = await this.depotFor(client, scope, input.depot_id);
      const data: ProgramWrite = {
        name: input.name,
        description: input.description ?? null,
        depot_id: depotId,
        vehicle_type: input.vehicle_type ?? null,
        fuel_type: input.fuel_type ?? null,
        make: input.make ?? null,
        model: input.model ?? null,
        ...intervals(input, null),
        tasks: JSON.stringify(input.tasks ?? []),
        created_by: caller.user.id,
      };
      if (data.model && !data.make) throw modelNeedsMake();
      if (await programs.nameTaken(client, depotId, input.name, null)) throw programNameTaken();
      const inserted = await programs.insert(ctxOf(caller), data, client);
      const id = inserted.id as string;
      await this.recompute(client, this.runOf(caller), { vehicleIds: null, programIds: [id] });
      return (await this.programViews(client, [await programs.findById(client, id)], await vehicles.idsInScope(client, scope)))[0];
    });
  }

  /**
   * PATCH /service-programs/{id}: the fields sent. `is_active: false` retires it (its vehicles are no
   * longer due under it), `true` brings it back. Its vehicles are computed again on the same transaction.
   */
  async update(caller: Caller, programId: string, patch: ProgramUpdate, expectedVersion: number | null): Promise<ServiceProgramView> {
    const { programs, vehicles } = this.deps;
    return programs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      const row = await programs.lockForWrite(client, programId);
      if (!row || !visible(row, scope)) throw programNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      if (row.depotId === null && scope.kind !== 'all') throw fleetWideNotAllowed();

      const data: ProgramWrite = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.depot_id !== undefined) data.depot_id = await this.depotFor(client, scope, patch.depot_id);
      if (patch.vehicle_type !== undefined) data.vehicle_type = patch.vehicle_type;
      if (patch.fuel_type !== undefined) data.fuel_type = patch.fuel_type;
      if (patch.make !== undefined) data.make = patch.make;
      if (patch.model !== undefined) data.model = patch.model;
      if (patch.tasks !== undefined) data.tasks = JSON.stringify(patch.tasks);
      if (patch.is_active !== undefined) data.is_active = patch.is_active;
      if (MEASURES.some(([i, l]) => patch[i] !== undefined || patch[l] !== undefined)) Object.assign(data, intervals(patch, row));

      const make = data.make !== undefined ? data.make : row.make;
      const model = data.model !== undefined ? data.model : row.model;
      if (model && !make) throw modelNeedsMake();
      const depotId = data.depot_id !== undefined ? data.depot_id : row.depotId;
      const name = data.name ?? row.name;
      const active = data.is_active ?? row.isActive;
      const renamed = data.name !== undefined || data.depot_id !== undefined || (active && !row.isActive);
      if (active && renamed && (await programs.nameTaken(client, depotId, name, row.id))) throw programNameTaken();

      if (Object.keys(data).length > 0) {
        await programs.update(ctxOf(caller), row.id, data, client);
        await this.recompute(client, this.runOf(caller), { vehicleIds: null, programIds: [row.id] });
      }
      return (await this.programViews(client, [await programs.findById(client, row.id)], await vehicles.idsInScope(client, scope)))[0];
    });
  }

  /** GET /service-due: the caller's vehicles' service by status (due and overdue by default), most urgent first. */
  async dueList(caller: Caller, query: DueListQuery): Promise<{ items: ServiceDueView[]; total: number }> {
    const { programs, vehicles, depots } = this.deps;
    return programs.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleIds: string[] | null;
      if (query.vehicle_id) {
        const vehicle = await vehicles.findInScope(client, { publicId: query.vehicle_id }, scope);
        if (!vehicle) return { items: [], total: 0 };
        vehicleIds = [vehicle.id];
      } else if (query.depot_id) {
        const depotId = await depots.resolveInScope(client, query.depot_id, scope);
        if (!depotId) throw programDepotNotFound();
        vehicleIds = await vehicles.idsInScope(client, { kind: 'depot', depotId });
      } else {
        vehicleIds = await vehicles.idsInScope(client, scope);
      }
      let programId: string | undefined;
      if (query.program_id) {
        const program = await programs.findByPublicId(client, query.program_id);
        if (!program || !visible(program, scope)) return { items: [], total: 0 };
        programId = program.id;
      }
      const { rows, total } = await programs.listDue(client, {
        page: query.page,
        page_size: query.page_size,
        vehicleIds,
        programId,
        statuses: query.status,
      });
      return { items: await this.dueViews(client, rows), total };
    });
  }

  /** GET /vehicles/{id}/service-due: every program that applies to the vehicle, most urgent first. */
  async forVehicle(caller: Caller, vehiclePublicId: string): Promise<ServiceDueView[]> {
    const { programs, vehicles } = this.deps;
    return programs.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw maintenanceVehicleMissing();
      return this.dueViews(client, await programs.dueForVehicles(client, [vehicle.id], ['upcoming', 'due', 'overdue']));
    });
  }

  /** The daily job: every vehicle in service under every active program, in batches, each its own transaction. */
  async run(context: JobContext): Promise<{ vehicles: number; rows: number; due: number; overdue: number; removed: number }> {
    const { programs, vehicles } = this.deps;
    const run: Run = { now: context.now, correlationId: context.correlationId, actor: null };
    const ids = (await programs.inTransaction((client) => vehicles.service(client, null))).map((v) => v.id);
    const total = { vehicles: ids.length, rows: 0, due: 0, overdue: 0, removed: 0 };
    for (let i = 0; i < ids.length; i += JOB_BATCH) {
      const done = await programs.inTransaction((client) => this.recompute(client, run, { vehicleIds: ids.slice(i, i + JOB_BATCH), programIds: null }));
      total.rows += done.rows;
      total.due += done.due;
      total.overdue += done.overdue;
      total.removed += done.removed;
    }
    // Rows of vehicles no longer in service (retired) belong to none of the batches.
    total.removed += await programs.inTransaction((client) => programs.deleteOtherVehicles(client, ids));
    return total;
  }

  /**
   * A completed preventive repair for a program (MaintenanceRecordCompleted's transaction): the program's
   * count on the vehicle starts again from it.
   */
  async serviceCompleted(client: PoolClient, caller: Caller, vehicleId: string, programId: string): Promise<void> {
    await this.recompute(client, this.runOf(caller), { vehicleIds: [vehicleId], programIds: [programId] });
  }

  /** A repair's program (POST and PATCH /maintenance): its internal id, if it is active and applies to the vehicle. */
  async programForRecord(client: PoolClient, vehicleId: string, programPublicId: string): Promise<string> {
    const program = await this.deps.programs.findByPublicId(client, programPublicId);
    if (!program || !program.isActive) throw recordProgramNotFound();
    const [vehicle] = await this.deps.vehicles.service(client, [vehicleId]);
    if (!vehicle || !programApplies(program, vehicle)) throw recordProgramNotApplicable();
    return program.id;
  }

  /** The programs of repairs, for their views: public id and name by internal id. */
  async names(db: Queryable, programIds: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
    const rows = await this.deps.programs.byIds(db, [...new Set(programIds)]);
    return new Map(rows.map((r) => [r.id, { id: r.publicId, name: r.name }]));
  }

  /** For the dispatcher's board (FMS-33): each vehicle's programs due or overdue, by internal vehicle id. */
  async boardSummaries(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, ServiceDueSummary>> {
    const out = new Map<string, ServiceDueSummary>();
    for (const r of await this.deps.programs.dueForVehicles(db, vehicleIds, ['due', 'overdue'])) {
      const status = r.status as 'due' | 'overdue';
      const summary = out.get(r.vehicleId) ?? { status, programs: [] };
      if (status === 'overdue') summary.status = 'overdue';
      summary.programs.push({ program_id: r.programPublicId, name: r.programName, status, due_by: r.dueBy });
      out.set(r.vehicleId, summary);
    }
    return out;
  }

  /**
   * Computes and stores the service due of the vehicles and programs asked (null: all), removes the rows
   * that no longer apply, and publishes ServiceDue / ServiceOverdue for each move into due or overdue.
   */
  async recompute(
    client: PoolClient,
    run: Run,
    filter: { vehicleIds: readonly string[] | null; programIds: readonly string[] | null },
  ): Promise<{ rows: number; due: number; overdue: number; removed: number }> {
    const { programs, vehicles } = this.deps;
    const active = await programs.active(client, filter.programIds);
    const fleet = active.length > 0 ? await vehicles.service(client, filter.vehicleIds) : [];
    const pairs = fleet.flatMap((v) => active.filter((p) => programApplies(p, v)).map((p) => ({ v, p })));
    const key = (vehicleId: string, programId: string) => `${vehicleId}:${programId}`;

    const last = new Map(
      (pairs.length > 0 ? await programs.lastServices(client, filter.vehicleIds, filter.programIds) : []).map((r) => [key(r.vehicleId, r.programId), r]),
    );
    const services = [...last.values()];
    const meters = await vehicles.metersAt(client, services.map((s) => ({ vehicleId: s.vehicleId, at: s.completedAt })));
    const metersOf = new Map(services.map((s, i) => [key(s.vehicleId, s.programId), meters[i]]));
    const previous = pairs.length > 0 ? await programs.statuses(client, filter.vehicleIds, filter.programIds) : new Map<string, ServiceDueStatus>();

    const writes: DueWrite[] = [];
    const moves: { v: ServiceVehicle; p: ProgramRow; write: DueWrite; type: string; from: ServiceDueStatus | null }[] = [];
    for (const { v, p } of pairs) {
      const k = key(v.id, p.id);
      const service = last.get(k);
      const at = metersOf.get(k);
      // From the last service: its odometer as entered, else the readings then. None: from the vehicle's first reading.
      const since = service
        ? { at: service.completedAt, km: service.odometerKm ?? at?.odometerKm ?? v.firstReadingKm, engineHours: at?.engineHours ?? null }
        : { at: v.firstReadingAt, km: v.firstReadingKm, engineHours: null };
      const due = computeDue(p, since, { now: run.now, odometerKm: v.odometerKm, engineHours: v.engineHours });
      const write: DueWrite = {
        vehicleId: v.id,
        programId: p.id,
        lastRecordId: service?.recordId ?? null,
        sinceAt: since.at,
        sinceKm: since.km,
        sinceEngineHours: due.sinceEngineHours,
        nextDueKm: due.nextDueKm,
        nextDueAt: due.nextDueAt,
        nextDueEngineHours: due.nextDueEngineHours,
        odometerKm: v.odometerKm,
        engineHours: v.engineHours,
        status: due.status,
        dueBy: due.dueBy,
      };
      writes.push(write);
      const from = previous.get(k) ?? null;
      const type = transitionEvent(from, due.status);
      if (type) moves.push({ v, p, write, type, from });
    }

    await programs.upsertDue(client, writes, run.now);
    const removed = await programs.deleteStale(client, filter.vehicleIds, filter.programIds, writes.map((w) => key(w.vehicleId, w.programId)));
    if (moves.length > 0) {
      const depots = await this.deps.depots.publicIds(client, [...new Set(moves.map((m) => m.v.depotId))]);
      await this.deps.events.publish(
        client,
        moves.map(({ v, p, write, type, from }) =>
          createEvent(
            type,
            {
              vehicle_id: v.publicId,
              depot_id: depots.get(v.depotId) ?? null,
              program_id: p.publicId,
              program_name: p.name,
              status: write.status,
              previous_status: from,
              due_by: write.dueBy,
              next_due_km: write.nextDueKm,
              next_due_at: write.nextDueAt?.toISOString() ?? null,
              next_due_engine_hours: write.nextDueEngineHours,
              odometer_km: write.odometerKm,
              engine_hours: write.engineHours,
            },
            { actor: run.actor, correlationId: run.correlationId },
            // In order with the vehicle's other events.
            { aggregate: aggregateKey('vehicle', v.publicId) },
          ),
        ),
      );
    }
    return {
      rows: writes.length,
      due: moves.filter((m) => m.write.status === 'due').length,
      overdue: moves.filter((m) => m.write.status === 'overdue').length,
      removed,
    };
  }

  /** Undefined: the caller's own depot, or fleet-wide for one who sees every depot. Null: fleet-wide. */
  private async depotFor(db: Queryable, scope: Scope, depotPublicId: string | null | undefined): Promise<string | null> {
    if (depotPublicId === undefined) {
      if (scope.kind === 'all') return null;
      if (scope.kind === 'depot') return scope.depotId;
      throw fleetWideNotAllowed();
    }
    if (depotPublicId === null) {
      if (scope.kind !== 'all') throw fleetWideNotAllowed();
      return null;
    }
    const depotId = await this.deps.depots.resolveInScope(db, depotPublicId, scope);
    if (!depotId) throw programDepotNotFound();
    return depotId;
  }

  private runOf(caller: Caller): Run {
    return { now: this.now(), correlationId: caller.correlationId, actor: caller.user.publicId };
  }

  private async programViews(db: Queryable, rows: readonly ProgramRow[], vehicleIds: readonly string[] | null): Promise<ServiceProgramView[]> {
    if (rows.length === 0) return [];
    const counts = await this.deps.programs.counts(db, rows.map((r) => r.id), vehicleIds);
    const depots = await this.deps.depots.publicIds(db, [...new Set(rows.flatMap((r) => (r.depotId ? [r.depotId] : [])))]);
    return rows.map((r) => {
      const c = counts.get(r.id) ?? { upcoming: 0, due: 0, overdue: 0 };
      return {
        id: r.publicId,
        name: r.name,
        description: r.description,
        depot_id: r.depotId ? (depots.get(r.depotId) ?? null) : null,
        vehicle_type: r.vehicleType,
        fuel_type: r.fuelType,
        make: r.make,
        model: r.model,
        interval_km: r.intervalKm,
        lead_km: r.leadKm,
        interval_days: r.intervalDays,
        lead_days: r.leadDays,
        interval_engine_hours: r.intervalEngineHours,
        lead_engine_hours: r.leadEngineHours,
        tasks: r.tasks,
        is_active: r.isActive,
        vehicles: { total: c.upcoming + c.due + c.overdue, ...c },
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  private async dueViews(db: Queryable, rows: readonly DueRow[]): Promise<ServiceDueView[]> {
    if (rows.length === 0) return [];
    const vehicleIds = [...new Set(rows.map((r) => r.vehicleId))];
    const fleet = new Map((await this.deps.vehicles.service(db, vehicleIds)).map((v) => [v.id, v]));
    const depots = await this.deps.depots.publicIds(db, [...new Set([...fleet.values()].map((v) => v.depotId))]);
    const open = new Map((await this.deps.programs.openServices(db, vehicleIds)).map((o) => [`${o.vehicleId}:${o.programId}`, o]));
    const now = this.now().getTime();
    // A row of a vehicle retired since the job ran is not shown; the next run removes it.
    return rows.flatMap((r) => {
      const v = fleet.get(r.vehicleId);
      if (!v) return [];
      const booked = open.get(`${r.vehicleId}:${r.programId}`);
      return [
        {
          vehicle_id: v.publicId,
          registration_number: v.registrationNumber,
          depot_id: depots.get(v.depotId)!,
          program: { id: r.programPublicId, name: r.programName, tasks: r.programTasks },
          status: r.status,
          due_by: r.dueBy,
          last_service: r.lastRecordPublicId && r.lastCompletedAt ? { maintenance_record_id: r.lastRecordPublicId, completed_at: r.lastCompletedAt } : null,
          since: { at: r.sinceAt, odometer_km: r.sinceKm, engine_hours: r.sinceEngineHours },
          next_due: { odometer_km: r.nextDueKm, at: r.nextDueAt, engine_hours: r.nextDueEngineHours },
          readings: { odometer_km: r.odometerKm, engine_hours: r.engineHours },
          remaining: {
            km: r.nextDueKm === null ? null : Math.round((r.nextDueKm - r.odometerKm) * 10) / 10,
            days: r.nextDueAt === null ? null : Math.floor((r.nextDueAt.getTime() - now) / DAY_MS),
            engine_hours: r.nextDueEngineHours === null || r.engineHours === null ? null : Math.round((r.nextDueEngineHours - r.engineHours) * 10) / 10,
          },
          open_record: booked ? { id: booked.publicId, status: booked.status, scheduled_at: booked.scheduledAt } : null,
          status_changed_at: r.statusChangedAt,
          computed_at: r.computedAt,
        },
      ];
    });
  }
}

/** A program the caller may see: fleet-wide, or of a depot in their scope. */
function visible(row: ProgramRow, scope: Scope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind !== 'depot') return false;
  return row.depotId === null || row.depotId === scope.depotId;
}

function ctxOf(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

/**
 * The interval columns after a write: each measure's interval and lead window, the lead defaulting to a
 * tenth of its interval (or the stored lead, when it still fits). At least one interval must remain.
 */
function intervals(input: ProgramUpdate, row: ProgramRow | null): ProgramWrite {
  const stored: Record<string, number | null> = row
    ? {
        interval_km: row.intervalKm,
        lead_km: row.leadKm,
        interval_days: row.intervalDays,
        lead_days: row.leadDays,
        interval_engine_hours: row.intervalEngineHours,
        lead_engine_hours: row.leadEngineHours,
      }
    : {};
  const out: Record<string, number | null> = {};
  for (const [i, l] of MEASURES) {
    const interval = input[i] !== undefined ? input[i] : (stored[i] ?? null);
    let lead = input[l] !== undefined ? input[l] : undefined;
    if (interval === null) {
      if (lead !== undefined && lead !== null) throw leadWithoutInterval(l);
      lead = null;
    } else if (lead === undefined || lead === null) {
      const kept = stored[l] ?? null;
      lead = kept !== null && kept < interval ? kept : defaultLead(interval);
    }
    if (interval !== null && lead! >= interval) throw leadNotBelowInterval(l);
    out[i] = interval;
    out[l] = lead;
  }
  if (out.interval_km === null && out.interval_days === null && out.interval_engine_hours === null) throw intervalRequired();
  return out as ProgramWrite;
}

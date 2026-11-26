import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  EV_EVENTS,
  SESSION_STAGE,
  SESSION_TRANSITIONS,
  SUMMARY_DAYS_DEFAULT,
  THRESHOLD_FRESH_MS,
  alreadyCharging,
  canMove,
  duplicateExternalSession,
  evVehicleMissing,
  byChargeAscending,
  evVehicleNotFound,
  evVehicleRetired,
  illegalTransition,
  isFinal,
  notElectric,
  sessionDateRange,
  sessionFinal,
  sessionNotFound,
  stationNotFound,
  type BatteryLogView,
  type BatterySummary,
  type EvFleetVehicle,
  type RecordSource,
  type SessionStatus,
  type SessionView,
  type StationView,
} from '../domain/ev';
import type { BatteryLogRow, EvRepository, SessionRow } from '../infrastructure/ev.repository';
import {
  CAPACITY_DAYS,
  CONSUMPTION_DAYS,
  DEFAULT_BATTERY_THRESHOLDS,
  crossings,
  estimateRange,
  rangeShortfall,
  type BatteryThresholds,
  type RangeEstimate,
  type RangeGap,
  type ThresholdCrossing,
} from '../domain/range';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** What the EV module reads of the fleet (fleet's evRefs). */
export interface EvVehicles {
  find(db: Queryable, publicId: string, scope: Scope): Promise<{ id: string; publicId: string; registrationNumber: string; fuelType: string; isActive: boolean } | null>;
  lock(client: PoolClient, publicId: string, scope: Scope): Promise<{ id: string; isActive: boolean; status: string; fuelType: string } | null>;
  idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
  refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
  /** FMS-99: the scope's electric vehicles in service, by plate. */
  electricInScope(
    db: Queryable,
    scope: Scope,
  ): Promise<{ id: string; publicId: string; registrationNumber: string; make: string; model: string; depotId: string | null; depotName: string | null }[]>;
}

export interface BatteryLogCreate {
  vehicle_id: string;
  state_of_charge: number;
  battery_health?: number | null;
  battery_temperature_c?: number | null;
  voltage_v?: number | null;
  current_a?: number | null;
  estimated_range_km?: number | null;
  energy_wh_per_km?: number | null;
  recorded_at?: Date;
  /** manual (the default) or synthetic (the generator, FMS-97). */
  source?: 'manual' | 'synthetic';
}

export interface SessionCreate {
  vehicle_id: string;
  station_id?: string | null;
  status?: 'planned' | 'in_progress';
  started_at?: Date;
  start_soc?: number | null;
  external_session_id?: string | null;
  source?: 'manual' | 'synthetic';
}

/** One session event from a charging provider's webhook (FMS-97), as the integration gateway stored it. */
export interface ProviderSessionDelivery {
  /** The provider (internal id) and its code; its stations are its own (ev.charging_stations.provider_id). */
  providerId: string;
  providerCode: string;
  /** The simulated network's deliveries are synthetic; a real provider's are not. */
  synthetic: boolean;
  kind: 'session_started' | 'session_completed' | 'session_failed';
  correlationId: string;
  session: {
    session_id: string;
    vehicle_id: string;
    station_id?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
    energy_kwh?: number | null;
    cost_cents?: number | null;
    start_soc?: number | null;
    end_soc?: number | null;
  };
}

/** What a provider's delivery did: created or moved a session, changed nothing, or was skipped (and why). */
export type ProviderSessionOutcome =
  | { result: 'created' | 'updated' | 'unchanged'; sessionId: string }
  | { result: 'skipped'; reason: 'vehicle_unknown' | 'not_electric' | 'vehicle_retired' | 'session_final' | 'session_behind' };

export interface SessionUpdate {
  status?: SessionStatus;
  station_id?: string | null;
  started_at?: Date;
  ended_at?: Date;
  energy_kwh?: number | null;
  cost_cents?: number | null;
  start_soc?: number | null;
  end_soc?: number | null;
}

/** A vehicle's trip under way (FMS-98's en-route check): the trip's public id and the km left, if known. */
export interface EvTripUnderWay {
  tripId: string;
  remainingKm: number | null;
}

export interface EvServiceDeps {
  ev: EvRepository;
  vehicles: EvVehicles;
  events: EventBus;
  /** The thresholds (settings ev_low_soc_pct, ev_battery_health_min_pct). Absent: the defaults. */
  thresholds?: () => Promise<BatteryThresholds>;
  /** The trip each vehicle (internal ids) has under way, from the trip module. Absent: no en-route check. */
  tripsUnderWay?: (db: Queryable, vehicleIds: readonly string[]) => Promise<Map<string, EvTripUnderWay>>;
  now?: () => Date;
}

const ctxOf = (caller: Caller): MutationContext => ({ userId: caller.user.id, correlationId: caller.correlationId });
const DAY_MS = 86_400_000;

/**
 * EV fleet management (FMS-96, docs/ev.md): battery observations and charging sessions of electric vehicles in the
 * caller's depots (ev:read, ev:write), and the charging stations (shared by every depot).
 */
export class EvService {
  constructor(private readonly deps: EvServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private event(caller: Caller, type: string, vehiclePublicId: string, payload: Record<string, unknown>) {
    return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId }, { aggregate: aggregateKey('vehicle', vehiclePublicId) });
  }

  /** An electric vehicle of the caller's depots, locked for a write. */
  private async writableVehicle(client: PoolClient, caller: Caller, publicId: string) {
    const vehicle = await this.deps.vehicles.lock(client, publicId, depotScope(caller.user));
    if (!vehicle) throw evVehicleNotFound();
    if (vehicle.fuelType !== 'electric') throw notElectric();
    if (!vehicle.isActive || vehicle.status === 'retired') throw evVehicleRetired();
    return vehicle;
  }

  private async logViews(db: Queryable, rows: BatteryLogRow[]): Promise<BatteryLogView[]> {
    const refs = await this.deps.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    return rows.map(({ vehicleId, ...r }) => ({ ...r, vehicle_id: refs.get(vehicleId)!.publicId, registration_number: refs.get(vehicleId)!.registrationNumber }));
  }

  private async sessionViews(db: Queryable, rows: SessionRow[]): Promise<SessionView[]> {
    const refs = await this.deps.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    return rows.map((row) => {
      const { vehicleId, ...rest } = row;
      const r = { ...rest } as Partial<SessionRow>;
      delete r.internalId;
      return { ...(r as Omit<SessionRow, 'vehicleId' | 'internalId'>), vehicle_id: refs.get(vehicleId)!.publicId,
      registration_number: refs.get(vehicleId)!.registrationNumber,
      allowed_transitions: [...SESSION_TRANSITIONS[row.status]],
      };
    });
  }

  /** POST /ev/battery-logs: only an electric vehicle has a battery to log. Publishes BatteryLogged. */
  async logBattery(caller: Caller, input: BatteryLogCreate): Promise<BatteryLogView> {
    const { ev } = this.deps;
    return ev.inTransaction(async (client) => {
      const vehicle = await this.writableVehicle(client, caller, input.vehicle_id);
      const id = await ev.insertLog(client, ctxOf(caller), {
        vehicle_id: vehicle.id,
        state_of_charge: input.state_of_charge,
        battery_health: input.battery_health ?? null,
        battery_temperature_c: input.battery_temperature_c ?? null,
        voltage_v: input.voltage_v ?? null,
        current_a: input.current_a ?? null,
        estimated_range_km: input.estimated_range_km ?? null,
        energy_wh_per_km: input.energy_wh_per_km ?? null,
        source: input.source ?? 'manual',
        recorded_at: input.recorded_at ?? this.now(),
      });
      const [view] = await this.logViews(client, [(await ev.log(client, id))!]);
      await this.deps.events.publish(client, [
        this.event(caller, EV_EVENTS.batteryLogged, view.vehicle_id, {
          battery_log_id: view.id,
          vehicle_id: view.vehicle_id,
          state_of_charge: view.state_of_charge,
          battery_health: view.battery_health,
          estimated_range_km: view.estimated_range_km,
          source: view.source,
          recorded_at: view.recorded_at.toISOString(),
        }),
      ]);
      return view;
    });
  }

  /** GET /ev/battery-logs: the scope's vehicles, or one of them, newest first. */
  async batteryLogs(caller: Caller, query: { vehicle_id?: string; from?: Date; to?: Date } & Page): Promise<{ items: BatteryLogView[]; total: number }> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleIds: string[] | null;
      if (query.vehicle_id) {
        const vehicle = await vehicles.find(client, query.vehicle_id, scope);
        vehicleIds = vehicle ? [vehicle.id] : [];
      } else {
        vehicleIds = await vehicles.idsInScope(client, scope);
      }
      const { rows, total } = await ev.logs(client, { vehicleIds, from: query.from, to: query.to, page: query.page, page_size: query.page_size });
      return { items: await this.logViews(client, rows), total };
    });
  }

  /** GET /ev/charging-stations: every station (they are not a depot's). */
  stations(query: { status?: string } & Page): Promise<{ rows: StationView[]; total: number }> {
    return this.deps.ev.inTransaction((client) => this.deps.ev.stations(client, query));
  }

  /** POST /ev/charging-sessions: planned, or started now (`in_progress`). A vehicle charges in one session at a time. */
  async createSession(caller: Caller, input: SessionCreate): Promise<SessionView> {
    const { ev } = this.deps;
    const status = input.status ?? 'planned';
    return ev.inTransaction(async (client) => {
      const vehicle = await this.writableVehicle(client, caller, input.vehicle_id);
      const stationId = input.station_id ? await ev.stationId(client, input.station_id) : null;
      if (input.station_id && !stationId) throw stationNotFound();
      if (input.external_session_id && (await ev.externalSessionTaken(client, input.external_session_id))) throw duplicateExternalSession();
      if (status === 'in_progress') {
        const other = await ev.chargingNow(client, vehicle.id, null);
        if (other) throw alreadyCharging(other);
      }
      const id = await ev.insertSession(client, ctxOf(caller), {
        vehicle_id: vehicle.id,
        station_id: stationId,
        status,
        started_at: status === 'in_progress' ? (input.started_at ?? this.now()) : (input.started_at ?? null),
        start_soc: input.start_soc ?? null,
        external_session_id: input.external_session_id ?? null,
        source: input.source ?? 'manual',
      });
      const [view] = await this.sessionViews(client, [(await ev.session(client, id))!]);
      if (status === 'in_progress') await this.deps.events.publish(client, [this.sessionEvent(caller, EV_EVENTS.sessionStarted, view)]);
      return view;
    });
  }

  /** A session event: a caller's change, or (no actor, a fixed id) a provider's delivery. */
  private sessionEvent(by: Caller | { system: true; correlationId: string; id: string }, type: string, view: SessionView) {
    const payload = {
      charging_session_id: view.id,
      vehicle_id: view.vehicle_id,
      station_id: view.station?.id ?? null,
      status: view.status,
      started_at: view.started_at ? view.started_at.toISOString() : null,
      ended_at: view.ended_at ? view.ended_at.toISOString() : null,
      energy_kwh: view.energy_kwh,
      cost_cents: view.cost_cents,
      start_soc: view.start_soc,
      end_soc: view.end_soc,
      source: view.source,
    };
    if ('user' in by) return this.event(by, type, view.vehicle_id, payload);
    return createEvent(type, payload, { actor: null, correlationId: by.correlationId }, { id: by.id, aggregate: aggregateKey('vehicle', view.vehicle_id) });
  }

  /**
   * A charging provider's session event (FMS-97, docs/ev.md#the-charging-webhook), on the transaction of the
   * IntegrationWebhookReceived consumer. The session is the provider's (`external_session_id`): the first delivery
   * creates it, a later one moves it forward and fills in its figures. A redelivery, a replay under a new event id,
   * or a delivery that arrives after a later one changes nothing, so no delivery makes a second session. Audited with
   * no user, as the webhook's receipt is; its event has no actor and an id fixed by the session and the status.
   */
  async applyProviderSession(client: PoolClient, delivery: ProviderSessionDelivery): Promise<ProviderSessionOutcome> {
    const { ev, vehicles } = this.deps;
    const s = delivery.session;
    const ctx: MutationContext = { userId: null, correlationId: delivery.correlationId };
    const target: SessionStatus = delivery.kind === 'session_started' ? 'in_progress' : delivery.kind === 'session_completed' ? 'completed' : 'failed';

    const vehicle = await vehicles.lock(client, s.vehicle_id, { kind: 'all' });
    if (!vehicle) return { result: 'skipped', reason: 'vehicle_unknown' };
    if (vehicle.fuelType !== 'electric') return { result: 'skipped', reason: 'not_electric' };
    const stationId = s.station_id ? await ev.providerStationId(client, delivery.providerId, s.station_id) : null;
    const at = (value: string | null | undefined) => (value ? new Date(value) : null);
    const figures: Record<string, unknown> = {};
    for (const key of ['energy_kwh', 'cost_cents', 'start_soc', 'end_soc'] as const) if (s[key] !== undefined && s[key] !== null) figures[key] = s[key];

    const existing = await ev.lockExternalSession(client, s.session_id);
    let id: string;
    if (!existing) {
      if (!vehicle.isActive || vehicle.status === 'retired') return { result: 'skipped', reason: 'vehicle_retired' };
      const endedAt = target === 'in_progress' ? null : (at(s.ended_at) ?? this.now());
      const startedAt = at(s.started_at) ?? (target === 'in_progress' ? this.now() : endedAt);
      id = await ev.insertSession(client, ctx, {
        vehicle_id: vehicle.id,
        station_id: stationId,
        status: target,
        started_at: startedAt && endedAt && endedAt < startedAt ? endedAt : startedAt,
        ended_at: endedAt,
        external_session_id: s.session_id,
        source: delivery.synthetic ? 'synthetic' : ('provider' satisfies RecordSource),
        ...figures,
      });
    } else {
      id = existing.id;
      if (existing.status === target) {
        // The same news again (a replay under a new event id): only figures the provider has filled in since.
        const filled = Object.fromEntries(Object.entries(figures).filter(([key]) => existing[key as 'energy_kwh'] === null));
        if (Object.keys(filled).length === 0) return { result: 'unchanged', sessionId: id };
        await ev.updateSession(client, ctx, existing.internalId, filled);
        return { result: 'updated', sessionId: id };
      }
      if (SESSION_STAGE[target] <= SESSION_STAGE[existing.status]) {
        return { result: 'skipped', reason: SESSION_STAGE[existing.status] === 2 ? 'session_final' : 'session_behind' };
      }
      const data: Record<string, unknown> = { status: target, ...figures };
      if (stationId && !existing.station) data.station_id = stationId;
      const startedAt = existing.started_at ?? at(s.started_at) ?? this.now();
      if (!existing.started_at) data.started_at = startedAt;
      if (target !== 'in_progress') {
        const endedAt = at(s.ended_at) ?? this.now();
        data.ended_at = endedAt < startedAt ? startedAt : endedAt;
      }
      await ev.updateSession(client, ctx, existing.internalId, data);
    }

    const [view] = await this.sessionViews(client, [(await ev.session(client, id))!]);
    const type = target === 'in_progress' ? EV_EVENTS.sessionStarted : target === 'completed' ? EV_EVENTS.sessionCompleted : EV_EVENTS.sessionFailed;
    const eventId = deterministicEventId(`ev-session:${delivery.providerCode}:${s.session_id}:${target}`);
    await this.deps.events.publish(client, [this.sessionEvent({ system: true, correlationId: delivery.correlationId, id: eventId }, type, view)]);
    return { result: existing ? 'updated' : 'created', sessionId: id };
  }

  /**
   * PATCH /ev/charging-sessions/{id}: its figures, and its status along the state machine (planned → in_progress or
   * cancelled; in_progress → completed or failed). Any other move, or any change to a final session, is 409.
   */
  async updateSession(caller: Caller, publicId: string, input: SessionUpdate): Promise<SessionView> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const row = await ev.session(client, publicId, true);
      if (!row) throw sessionNotFound();
      const refs = await vehicles.refsByIds(client, [row.vehicleId]);
      const inScope = await vehicles.find(client, refs.get(row.vehicleId)!.publicId, depotScope(caller.user));
      if (!inScope) throw sessionNotFound();
      if (isFinal(row.status)) throw sessionFinal(row.status);

      const to = input.status && input.status !== row.status ? input.status : null;
      if (to && !canMove(row.status, to)) throw illegalTransition(row.status, to);
      if (to === 'in_progress') {
        const other = await ev.chargingNow(client, row.vehicleId, row.id);
        if (other) throw alreadyCharging(other);
      }

      const data: Record<string, unknown> = {};
      if (to) data.status = to;
      if (input.station_id !== undefined) {
        const stationId = input.station_id ? await ev.stationId(client, input.station_id) : null;
        if (input.station_id && !stationId) throw stationNotFound();
        data.station_id = stationId;
      }
      for (const key of ['energy_kwh', 'cost_cents', 'start_soc', 'end_soc'] as const) if (input[key] !== undefined) data[key] = input[key];
      const startedAt = input.started_at ?? row.started_at ?? (to === 'in_progress' || to === 'completed' || to === 'failed' ? this.now() : null);
      if (startedAt !== row.started_at) data.started_at = startedAt;
      const endedAt = input.ended_at ?? (to === 'completed' || to === 'failed' ? this.now() : row.ended_at);
      if (endedAt !== row.ended_at) data.ended_at = endedAt;
      if (startedAt && endedAt && endedAt.getTime() < startedAt.getTime()) throw sessionDateRange();

      if (Object.keys(data).length > 0) await ev.updateSession(client, ctxOf(caller), row.internalId, data);
      const [view] = await this.sessionViews(client, [(await ev.session(client, publicId))!]);
      const type = to === 'in_progress' ? EV_EVENTS.sessionStarted : to === 'completed' ? EV_EVENTS.sessionCompleted : to === 'failed' ? EV_EVENTS.sessionFailed : null;
      if (type) await this.deps.events.publish(client, [this.sessionEvent(caller, type, view)]);
      return view;
    });
  }

  /** GET /vehicles/{id}/charging-sessions: newest first. */
  async sessionsOf(caller: Caller, vehiclePublicId: string, query: { status?: SessionStatus } & Page): Promise<{ items: SessionView[]; total: number }> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const vehicle = await vehicles.find(client, vehiclePublicId, depotScope(caller.user));
      if (!vehicle) throw evVehicleMissing();
      const { rows, total } = await ev.sessionsOf(client, vehicle.id, query);
      return { items: await this.sessionViews(client, rows), total };
    });
  }

  /**
   * GET /ev/fleet (FMS-99): the caller's electric vehicles in service, or one depot's, each with its newest battery
   * reading and the session charging it now, lowest charge first.
   */
  async fleet(caller: Caller, query: { depot_id?: string }): Promise<EvFleetVehicle[]> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const all = await vehicles.electricInScope(client, depotScope(caller.user));
      const list = query.depot_id ? all.filter((v) => v.depotId === query.depot_id) : all;
      const ids = list.map((v) => v.id);
      const logs = await ev.latestLogs(client, ids);
      const sessions = await ev.chargingSessions(client, ids);
      return list
        .map((v): EvFleetVehicle => {
          const log = logs.get(v.id);
          const session = sessions.get(v.id);
          return {
            vehicle_id: v.publicId,
            registration_number: v.registrationNumber,
            make: v.make,
            model: v.model,
            depot: v.depotId ? { id: v.depotId, name: v.depotName ?? '' } : null,
            latest: log
              ? { state_of_charge: log.state_of_charge, battery_health: log.battery_health, estimated_range_km: log.estimated_range_km, recorded_at: log.recorded_at, source: log.source }
              : null,
            charging: session ? { id: session.id, station: session.station, started_at: session.started_at, start_soc: session.start_soc, source: session.source } : null,
          };
        })
        .sort(byChargeAscending);
    });
  }

  /** GET /ev/charging-sessions (FMS-99): the sessions of the caller's vehicles, or one's, newest first. */
  async sessions(
    caller: Caller,
    query: { vehicle_id?: string; status?: SessionStatus; from?: Date; to?: Date } & Page,
  ): Promise<{ items: SessionView[]; total: number }> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleIds: string[] | null;
      if (query.vehicle_id) {
        const vehicle = await vehicles.find(client, query.vehicle_id, scope);
        vehicleIds = vehicle ? [vehicle.id] : [];
      } else vehicleIds = await vehicles.idsInScope(client, scope);
      const { rows, total } = await ev.sessions(client, { ...query, vehicleIds });
      return { items: await this.sessionViews(client, rows), total };
    });
  }

  /**
   * Range estimates (FMS-98) for vehicles (internal ids): each one's estimate, or null with why. For the battery
   * summary, the assignment warning (trip) and the dispatch board (fleet). A vehicle with no battery reading has none.
   */
  async ranges(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, { estimate: RangeEstimate | null; gap: RangeGap | null }>> {
    const now = this.now().getTime();
    const inputs = await this.deps.ev.rangeInputs(db, vehicleIds, new Date(now - CONSUMPTION_DAYS * DAY_MS), new Date(now - CAPACITY_DAYS * DAY_MS));
    return new Map([...inputs].map(([id, i]) => [id, estimateRange(i)]));
  }

  /** PUT /vehicles/{id}/battery-spec: the usable capacity when new, which range estimates scale by health. */
  async setSpec(caller: Caller, vehiclePublicId: string, usableCapacityKwh: number): Promise<{ vehicle_id: string; usable_capacity_kwh: number; updated_at: Date }> {
    const { ev } = this.deps;
    return ev.inTransaction(async (client) => {
      const vehicle = await this.writableVehicle(client, caller, vehiclePublicId);
      const existing = await ev.spec(client, vehicle.id);
      if (!existing) await ev.insertSpec(client, ctxOf(caller), { vehicle_id: vehicle.id, usable_capacity_kwh: usableCapacityKwh });
      else if (existing.usable_capacity_kwh !== usableCapacityKwh) await ev.updateSpec(client, ctxOf(caller), existing.id, { usable_capacity_kwh: usableCapacityKwh });
      const spec = (await ev.spec(client, vehicle.id))!;
      if (!existing || existing.usable_capacity_kwh !== usableCapacityKwh) {
        await this.deps.events.publish(client, [
          this.event(caller, EV_EVENTS.specSet, vehiclePublicId, { vehicle_id: vehiclePublicId, usable_capacity_kwh: spec.usable_capacity_kwh, previous_kwh: existing?.usable_capacity_kwh ?? null }),
        ]);
      }
      return { vehicle_id: vehiclePublicId, usable_capacity_kwh: spec.usable_capacity_kwh, updated_at: spec.updated_at };
    });
  }

  /**
   * BatteryLogged's consumer (FMS-98, docs/ev.md#alerts): a fresh reading below the low-charge line, or a battery worn
   * below the health line, when the reading before was not, publishes BatteryThresholdExceeded; so does a range short
   * of the km left on the vehicle's trip under way. The alert engine turns them into `battery` alerts. Each event's
   * id is fixed by the reading and metric, so a redelivery publishes nothing new.
   */
  async onBatteryLogged(client: PoolClient, event: { correlation_id: string; payload: Record<string, unknown> }): Promise<ThresholdCrossing[]> {
    const { ev } = this.deps;
    const logId = event.payload.battery_log_id as string;
    const log = await ev.log(client, logId);
    if (!log || this.now().getTime() - log.recorded_at.getTime() > THRESHOLD_FRESH_MS) return [];
    const thresholds = (await this.deps.thresholds?.()) ?? DEFAULT_BATTERY_THRESHOLDS;
    const previous = await ev.previousLog(client, logId);
    const found = crossings(log, previous, thresholds);
    let tripId: string | null = null;
    const trip = (await this.deps.tripsUnderWay?.(client, [log.vehicleId]))?.get(log.vehicleId);
    if (trip && trip.remainingKm !== null) {
      const range = (await this.ranges(client, [log.vehicleId])).get(log.vehicleId)?.estimate;
      const short = range ? rangeShortfall(range.range_km, trip.remainingKm) : null;
      if (short) {
        found.push(short);
        tripId = trip.tripId;
      }
    }
    if (found.length === 0) return [];
    const vehicle = (await this.deps.vehicles.refsByIds(client, [log.vehicleId])).get(log.vehicleId)!;
    await this.deps.events.publish(
      client,
      found.map((c) =>
        createEvent(
          EV_EVENTS.thresholdExceeded,
          {
            vehicle_id: vehicle.publicId,
            trip_id: c.metric === 'range' ? tripId : null,
            metric: c.metric,
            value: c.value,
            threshold: c.threshold,
            severity: c.severity,
            battery_log_id: logId,
            recorded_at: log.recorded_at.toISOString(),
          },
          { actor: null, correlationId: event.correlation_id },
          { id: deterministicEventId(`battery-threshold:${logId}:${c.metric}`), aggregate: aggregateKey('vehicle', vehicle.publicId) },
        ),
      ),
    );
    return found;
  }

  /** GET /vehicles/{id}/battery-summary: the latest state, the daily SoC trend, the health and its change, recent charging. */
  async summary(caller: Caller, vehiclePublicId: string, days = SUMMARY_DAYS_DEFAULT): Promise<BatterySummary> {
    const { ev, vehicles } = this.deps;
    return ev.inTransaction(async (client) => {
      const vehicle = await vehicles.find(client, vehiclePublicId, depotScope(caller.user));
      if (!vehicle) throw evVehicleMissing();
      if (vehicle.fuelType !== 'electric') throw notElectric('vehicle_id');
      const since = new Date(this.now().getTime() - days * DAY_MS);
      const s = await ev.summary(client, vehicle.id, since);
      const change = s.health.current !== null && s.health.at_start !== null ? Math.round((s.health.current - s.health.at_start) * 100) / 100 : null;
      const range = (await this.ranges(client, [vehicle.id])).get(vehicle.id);
      const spec = await ev.spec(client, vehicle.id);
      return {
        vehicle_id: vehicle.publicId,
        registration_number: vehicle.registrationNumber,
        days,
        latest: s.latest,
        soc_trend: s.trend,
        health: { current: s.health.current, at_start: s.health.at_start, change },
        charging: s.charging,
        range: range?.estimate ?? null,
        range_gap: range ? range.gap : 'no_reading',
        battery_spec: spec ? { usable_capacity_kwh: spec.usable_capacity_kwh, updated_at: spec.updated_at } : null,
      };
    });
  }
}

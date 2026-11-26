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
  alreadyCharging,
  canMove,
  duplicateExternalSession,
  evVehicleMissing,
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
  type RecordSource,
  type SessionStatus,
  type SessionView,
  type StationView,
} from '../domain/ev';
import type { BatteryLogRow, EvRepository, SessionRow } from '../infrastructure/ev.repository';

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

export interface EvServiceDeps {
  ev: EvRepository;
  vehicles: EvVehicles;
  events: EventBus;
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
      return {
        vehicle_id: vehicle.publicId,
        registration_number: vehicle.registrationNumber,
        days,
        latest: s.latest,
        soc_trend: s.trend,
        health: { current: s.health.current, at_start: s.health.at_start, change },
        charging: s.charging,
      };
    });
  }
}

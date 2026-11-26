import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { RecordSource, SessionStatus, StationView } from '../domain/ev';

/** A row as stored, with the vehicle's internal id: the service turns it into public ids and a plate. */
export interface BatteryLogRow {
  id: string;
  vehicleId: string;
  state_of_charge: number;
  battery_health: number | null;
  battery_temperature_c: number | null;
  voltage_v: number | null;
  current_a: number | null;
  estimated_range_km: number | null;
  energy_wh_per_km: number | null;
  source: RecordSource;
  recorded_at: Date;
}

export interface SessionRow {
  internalId: string;
  id: string;
  vehicleId: string;
  station: { id: string; name: string } | null;
  status: SessionStatus;
  started_at: Date | null;
  ended_at: Date | null;
  energy_kwh: number | null;
  cost_cents: number | null;
  start_soc: number | null;
  end_soc: number | null;
  external_session_id: string | null;
  source: RecordSource;
  created_at: Date;
  updated_at: Date;
}

const LOG_COLUMNS = `l.public_id AS id, l.vehicle_id AS "vehicleId", l.state_of_charge::float8 AS state_of_charge,
         l.battery_health::float8 AS battery_health, l.battery_temperature_c::float8 AS battery_temperature_c,
         l.voltage_v::float8 AS voltage_v, l.current_a::float8 AS current_a, l.estimated_range_km::float8 AS estimated_range_km,
         l.energy_wh_per_km::float8 AS energy_wh_per_km, l.source, l.recorded_at`;

const LOG_SQL = `
  SELECT ${LOG_COLUMNS}
    FROM ev.ev_battery_logs l`;

const SESSION_SQL = `
  SELECT s.id AS "internalId", s.public_id AS id, s.vehicle_id AS "vehicleId",
         CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('id', st.public_id, 'name', st.name) END AS station,
         s.status, s.started_at, s.ended_at, s.energy_kwh::float8 AS energy_kwh, s.cost_cents, s.start_soc::float8 AS start_soc,
         s.end_soc::float8 AS end_soc, s.external_session_id, s.source, s.created_at, s.updated_at
    FROM ev.charging_sessions s
    LEFT JOIN ev.charging_stations st ON st.id = s.station_id`;

/** An EV's raw facts for the predictive maintenance model (FMS-135); the maintenance module computes the inputs from them. */
export interface EvScoringRow {
  newestHealth: number | null;
  oldestHealth: number | null;
  healthReadings: number;
  hotHours: number;
  energySumWhPerKm: number;
  energyReadings: number;
  sessionEnergyKwh: number;
  dcFastEnergyKwh: number;
  deepDischarges: number;
  failedSessions: number;
}

/** `vehicleIds` null means every vehicle (an unscoped caller); an empty list, none. */
function vehicleFilter(column: string, vehicleIds: readonly string[] | null, params: unknown[]): string {
  if (vehicleIds === null) return 'TRUE';
  params.push(vehicleIds);
  return `${column} = ANY($${params.length}::bigint[])`;
}

/** The ev schema (FMS-96): battery logs, charging stations and sessions. Every write is audited. */
export class EvRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async insertLog(client: PoolClient, ctx: MutationContext, data: Row): Promise<string> {
    const row = await this.mutate(ctx, 'ev.ev_battery_logs', 'INSERT', null, data, client);
    return row.public_id as string;
  }

  async log(db: Queryable, publicId: string): Promise<BatteryLogRow | null> {
    return (await db.query<BatteryLogRow>(`${LOG_SQL} WHERE l.public_id = $1`, [publicId])).rows[0] ?? null;
  }

  async logs(db: Queryable, filter: { vehicleIds: readonly string[] | null; from?: Date; to?: Date } & Page): Promise<{ rows: BatteryLogRow[]; total: number }> {
    const params: unknown[] = [];
    const where = [vehicleFilter('l.vehicle_id', filter.vehicleIds, params)];
    if (filter.from) {
      params.push(filter.from);
      where.push(`l.recorded_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`l.recorded_at < $${params.length}`);
    }
    const { limit, offset } = limitOffset(filter);
    const rows = await db.query<BatteryLogRow>(`${LOG_SQL} WHERE ${where.join(' AND ')} ORDER BY l.recorded_at DESC, l.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ev.ev_battery_logs l WHERE ${where.join(' AND ')}`, params);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async stations(db: Queryable, filter: { status?: string } & Page): Promise<{ rows: StationView[]; total: number }> {
    const params: unknown[] = [];
    const where = ['TRUE'];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const { limit, offset } = limitOffset(filter);
    const rows = await db.query<StationView>(
      `SELECT public_id AS id, name, external_station_id, latitude::float8 AS latitude, longitude::float8 AS longitude, connector_type,
              power_kw::float8 AS power_kw, status, source
         FROM ev.charging_stations WHERE ${where.join(' AND ')} ORDER BY name, id LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ev.charging_stations WHERE ${where.join(' AND ')}`, params);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async stationId(db: Queryable, publicId: string): Promise<string | null> {
    return (await db.query<{ id: string }>('SELECT id FROM ev.charging_stations WHERE public_id = $1', [publicId])).rows[0]?.id ?? null;
  }

  async insertSession(client: PoolClient, ctx: MutationContext, data: Row): Promise<string> {
    const row = await this.mutate(ctx, 'ev.charging_sessions', 'INSERT', null, data, client);
    return row.public_id as string;
  }

  async updateSession(client: PoolClient, ctx: MutationContext, internalId: string, data: Row): Promise<void> {
    await this.mutate(ctx, 'ev.charging_sessions', 'UPDATE', internalId, data, client);
  }

  async session(db: Queryable, publicId: string, lock = false): Promise<SessionRow | null> {
    return (await db.query<SessionRow>(`${SESSION_SQL} WHERE s.public_id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [publicId])).rows[0] ?? null;
  }

  /** The session already charging the vehicle (internal id), other than `except`. */
  async chargingNow(db: Queryable, vehicleId: string, except: string | null): Promise<string | null> {
    const res = await db.query<{ id: string }>(
      "SELECT public_id AS id FROM ev.charging_sessions WHERE vehicle_id = $1 AND status = 'in_progress' AND ($2::uuid IS NULL OR public_id <> $2) LIMIT 1",
      [vehicleId, except],
    );
    return res.rows[0]?.id ?? null;
  }

  /** A provider's station (FMS-97) by its own id: internal id, or null when the provider has no such station. */
  async providerStationId(db: Queryable, providerId: string, externalStationId: string): Promise<string | null> {
    const res = await db.query<{ id: string }>('SELECT id FROM ev.charging_stations WHERE provider_id = $1 AND external_station_id = $2', [providerId, externalStationId]);
    return res.rows[0]?.id ?? null;
  }

  /**
   * A provider's session by its id, locked (FMS-97). The transaction first takes an advisory lock on the id, so two
   * deliveries of a session not yet stored (its start and its end, arriving together) cannot both insert it.
   */
  async lockExternalSession(client: PoolClient, externalId: string): Promise<SessionRow | null> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ev.charging_sessions:' || $1, 0))", [externalId]);
    return (await client.query<SessionRow>(`${SESSION_SQL} WHERE s.external_session_id = $1 FOR UPDATE OF s`, [externalId])).rows[0] ?? null;
  }

  async externalSessionTaken(db: Queryable, externalId: string): Promise<boolean> {
    return (await db.query('SELECT 1 FROM ev.charging_sessions WHERE external_session_id = $1', [externalId])).rowCount !== 0;
  }

  /** Each vehicle's newest battery reading (FMS-99, the EV dashboard), by internal vehicle id. */
  async latestLogs(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, BatteryLogRow>> {
    if (vehicleIds.length === 0) return new Map();
    const rows = await db.query<BatteryLogRow>(
      `SELECT DISTINCT ON (l.vehicle_id) ${LOG_COLUMNS} FROM ev.ev_battery_logs l
        WHERE l.vehicle_id = ANY($1::bigint[])
        ORDER BY l.vehicle_id, l.recorded_at DESC, l.id DESC`,
      [vehicleIds],
    );
    return new Map(rows.rows.map((r) => [r.vehicleId, r]));
  }

  /** The sessions charging now (`in_progress`) of these vehicles (FMS-99), by internal vehicle id: one each at most. */
  async chargingSessions(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, SessionRow>> {
    if (vehicleIds.length === 0) return new Map();
    const rows = await db.query<SessionRow>(
      `${SESSION_SQL} WHERE s.vehicle_id = ANY($1::bigint[]) AND s.status = 'in_progress' ORDER BY s.started_at DESC NULLS LAST, s.id DESC`,
      [vehicleIds],
    );
    const byVehicle = new Map<string, SessionRow>();
    for (const row of rows.rows) if (!byVehicle.has(row.vehicleId)) byVehicle.set(row.vehicleId, row);
    return byVehicle;
  }

  /** The sessions of the scope's vehicles (FMS-99, GET /ev/charging-sessions), newest first. */
  async sessions(
    db: Queryable,
    filter: { vehicleIds: readonly string[] | null; status?: SessionStatus; from?: Date; to?: Date } & Page,
  ): Promise<{ rows: SessionRow[]; total: number }> {
    const params: unknown[] = [];
    const where = [vehicleFilter('s.vehicle_id', filter.vehicleIds, params)];
    if (filter.status) {
      params.push(filter.status);
      where.push(`s.status = $${params.length}::ev.charging_status`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`COALESCE(s.started_at, s.created_at) >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`COALESCE(s.started_at, s.created_at) < $${params.length}`);
    }
    const { limit, offset } = limitOffset(filter);
    const rows = await db.query<SessionRow>(
      `${SESSION_SQL} WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ev.charging_sessions s WHERE ${where.join(' AND ')}`, params);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async sessionsOf(db: Queryable, vehicleId: string, filter: { status?: SessionStatus } & Page): Promise<{ rows: SessionRow[]; total: number }> {
    const params: unknown[] = [vehicleId];
    const where = ['s.vehicle_id = $1'];
    if (filter.status) {
      params.push(filter.status);
      where.push(`s.status = $${params.length}::ev.charging_status`);
    }
    const { limit, offset } = limitOffset(filter);
    const rows = await db.query<SessionRow>(
      `${SESSION_SQL} WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ev.charging_sessions s WHERE ${where.join(' AND ')}`, params);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /** A vehicle's battery spec (FMS-98): its id and usable capacity when new, or null. */
  async spec(db: Queryable, vehicleId: string): Promise<{ id: string; usable_capacity_kwh: number; updated_at: Date } | null> {
    const res = await db.query<{ id: string; usable_capacity_kwh: number; updated_at: Date }>(
      'SELECT id, usable_capacity_kwh::float8 AS usable_capacity_kwh, updated_at FROM ev.battery_specs WHERE vehicle_id = $1',
      [vehicleId],
    );
    return res.rows[0] ?? null;
  }

  async insertSpec(client: PoolClient, ctx: MutationContext, data: Row): Promise<void> {
    await this.mutate(ctx, 'ev.battery_specs', 'INSERT', null, data, client);
  }

  async updateSpec(client: PoolClient, ctx: MutationContext, id: string, data: Row): Promise<void> {
    await this.mutate(ctx, 'ev.battery_specs', 'UPDATE', id, data, client);
  }

  /**
   * What a range estimate (FMS-98) reads for each vehicle (internal ids): the newest reading, the newest health, the
   * energy figures of the readings since `consumptionSince`, the spec, and the completed sessions since `sessionsSince`.
   */
  async rangeInputs(db: Queryable, vehicleIds: readonly string[], consumptionSince: Date, sessionsSince: Date) {
    type Inputs = {
      latest: { state_of_charge: number; battery_health: number | null; recorded_at: Date } | null;
      health: number | null;
      readingsWhPerKm: number[];
      specKwh: number | null;
      sessions: { energy_kwh: number; start_soc: number; end_soc: number }[];
    };
    const out = new Map<string, Inputs>(vehicleIds.map((id) => [id, { latest: null, health: null, readingsWhPerKm: [], specKwh: null, sessions: [] }]));
    if (vehicleIds.length === 0) return out;
    const latest = await db.query<{ vehicle_id: string; state_of_charge: number; battery_health: number | null; recorded_at: Date; health: number | null }>(
      `SELECT DISTINCT ON (l.vehicle_id) l.vehicle_id, l.state_of_charge::float8 AS state_of_charge, l.battery_health::float8 AS battery_health, l.recorded_at,
              (SELECT h.battery_health::float8 FROM ev.ev_battery_logs h WHERE h.vehicle_id = l.vehicle_id AND h.battery_health IS NOT NULL
                ORDER BY h.recorded_at DESC, h.id DESC LIMIT 1) AS health
         FROM ev.ev_battery_logs l WHERE l.vehicle_id = ANY($1::bigint[]) ORDER BY l.vehicle_id, l.recorded_at DESC, l.id DESC`,
      [vehicleIds],
    );
    for (const r of latest.rows) {
      const v = out.get(r.vehicle_id)!;
      v.latest = { state_of_charge: r.state_of_charge, battery_health: r.battery_health, recorded_at: r.recorded_at };
      v.health = r.health;
    }
    const energy = await db.query<{ vehicle_id: string; wh: number }>(
      `SELECT vehicle_id, energy_wh_per_km::float8 AS wh FROM ev.ev_battery_logs
        WHERE vehicle_id = ANY($1::bigint[]) AND recorded_at >= $2 AND energy_wh_per_km IS NOT NULL`,
      [vehicleIds, consumptionSince],
    );
    for (const r of energy.rows) out.get(r.vehicle_id)!.readingsWhPerKm.push(r.wh);
    const specs = await db.query<{ vehicle_id: string; kwh: number }>(
      'SELECT vehicle_id, usable_capacity_kwh::float8 AS kwh FROM ev.battery_specs WHERE vehicle_id = ANY($1::bigint[])',
      [vehicleIds],
    );
    for (const r of specs.rows) out.get(r.vehicle_id)!.specKwh = r.kwh;
    const sessions = await db.query<{ vehicle_id: string; energy_kwh: number; start_soc: number; end_soc: number }>(
      `SELECT vehicle_id, energy_kwh::float8 AS energy_kwh, start_soc::float8 AS start_soc, end_soc::float8 AS end_soc
         FROM ev.charging_sessions
        WHERE vehicle_id = ANY($1::bigint[]) AND status = 'completed' AND COALESCE(ended_at, updated_at) >= $2
          AND energy_kwh IS NOT NULL AND start_soc IS NOT NULL AND end_soc IS NOT NULL`,
      [vehicleIds, sessionsSince],
    );
    for (const r of sessions.rows) out.get(r.vehicle_id)!.sessions.push(r);
    return out;
  }

  /** The reading before this one of the same vehicle (FMS-98's thresholds cross once), or null. */
  /**
   * The EV predictive maintenance model's facts (feature_spec_ev.json, FMS-135) for these vehicles as of t, by internal
   * vehicle id: health in [t - 90 d, t), heat, energy per km and deep discharges in [t - 30 d, t), charging energy by
   * station power in [t - 30 d, t), failed sessions in [t - 90 d, t). Vehicles with nothing are absent.
   */
  async scoringFacts(
    db: Queryable,
    vehicleIds: readonly string[],
    t: Date,
    rules: { hotC: number; hotHoursPerReading: number; deepSoc: number; dcFastKw: number },
  ): Promise<Map<string, EvScoringRow>> {
    const out = new Map<string, EvScoringRow>();
    if (vehicleIds.length === 0) return out;
    const blank = (): EvScoringRow => ({
      newestHealth: null,
      oldestHealth: null,
      healthReadings: 0,
      hotHours: 0,
      energySumWhPerKm: 0,
      energyReadings: 0,
      sessionEnergyKwh: 0,
      dcFastEnergyKwh: 0,
      deepDischarges: 0,
      failedSessions: 0,
    });
    const row = (id: string) => out.get(id) ?? out.set(id, blank()).get(id)!;
    const ids = [vehicleIds];

    const health = await db.query<{ vehicleId: string; newest: number; oldest: number; readings: number }>(
      `SELECT vehicle_id AS "vehicleId",
              (array_agg(battery_health::float8 ORDER BY recorded_at DESC, id DESC))[1] AS newest,
              (array_agg(battery_health::float8 ORDER BY recorded_at, id))[1] AS oldest,
              count(*)::int AS readings
         FROM ev.ev_battery_logs
        WHERE vehicle_id = ANY($1::bigint[]) AND battery_health IS NOT NULL
          AND recorded_at >= $2::timestamptz - interval '90 days' AND recorded_at < $2
        GROUP BY vehicle_id`,
      [...ids, t],
    );
    for (const r of health.rows) Object.assign(row(r.vehicleId), { newestHealth: r.newest, oldestHealth: r.oldest, healthReadings: r.readings });

    // Each reading to the next (or to t), at most the cap, counted when the pack was hot; energy per km; deep discharges
    // (below the line, the reading before not), the reading before taken from the whole history.
    const use = await db.query<{ vehicleId: string; hotHours: number; energySum: number; energyReadings: number; deep: number }>(
      `WITH logs AS (
         SELECT vehicle_id, recorded_at, battery_temperature_c::float8 AS temp, energy_wh_per_km::float8 AS wh, state_of_charge::float8 AS soc,
                LEAD(recorded_at) OVER w AS next_at, LAG(state_of_charge::float8) OVER w AS prev_soc
           FROM ev.ev_battery_logs
          WHERE vehicle_id = ANY($1::bigint[]) AND recorded_at < $2
         WINDOW w AS (PARTITION BY vehicle_id ORDER BY recorded_at, id)
       )
       SELECT vehicle_id AS "vehicleId",
              COALESCE(SUM(LEAST($3::float8, EXTRACT(EPOCH FROM (COALESCE(next_at, $2::timestamptz) - recorded_at)) / 3600.0)) FILTER (WHERE temp >= $4), 0)::float8 AS "hotHours",
              COALESCE(SUM(wh), 0)::float8 AS "energySum",
              count(wh)::int AS "energyReadings",
              count(*) FILTER (WHERE soc < $5 AND (prev_soc IS NULL OR prev_soc >= $5))::int AS deep
         FROM logs
        WHERE recorded_at >= $2::timestamptz - interval '30 days'
        GROUP BY vehicle_id`,
      [...ids, t, rules.hotHoursPerReading, rules.hotC, rules.deepSoc],
    );
    for (const r of use.rows) Object.assign(row(r.vehicleId), { hotHours: r.hotHours, energySumWhPerKm: r.energySum, energyReadings: r.energyReadings, deepDischarges: r.deep });

    const charging = await db.query<{ vehicleId: string; energy: number; fast: number }>(
      `SELECT s.vehicle_id AS "vehicleId", COALESCE(SUM(s.energy_kwh), 0)::float8 AS energy,
              COALESCE(SUM(s.energy_kwh) FILTER (WHERE st.power_kw >= $3), 0)::float8 AS fast
         FROM ev.charging_sessions s
         LEFT JOIN ev.charging_stations st ON st.id = s.station_id
        WHERE s.vehicle_id = ANY($1::bigint[]) AND s.status = 'completed' AND s.energy_kwh IS NOT NULL
          AND s.ended_at >= $2::timestamptz - interval '30 days' AND s.ended_at < $2
        GROUP BY s.vehicle_id`,
      [...ids, t, rules.dcFastKw],
    );
    for (const r of charging.rows) Object.assign(row(r.vehicleId), { sessionEnergyKwh: r.energy, dcFastEnergyKwh: r.fast });

    const failed = await db.query<{ vehicleId: string; failed: number }>(
      `SELECT vehicle_id AS "vehicleId", count(*)::int AS failed
         FROM ev.charging_sessions
        WHERE vehicle_id = ANY($1::bigint[]) AND status = 'failed'
          AND COALESCE(started_at, created_at) >= $2::timestamptz - interval '90 days' AND COALESCE(started_at, created_at) < $2
        GROUP BY vehicle_id`,
      [...ids, t],
    );
    for (const r of failed.rows) row(r.vehicleId).failedSessions = r.failed;
    return out;
  }

  async previousLog(db: Queryable, publicId: string): Promise<{ vehicleId: string; state_of_charge: number; battery_health: number | null } | null> {
    const res = await db.query<{ vehicleId: string; state_of_charge: number; battery_health: number | null }>(
      `SELECT p.vehicle_id AS "vehicleId", p.state_of_charge::float8 AS state_of_charge, p.battery_health::float8 AS battery_health
         FROM ev.ev_battery_logs l
         JOIN ev.ev_battery_logs p ON p.vehicle_id = l.vehicle_id AND (p.recorded_at, p.id) < (l.recorded_at, l.id)
        WHERE l.public_id = $1
        ORDER BY p.recorded_at DESC, p.id DESC LIMIT 1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  /** The summary's figures for one vehicle over [since, now): daily SoC (Addis Ababa days), health, charging. */
  async summary(db: Queryable, vehicleId: string, since: Date) {
    const latest = await db.query<{ state_of_charge: number; battery_health: number | null; estimated_range_km: number | null; recorded_at: Date }>(
      `SELECT state_of_charge::float8 AS state_of_charge, battery_health::float8 AS battery_health, estimated_range_km::float8 AS estimated_range_km, recorded_at
         FROM ev.ev_battery_logs WHERE vehicle_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1`,
      [vehicleId],
    );
    const trend = await db.query<{ day: string; average: number; minimum: number; maximum: number; readings: number }>(
      `SELECT to_char((recorded_at AT TIME ZONE 'Africa/Addis_Ababa')::date, 'YYYY-MM-DD') AS day,
              round(avg(state_of_charge), 1)::float8 AS average, min(state_of_charge)::float8 AS minimum,
              max(state_of_charge)::float8 AS maximum, count(*)::int AS readings
         FROM ev.ev_battery_logs WHERE vehicle_id = $1 AND recorded_at >= $2
        GROUP BY 1 ORDER BY 1`,
      [vehicleId, since],
    );
    const health = await db.query<{ current: number | null; at_start: number | null }>(
      `SELECT (SELECT battery_health::float8 FROM ev.ev_battery_logs WHERE vehicle_id = $1 AND battery_health IS NOT NULL ORDER BY recorded_at DESC, id DESC LIMIT 1) AS current,
              (SELECT battery_health::float8 FROM ev.ev_battery_logs WHERE vehicle_id = $1 AND battery_health IS NOT NULL AND recorded_at >= $2 ORDER BY recorded_at, id LIMIT 1) AS at_start`,
      [vehicleId, since],
    );
    const charging = await db.query<{ sessions_completed: number; energy_kwh: number; cost_cents: number }>(
      `SELECT count(*)::int AS sessions_completed, COALESCE(sum(energy_kwh), 0)::float8 AS energy_kwh, COALESCE(sum(cost_cents), 0)::int AS cost_cents
         FROM ev.charging_sessions WHERE vehicle_id = $1 AND status = 'completed' AND COALESCE(ended_at, updated_at) >= $2`,
      [vehicleId, since],
    );
    return { latest: latest.rows[0] ?? null, trend: trend.rows, health: health.rows[0], charging: charging.rows[0] };
  }
}

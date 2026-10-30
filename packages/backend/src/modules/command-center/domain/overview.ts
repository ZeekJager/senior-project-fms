// The command center's overview (FMS-89, api-contract §11.1): GET /command-center/overview. Everything on the
// live map that needs someone's attention, counted for one depot or every depot in the caller's scope: the
// fleet's state, the drivers, the day's trips, vehicle health, and the active alerts and incidents. Pure, so the
// counting is unit-tested apart from the database.

import { AppError } from '../../../shared/errors/app-error';

/** How long an overview is served from the cache. Alert, incident, trip and vehicle events drop it at once. */
export const OVERVIEW_CACHE_TTL_SECONDS = 5;

/** The most alerts and incidents listed; the counts cover all of them. */
export const OVERVIEW_LIST_LIMIT = 50;

/** Health bands of the fleet's health score snapshot (fleet HEALTH_BANDS, FMS-56). */
export interface HealthBands {
  atRiskBelow: number;
  healthyFrom: number;
  staleAfterHours: number;
}

export type HealthBand = 'at_risk' | 'watch' | 'healthy' | 'stale' | 'unscored';

/** Attendance marks that keep a driver off the road today (FMS-21): the dispatch warning's. */
export const ABSENT_MARKS: readonly string[] = ['absent', 'on_leave', 'sick'];

type Severity = 'critical' | 'high' | 'medium' | 'low';
type BySeverity = Record<Severity, number>;

const TRIP_STATUSES = ['draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled'] as const;

export interface OverviewVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  status: string;
  maintenanceFlag: boolean;
  healthScore: number | null;
  healthScoreUpdatedAt: Date | string | null;
}

export interface OverviewDriver {
  id: string;
  publicId: string;
  fullName: string | null;
  licenceExpired: boolean;
  attendance: string | null;
}

/** An alert as the alert module returns it (AlertView), the fields the overview lists. */
export interface OverviewAlert {
  id: string;
  type: string;
  severity: string;
  priority: number;
  status: string;
  title: string;
  message: string | null;
  vehicle_id: string | null;
  driver_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  occurrence_count: number;
  escalation_level: number;
  created_at: string;
  last_occurred_at: string;
  acknowledged_at: string | null;
}

/** An incident as the alert module returns it (IncidentView), the fields the overview lists. */
export interface OverviewIncident {
  id: string;
  incident_type: string;
  severity: string;
  status: string;
  description: string;
  vehicle_id: string | null;
  driver_id: string | null;
  assigned_to: { id: string; full_name: string } | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  occurred_at: Date | string;
  updated_at: Date | string;
}

export interface OverviewInput {
  /** The depot shown (public id), or null for every depot in scope. */
  depotId: string | null;
  now: Date;
  bands: HealthBands;
  vehicles: readonly OverviewVehicle[];
  drivers: readonly OverviewDriver[];
  trips: { today: readonly { status: string; n: number }[]; underWay: readonly { vehicleId: string | null; driverId: string | null; overdue: boolean }[] };
  alerts: { items: readonly OverviewAlert[]; counts: readonly { status: string; severity: string; n: number }[] };
  incidents: { items: readonly OverviewIncident[]; counts: readonly { status: string; severity: string; n: number }[] };
}

export interface CommandCenterOverview {
  depot_id: string | null;
  generated_at: string;
  vehicles: {
    total: number;
    on_trip: number;
    /** In service, not flagged, not on a trip. */
    available: number;
    in_maintenance: number;
    inactive: number;
    /** Maintenance flag set (a defect, a critical incident): not to be dispatched. */
    flagged: number;
    health: Record<HealthBand, number>;
    /** Vehicles at risk or to watch, lowest score first: the map's health badges. */
    health_watch: { vehicle_id: string; registration_number: string; health_score: number; band: 'at_risk' | 'watch' }[];
  };
  drivers: {
    total: number;
    on_trip: number;
    /** Not on a trip, not marked absent today, licence valid. */
    available: number;
    /** Marked absent, on leave or sick today. */
    absent: number;
    licence_expired: number;
  } | null;
  trips: {
    /** Trips scheduled to start today (Addis Ababa), by status. */
    today: Record<(typeof TRIP_STATUSES)[number], number>;
    under_way: number;
    /** Under way past their scheduled end. */
    overdue: number;
  } | null;
  alerts: {
    active: number;
    /** Open: nobody has acknowledged them. */
    unacknowledged: number;
    by_severity: BySeverity;
    items: (OverviewAlert & { registration_number: string | null })[];
  } | null;
  incidents: {
    active: number;
    by_status: { open: number; investigating: number };
    by_severity: BySeverity;
    items: (Omit<OverviewIncident, 'occurred_at' | 'updated_at'> & {
      occurred_at: string;
      updated_at: string;
      registration_number: string | null;
      driver_name: string | null;
    })[];
  } | null;
}

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());

/** A vehicle's health band as of `now`: a fresh score's band, `stale` when it was not rescored in time, or `unscored`. */
export function healthBand(score: number | null, updatedAt: Date | string | null, now: Date, bands: HealthBands): HealthBand {
  if (score === null) return 'unscored';
  if (!updatedAt || now.getTime() - new Date(updatedAt).getTime() > bands.staleAfterHours * 3_600_000) return 'stale';
  if (score < bands.atRiskBelow) return 'at_risk';
  return score < bands.healthyFrom ? 'watch' : 'healthy';
}

/** The Addis Ababa day (UTC+3 all year) holding `now`, and its bounds as instants. */
export function addisDayOf(now: Date): { day: string; from: Date; to: Date } {
  const day = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00+03:00`);
  return { day, from, to: new Date(from.getTime() + 86_400_000) };
}

function bySeverity(counts: readonly { severity: string; n: number }[]): BySeverity {
  const out: BySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of counts) if (c.severity in out) out[c.severity as Severity] += c.n;
  return out;
}

const sum = (counts: readonly { n: number }[]) => counts.reduce((total, c) => total + c.n, 0);

/** The whole overview, every section filled: what the cache holds. `forCaller` takes out what a caller may not read. */
export function summarise(input: OverviewInput): CommandCenterOverview {
  const { vehicles, drivers, trips, alerts, incidents, now, bands } = input;
  const vehicleOnTrip = new Set(trips.underWay.flatMap((t) => (t.vehicleId ? [t.vehicleId] : [])));
  const driverOnTrip = new Set(trips.underWay.flatMap((t) => (t.driverId ? [t.driverId] : [])));
  const plates = new Map(vehicles.map((v) => [v.publicId, v.registrationNumber]));
  const driverNames = new Map(drivers.map((d) => [d.publicId, d.fullName]));

  const health: Record<HealthBand, number> = { at_risk: 0, watch: 0, healthy: 0, stale: 0, unscored: 0 };
  const watch: CommandCenterOverview['vehicles']['health_watch'] = [];
  for (const v of vehicles) {
    const band = healthBand(v.healthScore, v.healthScoreUpdatedAt, now, bands);
    health[band] += 1;
    if ((band === 'at_risk' || band === 'watch') && v.healthScore !== null) {
      watch.push({ vehicle_id: v.publicId, registration_number: v.registrationNumber, health_score: v.healthScore, band });
    }
  }
  watch.sort((a, b) => a.health_score - b.health_score || a.registration_number.localeCompare(b.registration_number));

  const today = Object.fromEntries(TRIP_STATUSES.map((s) => [s, 0])) as Record<(typeof TRIP_STATUSES)[number], number>;
  for (const t of trips.today) if (t.status in today) today[t.status as keyof typeof today] += t.n;

  return {
    depot_id: input.depotId,
    generated_at: now.toISOString(),
    vehicles: {
      total: vehicles.length,
      on_trip: vehicles.filter((v) => vehicleOnTrip.has(v.id)).length,
      available: vehicles.filter((v) => v.status === 'active' && !v.maintenanceFlag && !vehicleOnTrip.has(v.id)).length,
      in_maintenance: vehicles.filter((v) => v.status === 'maintenance').length,
      inactive: vehicles.filter((v) => v.status === 'inactive').length,
      flagged: vehicles.filter((v) => v.maintenanceFlag).length,
      health,
      health_watch: watch,
    },
    drivers: {
      total: drivers.length,
      on_trip: drivers.filter((d) => driverOnTrip.has(d.id)).length,
      available: drivers.filter((d) => !driverOnTrip.has(d.id) && !d.licenceExpired && !ABSENT_MARKS.includes(d.attendance ?? '')).length,
      absent: drivers.filter((d) => ABSENT_MARKS.includes(d.attendance ?? '')).length,
      licence_expired: drivers.filter((d) => d.licenceExpired).length,
    },
    trips: { today, under_way: trips.underWay.length, overdue: trips.underWay.filter((t) => t.overdue).length },
    alerts: {
      active: sum(alerts.counts),
      unacknowledged: sum(alerts.counts.filter((c) => c.status === 'open')),
      by_severity: bySeverity(alerts.counts),
      items: alerts.items.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        priority: a.priority,
        status: a.status,
        title: a.title,
        message: a.message,
        vehicle_id: a.vehicle_id,
        registration_number: a.vehicle_id ? (plates.get(a.vehicle_id) ?? null) : null,
        driver_id: a.driver_id,
        entity_type: a.entity_type,
        entity_id: a.entity_id,
        occurrence_count: a.occurrence_count,
        escalation_level: a.escalation_level,
        created_at: a.created_at,
        last_occurred_at: a.last_occurred_at,
        acknowledged_at: a.acknowledged_at,
      })),
    },
    incidents: {
      active: sum(incidents.counts),
      by_status: { open: sum(incidents.counts.filter((c) => c.status === 'open')), investigating: sum(incidents.counts.filter((c) => c.status === 'investigating')) },
      by_severity: bySeverity(incidents.counts),
      items: incidents.items.map((i) => ({
        id: i.id,
        incident_type: i.incident_type,
        severity: i.severity,
        status: i.status,
        description: i.description,
        vehicle_id: i.vehicle_id,
        registration_number: i.vehicle_id ? (plates.get(i.vehicle_id) ?? null) : null,
        driver_id: i.driver_id,
        driver_name: i.driver_id ? (driverNames.get(i.driver_id) ?? null) : null,
        assigned_to: i.assigned_to,
        notes: i.notes,
        latitude: i.latitude,
        longitude: i.longitude,
        occurred_at: iso(i.occurred_at),
        updated_at: iso(i.updated_at),
      })),
    },
  };
}

/** Which permission each section needs beyond command:read. The vehicles are the command center's own. */
export const SECTION_PERMISSIONS = {
  drivers: 'driver:read',
  trips: 'trip:read',
  alerts: 'alert:read',
  incidents: 'incident:read',
} as const;

/** The overview a caller may see: a section they lack the read permission for is null, not empty. */
export function forCaller(overview: CommandCenterOverview, permissions: readonly string[]): CommandCenterOverview {
  const out = { ...overview };
  for (const [section, permission] of Object.entries(SECTION_PERMISSIONS) as [keyof typeof SECTION_PERMISSIONS, string][]) {
    if (!permissions.includes(permission)) out[section] = null;
  }
  return out;
}

/** A depot filter outside the caller's scope, or no such depot. */
export const depotNotFound = () => new AppError(404, 'NOT_FOUND', 'Depot not found.');

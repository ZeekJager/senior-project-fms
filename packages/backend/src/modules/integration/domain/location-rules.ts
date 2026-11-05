import { inside, metresToLine, type BoundingBox, type LineString, type Polygon } from './geometry';
import { MAX_PING_GAP_MS, type RulePing } from './telemetry-rules';

// Geofences and route deviation (FMS-90, docs/geofences.md): where a vehicle's GPS pings put it against its
// depot's geofences and its trip's road, in the order they were recorded. Pure, like the speeding and idling
// rules (telemetry-rules.ts): the service feeds it the new pings with the counters left by the last ones (kept
// in Redis) and the flags open in the database.

export const GEOFENCE_KINDS = ['keep_in', 'keep_out'] as const;
/** keep_in: the vehicle must stay inside (a yard, an operating area). keep_out: it must not enter (a no-go zone). */
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];

export const GEOFENCE_APPLIES = ['always', 'off_trip'] as const;
/** always: on and off trips. off_trip: only while the vehicle is on no trip (leaving the yard after hours). */
export type GeofenceApplies = (typeof GEOFENCE_APPLIES)[number];

/** A geofence as the rules check it. */
export interface FenceRule {
  /** Internal id. */
  id: string;
  version: number;
  kind: GeofenceKind;
  applies: GeofenceApplies;
  polygon: Polygon;
  box: BoundingBox;
}

/** The thresholds (tracking.rule_thresholds, CFG-3), the fleet's or a depot's. */
export interface LocationThresholds {
  /** Further than this from the road is off route. */
  routeDeviationM: number;
  /** Consecutive pings off route that raise a route deviation flag. */
  routeDeviationPings: number;
  /** Consecutive pings back on the right side (inside a keep-in fence, out of a keep-out one, on the road) that resolve a flag. */
  clearPings: number;
}

export const DEFAULT_LOCATION_THRESHOLDS: LocationThresholds = { routeDeviationM: 500, routeDeviationPings: 3, clearPings: 3 };

export const LOCATION_THRESHOLD_LIMITS = {
  routeDeviationM: { min: 100, max: 5000 },
  routeDeviationPings: { min: 1, max: 20 },
} as const;

/** Where a vehicle stood against one fence. */
export interface FenceState {
  /** The fence's version this was counted against: an edited fence starts again. */
  v: number;
  /** On the wrong side at the last ping (outside a keep-in fence, inside a keep-out one); null before the first. */
  wrong: boolean | null;
  /** Consecutive pings on the right side while its flag is open, and when that began. */
  clearCount: number;
  clearSince: number | null;
}

/** Where a vehicle stood against its trip's road. */
export interface RoadState {
  tripId: string;
  offCount: number;
  offSince: number | null;
  onCount: number;
  onSince: number | null;
  /** The furthest from the road since the flag opened, in metres. */
  maxM: number;
}

/** One vehicle's counters. Small and JSON-safe: it lives in Redis. */
export interface LocationState {
  lastAt: number | null;
  /** By fence id. */
  fences: Record<string, FenceState>;
  road: RoadState | null;
}

export const INITIAL_LOCATION_STATE: LocationState = { lastAt: null, fences: {}, road: null };

/** What is open now: `route_deviation`, and `geofence:<id>` for each fence the vehicle is in violation of. */
export type OpenLocationFlags = Set<string>;

export const fenceKey = (fenceId: string) => `geofence:${fenceId}`;
export const ROAD_KEY = 'route_deviation';

export type LocationAction =
  | {
      kind: 'raise';
      flagType: 'geofence_violation' | 'route_deviation';
      geofenceId: string | null;
      observedAt: number;
      ping: RulePing;
      details: Record<string, number | string>;
    }
  | {
      kind: 'resolve';
      flagType: 'geofence_violation' | 'route_deviation';
      geofenceId: string | null;
      resolvedAt: number;
      reason: 'cleared' | 'trip_started' | 'trip_ended';
      details: Record<string, number>;
    };

/**
 * Runs a vehicle's new pings (oldest first, newer than `state.lastAt`) past its depot's active fences and its
 * trips' roads. `roads` gives the road of each trip a ping carries (missing: the trip's route has none). `open`
 * says which flags are open; it is updated as they open and close. Returns the state after the last ping and the
 * flags to open and close, in order.
 *
 * - A fence is broken when a ping crosses to its wrong side while it applies, so a vehicle already on the wrong
 *   side when first seen, or when the fence was drawn or changed, is not flagged until it crosses again. The side
 *   is kept across a gap in the signal: a vehicle that goes dark in the yard and reappears outside has left it.
 * - Off route counts consecutive pings (at most 2 minutes apart) further from the road than the threshold.
 */
export function evaluateLocation(
  state: LocationState,
  open: OpenLocationFlags,
  pings: readonly RulePing[],
  fences: readonly FenceRule[],
  roads: ReadonlyMap<string, LineString>,
  t: LocationThresholds,
): { state: LocationState; actions: LocationAction[] } {
  const s: LocationState = { lastAt: state.lastAt, fences: {}, road: state.road ? { ...state.road } : null };
  const actions: LocationAction[] = [];
  // Fences no longer active are forgotten; an edited fence (another version) starts again.
  for (const f of fences) {
    const kept = state.fences[f.id];
    s.fences[f.id] = kept && kept.v === f.version ? { ...kept } : { v: f.version, wrong: null, clearCount: 0, clearSince: null };
  }

  for (const p of pings) {
    const gap = s.lastAt !== null && p.at - s.lastAt > MAX_PING_GAP_MS;
    s.lastAt = p.at;

    for (const f of fences) {
      const fs = s.fences[f.id];
      const key = fenceKey(f.id);
      if (gap) {
        fs.clearCount = 0;
        fs.clearSince = null;
      }
      const wrong = f.kind === 'keep_in' ? !inside(p, f.polygon, f.box) : inside(p, f.polygon, f.box);
      const applies = f.applies === 'always' || p.tripId === null;
      if (!applies) {
        if (open.has(key)) {
          open.delete(key);
          actions.push({ kind: 'resolve', flagType: 'geofence_violation', geofenceId: f.id, resolvedAt: p.at, reason: 'trip_started', details: {} });
        }
        fs.clearCount = 0;
        fs.clearSince = null;
      } else if (wrong) {
        fs.clearCount = 0;
        fs.clearSince = null;
        if (fs.wrong === false && !open.has(key)) {
          open.add(key);
          actions.push({ kind: 'raise', flagType: 'geofence_violation', geofenceId: f.id, observedAt: p.at, ping: p, details: { kind: f.kind } });
        }
      } else if (open.has(key)) {
        fs.clearCount += 1;
        fs.clearSince ??= p.at;
        if (fs.clearCount >= t.clearPings) {
          open.delete(key);
          actions.push({ kind: 'resolve', flagType: 'geofence_violation', geofenceId: f.id, resolvedAt: fs.clearSince, reason: 'cleared', details: {} });
          fs.clearCount = 0;
          fs.clearSince = null;
        }
      }
      fs.wrong = wrong;
    }

    roadRule(s, open, p, roads, t, gap, actions);
  }
  return { state: s, actions };
}

/** Off route: the ping's distance from its trip's road, counted over consecutive pings. */
function roadRule(s: LocationState, open: OpenLocationFlags, p: RulePing, roads: ReadonlyMap<string, LineString>, t: LocationThresholds, gap: boolean, actions: LocationAction[]): void {
  const line = p.tripId !== null ? roads.get(p.tripId) : undefined;
  // Another trip, no trip, or a trip without a road: the last trip's deviation is over.
  if (s.road && (!line || s.road.tripId !== p.tripId)) {
    if (open.has(ROAD_KEY)) {
      open.delete(ROAD_KEY);
      actions.push({ kind: 'resolve', flagType: 'route_deviation', geofenceId: null, resolvedAt: p.at, reason: 'trip_ended', details: { max_distance_m: Math.round(s.road.maxM) } });
    }
    s.road = null;
  }
  if (!line || p.tripId === null) return;
  const r = (s.road ??= { tripId: p.tripId, offCount: 0, offSince: null, onCount: 0, onSince: null, maxM: 0 });
  if (gap) {
    r.offCount = 0;
    r.offSince = null;
    r.onCount = 0;
    r.onSince = null;
  }
  const distance = metresToLine(p, line);
  if (distance > t.routeDeviationM) {
    r.offCount += 1;
    r.offSince ??= p.at;
    r.onCount = 0;
    r.onSince = null;
    // The furthest of the run off the road, and of the flag's whole time once open.
    r.maxM = open.has(ROAD_KEY) || r.offCount > 1 ? Math.max(r.maxM, distance) : distance;
    if (!open.has(ROAD_KEY) && r.offCount >= t.routeDeviationPings) {
      open.add(ROAD_KEY);
      actions.push({
        kind: 'raise',
        flagType: 'route_deviation',
        geofenceId: null,
        observedAt: r.offSince,
        ping: p,
        details: { distance_m: Math.round(distance), route_deviation_m: t.routeDeviationM, consecutive_pings: r.offCount },
      });
    }
  } else {
    r.offCount = 0;
    r.offSince = null;
    if (open.has(ROAD_KEY)) {
      r.onCount += 1;
      r.onSince ??= p.at;
      if (r.onCount >= t.clearPings) {
        open.delete(ROAD_KEY);
        actions.push({ kind: 'resolve', flagType: 'route_deviation', geofenceId: null, resolvedAt: r.onSince, reason: 'cleared', details: { max_distance_m: Math.round(r.maxM) } });
        r.onCount = 0;
        r.onSince = null;
        r.maxM = 0;
      }
    }
  }
}

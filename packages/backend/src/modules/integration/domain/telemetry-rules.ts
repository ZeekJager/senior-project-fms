// The telemetry rules (FMS-46, §34): speeding and idling found in a vehicle's GPS pings, in the order they
// were recorded. Pure: the service feeds it each vehicle's new pings, with the counters left by the last
// ones (kept in Redis, so a restart does not reset them) and the flags open in the database.

/** The rules' thresholds (tracking.rule_thresholds, CFG-3): the fleet's, or a depot's that differ. */
export interface RuleThresholds {
  speedLimitKmh: number;
  /** Consecutive pings over the limit that raise a speeding flag. */
  speedingPings: number;
  /** Consecutive pings at or under the limit that resolve it. */
  clearPings: number;
  /** Minutes at 0 km/h, engine not reported off, that raise an idling flag. */
  idleMinutes: number;
}

/** The fleet row's starting values (migration 035), used if it is missing. */
export const DEFAULT_THRESHOLDS: RuleThresholds = { speedLimitKmh: 80, speedingPings: 3, clearPings: 3, idleMinutes: 5 };

/**
 * Pings further apart than this are not consecutive: counting restarts after the gap (a device that was
 * off, a tunnel), and an idling flag ends at the last ping before it, since the stop cannot be vouched for.
 * The live map's "no ping" limit (FMS-45).
 */
export const MAX_PING_GAP_MS = 2 * 60_000;

export const FLAG_TYPES = ['speeding', 'idling'] as const;
export type RuleFlagType = (typeof FLAG_TYPES)[number];

/** How serious each flag is: speeding endangers, idling wastes (the alert engine follows it). */
export const FLAG_SEVERITY: Record<RuleFlagType, 'high' | 'medium'> = { speeding: 'high', idling: 'medium' };

/** One stored ping, as the rules read it. */
export interface RulePing {
  /** recorded_at, epoch ms. */
  at: number;
  speedKmh: number;
  ignitionOn: boolean | null;
  lat: number;
  lng: number;
  /** Internal id of the trip the ping was stored with. */
  tripId: string | null;
}

/** Where one vehicle's rules stand after the pings seen so far. Small and JSON-safe: it lives in Redis. */
export interface RuleState {
  /** recorded_at (epoch ms) of the last ping evaluated; newer pings are the next to read. */
  lastAt: number | null;
  /** Consecutive pings over the limit, and when the run began. */
  overCount: number;
  overSince: number | null;
  /** Consecutive pings at or under the limit while a speeding flag is open, and when that began. */
  clearCount: number;
  clearSince: number | null;
  /** The first ping of the current stop (0 km/h, engine not reported off). */
  idleSince: number | null;
}

export const INITIAL_STATE: RuleState = { lastAt: null, overCount: 0, overSince: null, clearCount: 0, clearSince: null, idleSince: null };

/** A flag to open or to close, decided by one ping. */
export type RuleAction =
  | {
      kind: 'raise';
      flagType: RuleFlagType;
      /** When the condition began: the run's first ping over the limit, or the stop's first ping. */
      observedAt: number;
      /** The ping that crossed the threshold. */
      ping: RulePing;
      details: Record<string, number | string>;
    }
  | {
      kind: 'resolve';
      flagType: RuleFlagType;
      /** When the condition ended: the first ping under the limit or moving, or the last before a gap. */
      resolvedAt: number;
      reason: 'cleared' | 'moving' | 'engine_off' | 'signal_lost';
    };

/**
 * Runs the rules over a vehicle's new pings (oldest first, all newer than `state.lastAt`). `open` says which
 * flags the vehicle has open now; it is updated as flags are raised and resolved. Returns the state after the
 * last ping and the flags to open and close, in order.
 */
export function evaluatePings(
  state: RuleState,
  open: Set<RuleFlagType>,
  pings: readonly RulePing[],
  t: RuleThresholds,
): { state: RuleState; actions: RuleAction[] } {
  const s = { ...state };
  const actions: RuleAction[] = [];
  const resolve = (flagType: RuleFlagType, resolvedAt: number, reason: Extract<RuleAction, { kind: 'resolve' }>['reason']) => {
    open.delete(flagType);
    actions.push({ kind: 'resolve', flagType, resolvedAt, reason });
  };

  for (const p of pings) {
    if (s.lastAt !== null && p.at - s.lastAt > MAX_PING_GAP_MS) {
      s.overCount = 0;
      s.overSince = null;
      s.clearCount = 0;
      s.clearSince = null;
      s.idleSince = null;
      if (open.has('idling')) resolve('idling', s.lastAt, 'signal_lost');
    }
    s.lastAt = p.at;

    // Speeding: over the limit for `speedingPings` in a row; cleared by `clearPings` in a row at or under it.
    if (p.speedKmh > t.speedLimitKmh) {
      s.overCount += 1;
      s.overSince ??= p.at;
      s.clearCount = 0;
      s.clearSince = null;
      if (!open.has('speeding') && s.overCount >= t.speedingPings) {
        open.add('speeding');
        actions.push({
          kind: 'raise',
          flagType: 'speeding',
          observedAt: s.overSince,
          ping: p,
          details: { speed_limit_kmh: t.speedLimitKmh, speed_kmh: p.speedKmh, consecutive_pings: s.overCount },
        });
      }
    } else {
      s.overCount = 0;
      s.overSince = null;
      if (open.has('speeding')) {
        s.clearCount += 1;
        s.clearSince ??= p.at;
        if (s.clearCount >= t.clearPings) {
          resolve('speeding', s.clearSince, 'cleared');
          s.clearCount = 0;
          s.clearSince = null;
        }
      }
    }

    // Idling: at 0 km/h with the engine running (or not reported) for `idleMinutes`; ends on moving or engine off.
    if (p.speedKmh === 0 && p.ignitionOn !== false) {
      s.idleSince ??= p.at;
      if (!open.has('idling') && p.at - s.idleSince >= t.idleMinutes * 60_000) {
        open.add('idling');
        actions.push({
          kind: 'raise',
          flagType: 'idling',
          observedAt: s.idleSince,
          ping: p,
          details: { idle_minutes: t.idleMinutes },
        });
      }
    } else {
      s.idleSince = null;
      if (open.has('idling')) resolve('idling', p.at, p.speedKmh > 0 ? 'moving' : 'engine_off');
    }
  }
  return { state: s, actions };
}

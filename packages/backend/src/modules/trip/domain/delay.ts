// The trip delay alert (FMS-147, docs/eta.md): a trip under way whose live arrival estimate (FMS-86) is past its
// scheduled end by more than a margin. Pure: the ETA service feeds it each new estimate with where the trip stood.

/** Published when a trip falls late, and again when it becomes urgent. The alert engine's `trip_delayed`. */
export const TRIP_DELAYED = 'TripDelayed';

/** The margins, in minutes past the scheduled end: a depot's, or the fleet's (tracking.rule_thresholds, migration 068). */
export interface DelayMargins {
  /** Expected later than this: the trip is late, and the dispatchers are told. */
  lateMinutes: number;
  /** Later than this: urgent, told on the urgent channels (email, SMS, push). Above lateMinutes. */
  urgentMinutes: number;
}

/** The fleet row's starting values (migration 068), used if it is missing. */
export const DEFAULT_DELAY_MARGINS: DelayMargins = { lateMinutes: 15, urgentMinutes: 60 };

/** Each margin's range, as the table's checks have it (migration 068). */
export const DELAY_MARGIN_LIMITS: Record<keyof DelayMargins, { min: number; max: number }> = {
  lateMinutes: { min: 5, max: 240 },
  urgentMinutes: { min: 10, max: 720 },
};

export type DelayLevel = 'late' | 'urgent';

/** Where a trip stands: how late it was last alerted as (null: within the margin), and how many times it fell late. */
export interface DelayState {
  level: DelayLevel | null;
  episode: number;
}

/** What one estimate changes: the new state, and the alert to raise (null: nobody is told). */
export interface DelayStep {
  state: DelayState;
  /** `late` when the trip falls late, `urgent` when it passes the second margin (at once, or after being late). */
  raise: DelayLevel | null;
  /** Whole minutes the trip is expected after its scheduled end; negative when early. */
  lateByMinutes: number;
}

/**
 * The next state from one estimate. Past the margin, a trip within it falls late (a new episode, alerted); past
 * the second margin, a trip not yet urgent becomes urgent (the same episode's alert, raised). Back within the
 * margin, it recovers and is alerted again only once it falls late again. Between the margins an urgent trip
 * stays urgent: its alert never comes down.
 */
export function stepDelay(current: DelayState, arrivalAt: Date, scheduledEnd: Date, margins: DelayMargins): DelayStep {
  const lateMs = arrivalAt.getTime() - scheduledEnd.getTime();
  const lateByMinutes = Math.floor(lateMs / 60_000);
  const past = (minutes: number) => lateMs > minutes * 60_000;

  if (!past(margins.lateMinutes)) {
    return { state: { level: null, episode: current.episode }, raise: null, lateByMinutes };
  }
  const urgent = past(margins.urgentMinutes);
  if (current.level === null) {
    const level: DelayLevel = urgent ? 'urgent' : 'late';
    return { state: { level, episode: current.episode + 1 }, raise: level, lateByMinutes };
  }
  if (urgent && current.level === 'late') return { state: { level: 'urgent', episode: current.episode }, raise: 'urgent', lateByMinutes };
  return { state: current, raise: null, lateByMinutes };
}

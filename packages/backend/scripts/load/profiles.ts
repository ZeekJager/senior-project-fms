/**
 * The load suite's workloads (FMS-61, docs/load-testing.md). `full` is the card's: 200 vehicles every 10 s for 5 minutes,
 * 50 users for 2 minutes, 20 dashboard users. `smoke` runs the same code briefly, on every pull request, so the suite
 * itself never rots; its numbers are not the ones to quote.
 */
export interface GpsWorkload {
  /** Vehicles reporting, each through its own device token (POST /tracking/gps-pings). */
  vehicles: number;
  /** Seconds between one vehicle's pings. */
  intervalS: number;
  durationS: number;
  /** Signed-in dashboards (fleet managers: every depot) holding a socket, each of which must receive every position. */
  observers: number;
}

export interface UserWorkload {
  users: number;
  durationS: number;
  /** Pause between one user's actions, uniform in [min, max] milliseconds. */
  thinkMs: readonly [number, number];
}

export interface Profile {
  name: 'full' | 'smoke';
  gps: GpsWorkload;
  api: UserWorkload;
  dashboard: UserWorkload;
}

export const PROFILES: Record<Profile['name'], Profile> = {
  full: {
    name: 'full',
    gps: { vehicles: 200, intervalS: 10, durationS: 300, observers: 25 },
    api: { users: 50, durationS: 120, thinkMs: [500, 1500] },
    dashboard: { users: 20, durationS: 60, thinkMs: [1000, 3000] },
  },
  smoke: {
    name: 'smoke',
    gps: { vehicles: 50, intervalS: 10, durationS: 30, observers: 5 },
    api: { users: 10, durationS: 20, thinkMs: [500, 1500] },
    dashboard: { users: 5, durationS: 15, thinkMs: [1000, 3000] },
  },
};

/**
 * The budgets every run is held to, whatever the profile. Sources: the card's "done when" (FMS-61), the engineering
 * spec's performance budgets (§4) and the SRS (NFR-2). A run fails if any is missed.
 */
export const BUDGETS = {
  gps: {
    /** Positions announced but not received by a dashboard socket. */
    droppedEvents: 0,
    /** From the device sending a ping to a dashboard receiving it, p95 (engineering spec: under 500 ms). */
    deliveryP95Ms: 500,
    /** The API process's CPU, p95 of its 5-second samples, as a share of one core (the card: under 80%). */
    cpuP95Pct: 80,
  },
  api: {
    /** p95 per request, under 50 users (the card). */
    p95Ms: { 'GET /trips': 200, 'GET /vehicles': 500, 'POST /fuel-logs': 400 } as Record<string, number>,
  },
  dashboard: {
    /** Every request a page makes on opening, answered: p95 (the card: first meaningful data under 2 s). */
    pageP95Ms: 2000,
    /** The analytics cache's reports, p95 per request (the card: under 200 ms). */
    analyticsP95Ms: 200,
  },
  /** Every scenario: any answer other than 2xx, or a request that never answers, fails the run. */
  errors: 0,
} as const;

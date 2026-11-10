/**
 * Scenario 3 (FMS-61): people opening the dashboards at once. Each signed-in user, in a loop until the time is up,
 * opens the Fleet Command Center (S-16) or the analytics dashboard (S-18), alternately, making the requests the page
 * makes on opening, together as the browser does. A page counts as loaded when its last request answers: the moment
 * its first meaningful data can be drawn. The analytics reports come from the KPI cache (docs/analytics.md).
 */
import type { UserWorkload } from '../profiles';
import { think, type Session } from '../session';
import { Recorder } from '../stats';

export interface DashboardResult {
  workload: UserWorkload;
  seconds: number;
  pages: ReturnType<Recorder['table']>;
  requests: ReturnType<Recorder['table']>;
  /** Each user's first opening of each page, after the server started: reported, not held to the budgets. */
  warmup: { pages: ReturnType<Recorder['table']>; requests: ReturnType<Recorder['table']> };
  errors: Record<string, Record<string, number>>;
  warmupErrors: Record<string, Record<string, number>>;
  /** Failed requests, warm-up included. */
  errorCount: number;
}

/** YYYY-MM-DD in Addis Ababa, `days` from today: the dashboard's default range is the 30 days to today. */
function addisDay(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date(Date.now() + days * 86_400_000));
}

/** The requests each page makes on opening, by the label they are recorded under. */
export function pageRequests(): Record<string, Record<string, string>> {
  const range = `from=${addisDay(-29)}&to=${addisDay(0)}`;
  return {
    'Fleet Command Center': {
      'GET /command-center/overview': '/command-center/overview',
      'GET /tracking/vehicles/current': '/tracking/vehicles/current',
    },
    'Analytics dashboard': {
      'GET /analytics/fleet-summary': `/analytics/fleet-summary?${range}`,
      'GET /analytics/utilisation': `/analytics/utilisation?${range}`,
      'GET /analytics/maintenance-risk': `/analytics/maintenance-risk?${range}`,
    },
  };
}

export async function runDashboard(sessions: Session[], w: UserWorkload): Promise<DashboardResult> {
  const pages = new Recorder();
  const requests = new Recorder();
  const warmPages = new Recorder();
  const warmRequests = new Recorder();
  const plan = pageRequests();
  const names = Object.keys(plan);

  /** Opens `page` as the browser does: its requests together; loaded when the last answers. */
  const open = async (session: Session, page: string, into: { pages: Recorder; requests: Recorder }) => {
    const t0 = performance.now();
    const answers = await Promise.all(
      Object.entries(plan[page]).map(async ([label, path]) => {
        const r = await session.request('GET', path);
        into.requests.record(label, r.ms, r.ok, r.outcome);
        return r.ok;
      }),
    );
    const ok = answers.every(Boolean);
    into.pages.record(page, performance.now() - t0, ok, ok ? 'loaded' : 'failed');
  };

  // Warm-up, as in the API scenario: every user opens each page once, all at once, and the numbers are kept apart.
  await Promise.all(sessions.map(async (s) => {
    for (const page of names) await open(s, page, { pages: warmPages, requests: warmRequests });
  }));

  const started = performance.now();
  const deadline = started + w.durationS * 1000;
  const user = async (session: Session, first: number) => {
    let turn = first;
    while (performance.now() < deadline) {
      await open(session, names[turn++ % names.length], { pages, requests });
      await think(w.thinkMs);
    }
  };
  await Promise.all(sessions.map((s, i) => user(s, i)));
  const seconds = (performance.now() - started) / 1000;
  return {
    workload: w,
    seconds: Math.round(seconds),
    pages: pages.table(seconds),
    requests: requests.table(seconds),
    warmup: { pages: warmPages.table(seconds), requests: warmRequests.table(seconds) },
    errors: requests.errors(),
    warmupErrors: warmRequests.errors(),
    errorCount: warmRequests.errorCount() + requests.errorCount(),
  };
}

/** The load suite's verdict (FMS-61): each scenario's numbers held to the budgets. Pure, so it is unit-tested. */
import type { ServerLoad } from './metrics';
import { BUDGETS } from './profiles';
import type { ApiResult } from './scenarios/api';
import type { DashboardResult } from './scenarios/dashboard';
import type { GpsResult } from './scenarios/gps';
import { check, type Check } from './stats';

export interface Results {
  gps?: GpsResult & { server: ServerLoad };
  api?: ApiResult & { server: ServerLoad };
  dashboard?: DashboardResult & { server: ServerLoad };
}

/** p95 of a label, or Infinity when it was never measured: a budget nothing was measured against is not met. */
const p95 = (table: Record<string, { p95: number; count: number }>, label: string) => (table[label]?.count ? table[label].p95 : Number.POSITIVE_INFINITY);

export function checksFor(r: Results): Check[] {
  const checks: Check[] = [];
  if (r.gps) {
    checks.push(
      check('GPS: socket events dropped', r.gps.events.dropped, '<=', BUDGETS.gps.droppedEvents, 'events'),
      check('GPS: position delivered to dashboards, p95', r.gps.events.received ? r.gps.deliveryMs.p95 : Number.POSITIVE_INFINITY, '<', BUDGETS.gps.deliveryP95Ms, 'ms'),
      check('GPS: API CPU, p95 of 5 s samples', r.gps.server.samples ? r.gps.server.cpuPct.p95 : Number.POSITIVE_INFINITY, '<', BUDGETS.gps.cpuP95Pct, '% of a core'),
      check('GPS: failed requests and dashboard disconnects', r.gps.errorCount + r.gps.events.observerDisconnects, '<=', BUDGETS.errors, 'requests'),
    );
  }
  if (r.api) {
    for (const [label, limit] of Object.entries(BUDGETS.api.p95Ms)) checks.push(check(`API: ${label}, p95`, p95(r.api.requests, label), '<', limit, 'ms'));
    checks.push(check('API: failed requests', r.api.errorCount, '<=', BUDGETS.errors, 'requests'));
  }
  if (r.dashboard) {
    for (const page of Object.keys(r.dashboard.pages).length ? Object.keys(r.dashboard.pages) : ['Fleet Command Center', 'Analytics dashboard']) {
      checks.push(check(`Dashboard: ${page} loaded, p95`, p95(r.dashboard.pages, page), '<', BUDGETS.dashboard.pageP95Ms, 'ms'));
    }
    for (const label of Object.keys(r.dashboard.requests).filter((l) => l.startsWith('GET /analytics/'))) {
      checks.push(check(`Dashboard: ${label}, p95`, p95(r.dashboard.requests, label), '<', BUDGETS.dashboard.analyticsP95Ms, 'ms'));
    }
    checks.push(check('Dashboard: failed requests', r.dashboard.errorCount, '<=', BUDGETS.errors, 'requests'));
  }
  return checks;
}

/** The checks as lines for the console. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => {
      const actual = Number.isFinite(c.actual) ? String(c.actual) : 'not measured';
      return `${c.passed ? '✔' : '✖'} ${c.name.padEnd(width)}  ${actual} ${c.unit} (budget ${c.op} ${c.limit})`;
    })
    .join('\n');
}

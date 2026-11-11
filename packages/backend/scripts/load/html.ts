/**
 * The load report as a page (FMS-61): `load-report/<profile>.html`, beside the JSON, for an administrator to read without
 * tools. One file, no scripts, no network: it opens from a CI artifact or a laptop as it is. The colours are the web app's
 * tokens (packages/frontend/src/index.css), light and dark. Pure, so it is unit-tested.
 */
import type { ServerLoad } from './metrics';
import type { Results } from './report';
import type { Check, Summary } from './stats';

export interface LoadReport {
  card: string;
  profile: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  commit: string | null;
  machine: { node: string; platform: string; cpu: string; cores: number; memoryGb: number };
  server: { nodeEnv: string; raisedLimits: Record<string, string> };
  dataset: object;
  checks: Check[];
  results: Results;
}

type Table = Record<string, Summary & { perSecond?: number }>;

/** A met budget whose actual uses this share of the limit or more is shown as close. */
export const CLOSE_SHARE = 0.8;

export type Standing = 'met' | 'close' | 'missed';

export function standing(c: Check): Standing {
  if (!c.passed) return 'missed';
  return c.limit > 0 && c.actual / c.limit >= CLOSE_SHARE ? 'close' : 'met';
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const num = (n: number, digits = 0) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : '—';

function ms(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${num(n / 1000, 2)} s` : `${num(n, n < 10 ? 1 : 0)} ms`;
}

function value(c: Check): string {
  if (!Number.isFinite(c.actual)) return 'not measured';
  if (c.unit === 'ms') return ms(c.actual);
  if (c.unit.startsWith('%')) return `${num(c.actual, 1)}%`;
  return `${num(c.actual)} ${c.unit}`;
}

function limit(c: Check): string {
  const op = c.op === '<' ? 'under' : 'at most';
  if (c.unit === 'ms') return `${op} ${ms(c.limit)}`;
  if (c.unit.startsWith('%')) return `${op} ${num(c.limit)}% of a core`;
  return `${op} ${num(c.limit)} ${c.unit}`;
}

const LABELS: Record<Standing, string> = { met: 'Met', close: 'Close', missed: 'Missed' };
const ICONS: Record<Standing, string> = {
  met: '<path d="M3.5 8.5l3 3 6-7" />',
  close: '<path d="M8 4v5" /><path d="M8 11.5v.5" />',
  missed: '<path d="M4.5 4.5l7 7" /><path d="M11.5 4.5l-7 7" />',
};

function badge(s: Standing): string {
  return `<span class="badge ${s}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[s]}</svg>${LABELS[s]}</span>`;
}

/** How much of the budget the actual used, as a bar with the limit at its right edge. A zero budget has no bar. */
function meter(c: Check, s: Standing): string {
  if (c.limit <= 0 || !Number.isFinite(c.actual)) return '<span class="meter-none" aria-hidden="true"></span>';
  const share = Math.min(c.actual / c.limit, 1);
  return `<span class="meter" role="img" aria-label="${num(share * 100)}% of the budget"><span class="fill ${s}" style="width:${(share * 100).toFixed(1)}%"></span></span>`;
}

function scenarioOf(c: Check): string {
  return c.name.split(':')[0];
}

function budgetRows(checks: Check[]): string {
  return checks
    .map((c) => {
      const s = standing(c);
      const rest = c.name.slice(c.name.indexOf(':') + 1).trim();
      const name = rest.charAt(0).toUpperCase() + rest.slice(1);
      return `<tr class="${s}">
  <th scope="row" class="c-name">${esc(name)}</th>
  <td class="meter-cell c-meter">${meter(c, s)}</td>
  <td class="num strong c-val">${esc(value(c))}</td>
  <td class="num muted c-lim">${esc(limit(c))}</td>
  <td class="c-status">${badge(s)}</td>
</tr>`;
    })
    .join('\n');
}

function latencyTable(table: Table, caption: string): string {
  const labels = Object.keys(table);
  if (!labels.length) return '';
  const rows = labels
    .map((l) => {
      const t = table[l];
      const label = /^[A-Z]+ \//.test(l) ? `<code>${esc(l)}</code>` : esc(l);
      return `<tr><th scope="row">${label}</th><td class="num">${num(t.count)}</td><td class="num">${t.perSecond === undefined ? '—' : num(t.perSecond, 1)}</td><td class="num">${ms(t.p50)}</td><td class="num strong">${ms(t.p95)}</td><td class="num">${ms(t.p99)}</td><td class="num">${ms(t.max)}</td></tr>`;
    })
    .join('\n');
  return `<div class="table-wrap"><table class="data">
<caption>${esc(caption)}</caption>
<thead><tr><th scope="col">Request</th><th scope="col" class="num">Count</th><th scope="col" class="num">Per second</th><th scope="col" class="num">p50</th><th scope="col" class="num">p95</th><th scope="col" class="num">p99</th><th scope="col" class="num">Max</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function serverLine(load: ServerLoad): string {
  if (!load.samples) return '<p class="note">The API\'s metrics could not be read during this scenario.</p>';
  return `<dl class="facts">
  <div><dt>API CPU, p95</dt><dd>${num(load.cpuPct.p95, 1)}% <span class="muted">of a core</span></dd></div>
  <div><dt>API CPU, mean</dt><dd>${num(load.cpuPct.mean, 1)}%</dd></div>
  <div><dt>Event-loop lag, worst p99</dt><dd>${ms(load.eventLoopLagP99Ms.max)}</dd></div>
  <div><dt>Samples</dt><dd>${num(load.samples)} <span class="muted">every 5 s${load.missed ? `, ${num(load.missed)} missed` : ''}</span></dd></div>
</dl>`;
}

function errorsLine(errors: Record<string, Record<string, number>>, warmup?: Record<string, Record<string, number>>): string {
  const lines = [
    ...Object.entries(errors).flatMap(([l, by]) => Object.entries(by).map(([o, n]) => `<li><code>${esc(l)}</code>: ${num(n)} × ${esc(o)}</li>`)),
    ...Object.entries(warmup ?? {}).flatMap(([l, by]) => Object.entries(by).map(([o, n]) => `<li><code>${esc(l)}</code> (warm-up): ${num(n)} × ${esc(o)}</li>`)),
  ];
  return lines.length ? `<div class="callout missed"><strong>Failed requests</strong><ul>${lines.join('')}</ul></div>` : '';
}

function warmupBlock(tables: [Table, string][]): string {
  const inner = tables.map(([t, c]) => latencyTable(t, c)).join('');
  if (!inner) return '';
  return `<details><summary>Warm-up: each user's first actions on a server just started (reported, not held to the budgets)</summary>${inner}</details>`;
}

function scenarios(r: Results): string {
  const out: string[] = [];
  if (r.gps) {
    const g = r.gps;
    const w = g.workload;
    out.push(`<section class="card" aria-labelledby="s-gps">
<header><p class="eyebrow">Scenario 1</p><h2 id="s-gps">GPS and the live map</h2>
<p class="lede">${num(w.vehicles)} vehicles each post a position every ${num(w.intervalS)} s for ${num(g.seconds)} s, while ${num(w.observers)} signed-in dashboards hold a live socket. Every position must reach every dashboard.</p></header>
<dl class="facts">
  <div><dt>Positions accepted</dt><dd>${num(g.events.announced)}</dd></div>
  <div><dt>Deliveries expected</dt><dd>${num(g.events.expected)}</dd></div>
  <div><dt>Delivered</dt><dd>${num(g.events.received)}</dd></div>
  <div><dt>Dropped</dt><dd class="${g.events.dropped ? 'bad' : ''}">${num(g.events.dropped)}</dd></div>
  <div><dt>Dashboard disconnects</dt><dd class="${g.events.observerDisconnects ? 'bad' : ''}">${num(g.events.observerDisconnects)}</dd></div>
</dl>
${latencyTable({ 'Ping to dashboard': g.deliveryMs, ...g.requests }, 'Latency: a position from the device to a dashboard, and the ping request itself')}
${serverLine(g.server)}
${errorsLine(g.errors)}
</section>`);
  }
  if (r.api) {
    const a = r.api;
    out.push(`<section class="card" aria-labelledby="s-api">
<header><p class="eyebrow">Scenario 2</p><h2 id="s-api">People working the API</h2>
<p class="lede">${num(a.workload.users)} users for ${num(a.seconds)} s, each listing trips (40%), listing vehicles (40%) or logging a fill-up (20%), pausing ${num(a.workload.thinkMs[0] / 1000, 1)} to ${num(a.workload.thinkMs[1] / 1000, 1)} s between actions.</p></header>
${latencyTable(a.requests, 'Response times during the timed window')}
${serverLine(a.server)}
${errorsLine(a.errors, a.warmupErrors)}
${warmupBlock([[a.warmup, 'Warm-up response times']])}
</section>`);
  }
  if (r.dashboard) {
    const d = r.dashboard;
    out.push(`<section class="card" aria-labelledby="s-dash">
<header><p class="eyebrow">Scenario 3</p><h2 id="s-dash">Opening the dashboards</h2>
<p class="lede">${num(d.workload.users)} users for ${num(d.seconds)} s, each opening the Fleet Command Center and the analytics dashboard in turn. A page counts as loaded when the last of its requests answers.</p></header>
${latencyTable(d.pages, 'Page load: all of a page\'s requests answered')}
${latencyTable(d.requests, 'Each request a page makes')}
${serverLine(d.server)}
${errorsLine(d.errors, d.warmupErrors)}
${warmupBlock([[d.warmup.pages, 'Warm-up page loads'], [d.warmup.requests, 'Warm-up requests']])}
</section>`);
  }
  return out.join('\n');
}

const CSS = `
:root{color-scheme:light;--canvas:246 247 251;--surface:255 255 255;--muted-surface:249 250 253;--sunken:240 242 248;--line:225 229 240;--line-strong:201 207 224;--ink:19 23 41;--ink-muted:65 72 98;--ink-subtle:96 103 130;--brand:67 56 202;--brand-soft:238 240 255;--success:6 118 71;--success-soft:236 253 243;--warning:181 71 8;--warning-soft:255 250 235;--danger:180 35 24;--danger-soft:254 243 242;--shadow:19 23 41}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--canvas:11 13 20;--surface:18 21 31;--muted-surface:23 27 39;--sunken:14 16 24;--line:37 42 59;--line-strong:54 60 82;--ink:238 240 248;--ink-muted:178 184 204;--ink-subtle:140 147 170;--brand:165 180 252;--brand-soft:28 30 66;--success:71 205 137;--success-soft:10 41 28;--warning:253 176 34;--warning-soft:46 31 6;--danger:249 112 102;--danger-soft:52 17 15;--shadow:0 0 0}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:rgb(var(--canvas));color:rgb(var(--ink));font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"tnum" 1,"cv11" 1}
main{max-width:1080px;margin:0 auto;padding:40px 24px 64px;min-width:0}
.card,.tile{min-width:0}
h1,h2,h3{margin:0;letter-spacing:-.01em}
h1{font-size:28px;line-height:1.2;font-weight:650}
h2{font-size:19px;font-weight:620}
code{font:500 13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.muted{color:rgb(var(--ink-subtle))}
.eyebrow{margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgb(var(--brand))}
.top{display:flex;flex-wrap:wrap;gap:16px 24px;align-items:flex-start;justify-content:space-between;margin-bottom:24px}
.top p{margin:8px 0 0;color:rgb(var(--ink-muted))}
.verdict{display:inline-flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;font-weight:620;border:1px solid}
.verdict svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.verdict.met{background:rgb(var(--success-soft));color:rgb(var(--success));border-color:rgb(var(--success)/.25)}
.verdict.missed{background:rgb(var(--danger-soft));color:rgb(var(--danger));border-color:rgb(var(--danger)/.25)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:16px;margin-bottom:24px}
.tile{background:rgb(var(--surface));border:1px solid rgb(var(--line));border-radius:16px;padding:16px 20px;box-shadow:0 1px 2px rgb(var(--shadow)/.04),0 4px 16px rgb(var(--shadow)/.04)}
.tile dt{font-size:13px;color:rgb(var(--ink-subtle))}
.tile dd{margin:4px 0 0;font-size:24px;font-weight:650;letter-spacing:-.01em}
.tile dd small{display:block;margin-top:2px;font-size:13px;font-weight:500;color:rgb(var(--ink-muted));letter-spacing:0}
.card{background:rgb(var(--surface));border:1px solid rgb(var(--line));border-radius:16px;padding:24px;margin-bottom:24px;box-shadow:0 1px 2px rgb(var(--shadow)/.04),0 4px 16px rgb(var(--shadow)/.04)}
.card>header{margin-bottom:16px}
.lede{margin:6px 0 0;color:rgb(var(--ink-muted));max-width:72ch}
.table-wrap{overflow-x:auto;margin:16px 0;border:1px solid rgb(var(--line));border-radius:12px}
table{width:100%;border-collapse:collapse}
caption{caption-side:top;text-align:left;padding:12px 16px 8px;font-size:13px;font-weight:600;color:rgb(var(--ink-muted))}
th,td{padding:10px 16px;text-align:left;vertical-align:middle;border-top:1px solid rgb(var(--line))}
thead th{border-top:0;background:rgb(var(--muted-surface));font-size:12px;font-weight:600;color:rgb(var(--ink-subtle));white-space:nowrap}
tbody th{font-weight:500}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.strong{font-weight:620}
td.muted{color:rgb(var(--ink-subtle))}
.budgets .group th{background:rgb(var(--muted-surface));font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:rgb(var(--ink-subtle))}
.budgets tr.missed th[scope=row]{color:rgb(var(--danger))}
.meter-cell{width:28%;min-width:120px}
.meter{display:block;height:8px;border-radius:4px;background:rgb(var(--sunken));overflow:hidden;box-shadow:inset 0 0 0 1px rgb(var(--line))}
.meter .fill{display:block;height:100%;border-radius:4px}
.fill.met{background:rgb(var(--success))}.fill.close{background:rgb(var(--warning))}.fill.missed{background:rgb(var(--danger))}
.meter-none{display:block;height:8px}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 10px 2px 6px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.badge svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.badge.met{background:rgb(var(--success-soft));color:rgb(var(--success))}
.badge.close{background:rgb(var(--warning-soft));color:rgb(var(--warning))}
.badge.missed{background:rgb(var(--danger-soft));color:rgb(var(--danger))}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr));gap:8px 24px;margin:16px 0}
.facts dt{font-size:12px;color:rgb(var(--ink-subtle))}
.facts dd{margin:2px 0 0;font-weight:600;font-variant-numeric:tabular-nums}
.facts dd.bad{color:rgb(var(--danger))}
.note{color:rgb(var(--ink-muted));font-size:14px}
.callout{border-radius:12px;padding:12px 16px;margin:16px 0}
.callout.missed{background:rgb(var(--danger-soft));color:rgb(var(--danger))}
.callout ul{margin:6px 0 0;padding-left:20px}
details{margin-top:16px;border-top:1px solid rgb(var(--line));padding-top:12px}
summary{cursor:pointer;font-size:14px;font-weight:600;color:rgb(var(--ink-muted))}
summary:focus-visible{outline:2px solid rgb(var(--brand));outline-offset:2px;border-radius:4px}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0;padding:0 16px 12px;list-style:none;font-size:13px;color:rgb(var(--ink-muted))}
footer{margin-top:32px;font-size:13px;color:rgb(var(--ink-subtle))}
footer dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px 24px;margin:12px 0 0}
footer dt{font-weight:600;color:rgb(var(--ink-muted))}
footer dd{margin:2px 0 0;overflow-wrap:anywhere}
@media (max-width:640px){main{padding:24px 16px 48px}h1{font-size:23px}.card{padding:16px}th,td{padding:8px 12px}.meter-cell{min-width:72px}
.budgets,.budgets tbody{display:block}.budgets thead{display:none}
.budgets tr{display:grid;grid-template-columns:1fr auto;gap:8px 12px;padding:12px;border-top:1px solid rgb(var(--line))}
.budgets tr.group{display:block;padding:8px 12px;background:rgb(var(--muted-surface))}
.budgets tr.group th{display:block;padding:0;border:0}
.budgets th,.budgets td{padding:0;border:0}
.budgets .c-name{grid-area:1/1}.budgets .c-status{grid-area:1/2;text-align:right}
.budgets .c-meter{grid-area:2/1/3/3;width:auto;min-width:0}
.budgets .c-val{grid-area:3/1;text-align:left}.budgets .c-lim{grid-area:3/2}
.budgets .meter-none{display:none}}
@media print{body{background:#fff}.card,.tile{box-shadow:none;break-inside:avoid}details{display:none}}
`;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? esc(iso)
    : esc(new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Addis_Ababa' }).format(d)) + ' (Addis Ababa)';
}

function duration(a: string, b: string): string {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export function renderHtml(report: LoadReport): string {
  const { checks } = report;
  const missed = checks.filter((c) => !c.passed);
  const close = checks.filter((c) => standing(c) === 'close');
  const tightest = checks
    .filter((c) => c.limit > 0 && Number.isFinite(c.actual))
    .sort((a, b) => b.actual / b.limit - a.actual / a.limit)[0];
  const r = report.results;
  const requests =
    [r.gps?.requests, r.api?.requests, r.api?.warmup, r.dashboard?.requests, r.dashboard?.warmup.requests]
      .filter(Boolean)
      .reduce((n, t) => n + Object.values(t!).reduce((m, s) => m + s.count, 0), 0);
  const failed = (r.gps?.errorCount ?? 0) + (r.api?.errorCount ?? 0) + (r.dashboard?.errorCount ?? 0);

  const groups: string[] = [];
  for (const scenario of [...new Set(checks.map(scenarioOf))]) {
    groups.push(`<tr class="group"><th colspan="5" scope="colgroup">${esc(scenario)}</th></tr>`);
    groups.push(budgetRows(checks.filter((c) => scenarioOf(c) === scenario)));
  }

  const verdictIcon = report.passed ? ICONS.met : ICONS.missed;
  const verdictText = report.passed ? 'All budgets met' : `${missed.length} of ${checks.length} budgets missed`;
  const summary = report.passed
    ? close.length
      ? `Every budget was met. ${close.length === 1 ? 'One is' : `${close.length} are`} within ${num((1 - CLOSE_SHARE) * 100)}% of its limit and worth watching.`
      : 'Every budget was met with room to spare.'
    : `Missed: ${missed.map((c) => c.name).join('; ')}.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Load Test Report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="top">
  <div>
    <p class="eyebrow">Fleet Management System · ${esc(report.card)} · ${esc(report.profile)} profile</p>
    <h1>Load test report</h1>
    <p>${when(report.startedAt)} · ran ${duration(report.startedAt, report.finishedAt)} · commit <code>${esc((report.commit ?? 'unknown').slice(0, 12))}</code></p>
  </div>
  <div class="verdict ${report.passed ? 'met' : 'missed'}" role="status"><svg viewBox="0 0 16 16" aria-hidden="true">${verdictIcon}</svg>${verdictText}</div>
</div>

<dl class="tiles">
  <div class="tile"><dt>Budgets met</dt><dd>${checks.length - missed.length} of ${checks.length}<small>${esc(summary)}</small></dd></div>
  <div class="tile"><dt>Tightest budget</dt><dd>${tightest ? `${num((tightest.actual / tightest.limit) * 100)}%<small>${esc(tightest.name)}: ${esc(value(tightest))}, ${esc(limit(tightest))}</small>` : '—'}</dd></div>
  <div class="tile"><dt>Requests made</dt><dd>${num(requests)}<small>${failed ? `${num(failed)} failed` : 'none failed'}</small></dd></div>
  ${r.gps ? `<div class="tile"><dt>Live-map deliveries</dt><dd>${num(r.gps.events.received)}<small>${num(r.gps.events.dropped)} dropped</small></dd></div>` : ''}
</dl>

<section class="card" aria-labelledby="s-budgets">
<header><h2 id="s-budgets">Budgets</h2><p class="lede">Each target the run is held to. The bar shows how much of the limit was used; the run fails if any is missed. Percentiles are nearest-rank.</p></header>
<div class="table-wrap"><table class="budgets">
<thead><tr><th scope="col">Budget</th><th scope="col">Share of the limit</th><th scope="col" class="num">Measured</th><th scope="col" class="num">Limit</th><th scope="col">Status</th></tr></thead>
<tbody>${groups.join('\n')}</tbody>
</table>
<ul class="legend"><li>${badge('met')} under ${num(CLOSE_SHARE * 100)}% of the limit</li><li>${badge('close')} met, ${num(CLOSE_SHARE * 100)}% of the limit or more</li><li>${badge('missed')} the run fails</li></ul>
</div>
</section>

${scenarios(r)}

<footer>
<h2>About this run</h2>
<dl>
  <div><dt>Machine</dt><dd>${esc(report.machine.cpu)}, ${num(report.machine.cores)} threads, ${num(report.machine.memoryGb)} GB · ${esc(report.machine.platform)} · Node ${esc(report.machine.node)}</dd></div>
  <div><dt>Data</dt><dd>${Object.entries(report.dataset as Record<string, number>).map(([k, v]) => `${num(v)} ${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}`).join(', ')}: a seeded test database, never production</dd></div>
  <div><dt>Server</dt><dd>The compiled API with NODE_ENV=${esc(report.server.nodeEnv)}; per-address rate limits raised because every client runs on one machine (${Object.entries(report.server.raisedLimits).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(', ')})</dd></div>
  <div><dt>More</dt><dd>The same numbers in full: the JSON report beside this file. How the suite works: docs/load-testing.md</dd></div>
</dl>
</footer>
</main>
</body>
</html>
`;
}

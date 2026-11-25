import { z } from 'zod';

// Monitoring (FMS-109, FMS-163, docs/observability.md): what the Resources tab and the alert webhook reason about.
// Pure: Alertmanager's payload, a metric's status against its thresholds, the history ranges, and the capacity
// forecast. Prometheus itself is read by infrastructure/prometheus.client.ts.

export const RANGES = ['1h', '24h', '7d', '30d', '12m'] as const;
export type Range = (typeof RANGES)[number];

/** Each range's span and the step between points: raw for the hour (15 s scrapes, 1 min points), 5-minute averages and up beyond. */
export const RANGE_SPECS: Record<Range, { seconds: number; stepSeconds: number }> = {
  '1h': { seconds: 3600, stepSeconds: 60 },
  '24h': { seconds: 86_400, stepSeconds: 300 },
  '7d': { seconds: 7 * 86_400, stepSeconds: 1800 },
  '30d': { seconds: 30 * 86_400, stepSeconds: 7200 },
  '12m': { seconds: 365 * 86_400, stepSeconds: 86_400 },
};

export type Status = 'ok' | 'warning' | 'critical' | 'unknown';

/** A value against its warning and critical lines: at or above critical is critical, at or above warning a warning. */
export function statusOf(value: number | null, warning: number, critical: number): Status {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value >= critical) return 'critical';
  if (value >= warning) return 'warning';
  return 'ok';
}

/** The worst of several. */
export function worst(statuses: readonly Status[]): Status {
  for (const s of ['critical', 'warning', 'ok'] as const) if (statuses.includes(s)) return s;
  return 'unknown';
}

/** Alertmanager's webhook body (version 4), as much of it as we use. */
export const alertmanagerPayload = z.object({
  version: z.string().optional(),
  status: z.enum(['firing', 'resolved']),
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string(), z.string()).default({}),
        annotations: z.record(z.string(), z.string()).default({}),
        startsAt: z.string(),
        endsAt: z.string().optional(),
        fingerprint: z.string().min(1).max(64),
      }),
    )
    .max(500),
});
export type AlertmanagerPayload = z.infer<typeof alertmanagerPayload>;

/** One alert of the payload, in our terms. `host` is what a maintenance window names. */
export interface MonitoringAlert {
  status: 'firing' | 'resolved';
  fingerprint: string;
  alertName: string;
  severity: 'critical' | 'warning';
  host: string | null;
  summary: string | null;
  description: string | null;
  startedAt: string;
}

/** The host an alert is about: its `host` label, else the container's name, else the scraped instance. */
export function hostOf(labels: Record<string, string>): string | null {
  return labels.host ?? labels.name ?? labels.instance ?? null;
}

export function toMonitoringAlerts(payload: AlertmanagerPayload): MonitoringAlert[] {
  return payload.alerts.map((a) => ({
    status: a.status,
    fingerprint: a.fingerprint,
    alertName: (a.labels.alertname ?? 'MonitoringAlert').slice(0, 80),
    severity: a.labels.severity === 'critical' ? 'critical' : 'warning',
    host: hostOf(a.labels)?.slice(0, 120) ?? null,
    summary: a.annotations.summary?.slice(0, 200) ?? null,
    description: a.annotations.description?.slice(0, 1000) ?? null,
    startedAt: a.startsAt,
  }));
}

/** Whether a window silences this host now: it names the host, it is not cancelled, and now is between its times. */
export function silences(window: { hosts: readonly string[]; startsAt: Date; endsAt: Date; cancelledAt: Date | null }, host: string | null, now: Date): boolean {
  if (!host || window.cancelledAt) return false;
  if (now < window.startsAt || now >= window.endsAt) return false;
  return window.hosts.some((h) => h === host || h === '*');
}

/** A least-squares line through (t seconds, value) points: its slope per second and its value at `t`. Null with fewer than 2 points or no spread. */
export function fitLine(points: readonly (readonly [number, number])[]): { slope: number; at: (t: number) => number } | null {
  const pts = points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (pts.length < 2) return null;
  const n = pts.length;
  const mt = pts.reduce((s, [t]) => s + t, 0) / n;
  const mv = pts.reduce((s, [, v]) => s + v, 0) / n;
  const stt = pts.reduce((s, [t]) => s + (t - mt) ** 2, 0);
  if (stt === 0) return null;
  const slope = pts.reduce((s, [t, v]) => s + (t - mt) * (v - mv), 0) / stt;
  return { slope, at: (t) => mv + slope * (t - mt) };
}

/**
 * Days until a percentage reaches `limit` (100: full) at the trend of `points` (t in seconds, value in %): null when
 * it is not growing. From the line's value now, so one noisy last point does not move it.
 */
export function daysUntil(points: readonly (readonly [number, number])[], limit: number, nowSeconds: number): number | null {
  const line = fitLine(points);
  if (!line || line.slope <= 0) return null;
  const current = line.at(nowSeconds);
  if (current >= limit) return 0;
  return (limit - current) / line.slope / 86_400;
}

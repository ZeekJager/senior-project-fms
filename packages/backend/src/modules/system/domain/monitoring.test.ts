import { describe, expect, test } from 'vitest';
import { alertmanagerPayload, daysUntil, fitLine, hostOf, silences, statusOf, toMonitoringAlerts, worst } from './monitoring';

// FMS-163: the monitoring rules; the API, the webhook and the alert engine are in test/integration/monitoring.test.ts.

describe('a metric against its lines', () => {
  test('critical at or above critical, a warning at or above warning, else ok; no value is unknown', () => {
    expect(statusOf(95, 75, 90)).toBe('critical');
    expect(statusOf(90, 75, 90)).toBe('critical');
    expect(statusOf(80, 75, 90)).toBe('warning');
    expect(statusOf(40, 75, 90)).toBe('ok');
    expect(statusOf(null, 75, 90)).toBe('unknown');
    expect(statusOf(Number.NaN, 75, 90)).toBe('unknown');
    expect(worst(['ok', 'warning', 'unknown'])).toBe('warning');
    expect(worst(['ok', 'critical'])).toBe('critical');
    expect(worst(['unknown'])).toBe('unknown');
  });
});

describe('the capacity forecast', () => {
  const day = 86_400;
  test('days until a disk is full matches a hand calculation within 10%', () => {
    // 60% full 30 days ago, growing 0.5 points a day: 75% now, 25 points to go at 0.5 a day = 50 days.
    const now = 30 * day;
    const points = Array.from({ length: 31 }, (_, i) => [i * day, 60 + 0.5 * i] as [number, number]);
    const forecast = daysUntil(points, 100, now)!;
    const manual = (100 - 75) / 0.5;
    expect(Math.abs(forecast - manual) / manual).toBeLessThan(0.1);
    expect(forecast).toBeCloseTo(50, 6);
  });

  test('noise around the trend still lands within 10%', () => {
    const now = 30 * day;
    const noise = [0.8, -0.6, 0.3, -0.9, 0.5, 0, -0.4, 0.7, -0.2, 0.1];
    const points = Array.from({ length: 31 }, (_, i) => [i * day, 60 + 0.5 * i + noise[i % noise.length]] as [number, number]);
    const manual = (100 - 75) / 0.5;
    expect(Math.abs(daysUntil(points, 100, now)! - manual) / manual).toBeLessThan(0.1);
  });

  test('a flat or shrinking disk is never full; one past the limit is 0; too few points is no forecast', () => {
    expect(daysUntil([[0, 50], [day, 50]], 100, day)).toBeNull();
    expect(daysUntil([[0, 60], [day, 55]], 100, day)).toBeNull();
    expect(daysUntil([[0, 90], [day, 101]], 100, day)).toBe(0);
    expect(daysUntil([[0, 10]], 100, 0)).toBeNull();
    expect(fitLine([[5, 1], [5, 2]])).toBeNull();
  });
});

describe("Alertmanager's alerts", () => {
  const body = {
    version: '4',
    status: 'firing',
    alerts: [
      { status: 'firing', labels: { alertname: 'HostCpuCritical', severity: 'critical', host: 'fms-host' }, annotations: { summary: 'CPU above its critical line', description: 'fms-host has used 95% CPU' }, startsAt: '2026-11-25T08:00:00Z', fingerprint: 'abc123' },
      { status: 'resolved', labels: { alertname: 'ServiceCpuWarning', severity: 'warning', service: 'backend' }, annotations: {}, startsAt: '2026-11-25T07:00:00Z', fingerprint: 'def456' },
    ],
  };

  test('each alert in our terms: name, severity, the host it is about', () => {
    const alerts = toMonitoringAlerts(alertmanagerPayload.parse(body));
    expect(alerts).toEqual([
      { status: 'firing', fingerprint: 'abc123', alertName: 'HostCpuCritical', severity: 'critical', host: 'fms-host', summary: 'CPU above its critical line', description: 'fms-host has used 95% CPU', startedAt: '2026-11-25T08:00:00Z' },
      { status: 'resolved', fingerprint: 'def456', alertName: 'ServiceCpuWarning', severity: 'warning', host: null, summary: null, description: null, startedAt: '2026-11-25T07:00:00Z' },
    ]);
    expect(hostOf({ name: 'fms_backend' })).toBe('fms_backend');
    expect(hostOf({ instance: 'node-exporter:9100' })).toBe('node-exporter:9100');
  });

  test('a malformed body is refused', () => {
    expect(alertmanagerPayload.safeParse({ status: 'firing' }).success).toBe(false);
    expect(alertmanagerPayload.safeParse({ ...body, alerts: [{ ...body.alerts[0], fingerprint: '' }] }).success).toBe(false);
  });
});

describe('maintenance windows', () => {
  const w = { hosts: ['fms-host'], startsAt: new Date('2026-11-25T08:00:00Z'), endsAt: new Date('2026-11-25T10:00:00Z'), cancelledAt: null };
  test('silence their hosts between their times, unless cancelled', () => {
    expect(silences(w, 'fms-host', new Date('2026-11-25T09:00:00Z'))).toBe(true);
    expect(silences(w, 'other-host', new Date('2026-11-25T09:00:00Z'))).toBe(false);
    expect(silences(w, 'fms-host', new Date('2026-11-25T07:59:59Z'))).toBe(false);
    expect(silences(w, 'fms-host', new Date('2026-11-25T10:00:00Z'))).toBe(false);
    expect(silences({ ...w, cancelledAt: new Date('2026-11-25T08:30:00Z') }, 'fms-host', new Date('2026-11-25T09:00:00Z'))).toBe(false);
    expect(silences(w, null, new Date('2026-11-25T09:00:00Z'))).toBe(false);
    expect(silences({ ...w, hosts: ['*'] }, 'anything', new Date('2026-11-25T09:00:00Z'))).toBe(true);
  });
});

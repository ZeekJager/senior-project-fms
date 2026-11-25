import { describe, expect, test } from 'vitest';
import type { MaintenanceRepository } from '../infrastructure/maintenance.repository';
import { PrometheusUnavailable, type PrometheusClient, type Series } from '../infrastructure/prometheus.client';
import { MonitoringService, type Thresholds } from './monitoring.service';

// FMS-163: the Resources tab's data from Prometheus (a fake here), and the capacity report's figures.

const NOW = new Date('2026-11-25T08:00:00.000Z');
const nowS = NOW.getTime() / 1000;
const thresholds: Thresholds = { cpu: [75, 90], memory: [80, 90], disk: [75, 90], dbConnections: [70, 85], replicaLag: [30, 60], errorRate: [2, 5], p95: [500, 1000], gpsSilenceMinutes: 2 };

/** A fake Prometheus answering each query with what `answers` says for a part of its text. */
function fakePrometheus(answers: [string, Series[]][], calls: { query: string; step: number }[] = []): PrometheusClient {
  return {
    async instant() {
      return [];
    },
    async range(query, _start, _end, step) {
      calls.push({ query, step });
      return answers.find(([part]) => query.includes(part))?.[1] ?? [];
    },
  };
}

const repo = { pool: () => ({}), slowestQueries: async () => [{ query: 'SELECT relname FROM pg_class WHERE oid = $1', calls: 12, meanMs: 840.5, totalMs: 10086 }] } as unknown as MaintenanceRepository;

function service(prometheus: PrometheusClient | null) {
  return new MonitoringService({ prometheus, repo, events: {} as never, thresholds: async () => thresholds, pdf: () => Buffer.from('%PDF'), now: () => NOW });
}

const series = (labels: Record<string, string>, values: number[], every = 60): Series => ({ labels, values: values.map((v, i) => [nowS - (values.length - 1 - i) * every, v]) });

describe('the Resources tab', () => {
  test('every host and service, each value with its time, status and series; the panels; the 5 slowest queries', async () => {
    const calls: { query: string; step: number }[] = [];
    const data = await service(
      fakePrometheus(
        [
          ['node_cpu_seconds_total', [series({ host: 'fms-host' }, [40, 60, 95])]],
          ['node_memory_MemAvailable_bytes', [series({ host: 'fms-host' }, [50, 82])]],
          ['node_filesystem_avail_bytes', [series({ host: 'fms-host' }, [40, 41])]],
          ['container_cpu_usage_seconds_total', [series({ service: 'backend' }, [12]), series({ service: 'postgres' }, [5])]],
          ['container_memory_working_set_bytes', [series({ service: 'backend' }, [3]), series({ service: 'postgres' }, [8])]],
          ['status_class="5xx"', [series({}, [0.4])]],
          ['histogram_quantile', [series({}, [620])]],
          ['pg_stat_activity_count', [series({}, [20])]],
          ['replica_lag_seconds', [series({}, [75])]],
        ],
        calls,
      ),
    ).metrics('1h');

    expect(data.source).toEqual({ configured: true, reachable: true });
    expect(data.step_seconds).toBe(60);
    expect(data.hosts.map((h) => [h.name, h.status, h.cpu.status, h.memory.status, h.disk?.status])).toEqual([['fms-host', 'critical', 'critical', 'warning', 'ok']]);
    expect(data.hosts[0].cpu).toMatchObject({ value: 95, sampled_at: NOW.toISOString() });
    expect(data.hosts[0].cpu.series).toHaveLength(3);
    expect(data.services.map((s) => s.name)).toEqual(['backend', 'postgres']);
    expect(data.services[0].disk).toBeNull();
    expect(data.application).toMatchObject({ error_pct: { value: 0.4, status: 'ok' }, p95_ms: { value: 620, status: 'warning' } });
    expect(data.database).toMatchObject({ connections_pct: { status: 'ok' }, replica_lag_seconds: { value: 75, status: 'critical' } });
    expect(data.database!.slowest_queries).toEqual([{ query: 'SELECT relname FROM pg_class WHERE oid = $1', calls: 12, mean_ms: 840.5, total_ms: 10086 }]);
    expect(data.thresholds.cpu_pct).toEqual({ warning: 75, critical: 90 });
    // Values at most 30 s old: each tile says when its last sample was.
    expect(NOW.getTime() - new Date(data.hosts[0].cpu.sampled_at!).getTime()).toBeLessThanOrEqual(30_000);
    expect(new Set(calls.map((c) => c.step))).toEqual(new Set([60]));
  });

  test('the 12-month range asks for one point a day', async () => {
    const calls: { query: string; step: number }[] = [];
    await service(fakePrometheus([], calls)).metrics('12m');
    expect(new Set(calls.map((c) => c.step))).toEqual(new Set([86_400]));
  });

  test('not set up, or not answering: said so, no tiles', async () => {
    expect((await service(null).metrics('1h')).source).toEqual({ configured: false, reachable: false });
    const down: PrometheusClient = {
      instant: async () => [],
      range: async () => {
        throw new PrometheusUnavailable('The metrics store could not be reached.');
      },
    };
    const data = await service(down).metrics('24h');
    expect(data.source).toMatchObject({ configured: true, reachable: false });
    expect(data.hosts).toEqual([]);
  });
});

describe('the capacity report', () => {
  test('days until each disk is full, and what passes 80% within 90 days', async () => {
    const day = 86_400;
    const disk = { labels: { host: 'fms-host' }, values: Array.from({ length: 31 }, (_, i) => [nowS - (30 - i) * day, 60 + 0.5 * i] as [number, number]) };
    const memory = { labels: { host: 'fms-host' }, values: Array.from({ length: 31 }, (_, i) => [nowS - (30 - i) * day, 40] as [number, number]) };
    const report = await service(
      fakePrometheus([
        ['node_filesystem_avail_bytes', [disk]],
        ['node_memory_MemAvailable_bytes', [memory]],
        ['increase(http_request_duration_seconds_count', [series({}, [1000, 2000], day)]],
        ['pg_database_size_bytes', [series({}, [5e8, 6e8], day)]],
      ]),
    ).capacity();
    const d = report.resources.find((r) => r.resource === 'disk')!;
    expect(d).toMatchObject({ host: 'fms-host', current_pct: 75, growth_pct_30d: 15, days_to_full: 50, days_to_80_pct: 10, past_80_within_90_days: true });
    expect(report.resources.find((r) => r.resource === 'memory')).toMatchObject({ days_to_80_pct: null, past_80_within_90_days: false });
    expect(report.growth).toMatchObject({ requests_30d: 3000, database_bytes: 6e8, database_growth_bytes_30d: 1e8 });
  });

  test('is a PDF too', async () => {
    const pdf = await service(fakePrometheus([])).capacityPdf();
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

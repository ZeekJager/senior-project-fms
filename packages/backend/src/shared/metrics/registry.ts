import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The process's metrics (FMS-75, docs/metrics.md), in Prometheus' format. One registry for the API; it is served on
 * its own internal port (src/shared/metrics/metrics-server.ts), never by the public app.
 */
export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: 'fms-backend' });
collectDefaultMetrics({ register: metricsRegistry });

/** Latency buckets in seconds: dense around the CFG-3 budgets (a typical API answer is well under 300 ms), up to 10 s. */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10];

/** Every request the API answered, by method, route template and status class. `p95 per route` is histogram_quantile over this. */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'API request duration by method, route template and status class',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [metricsRegistry],
});

/** A scheduled job's run, by job and how it ended. */
export const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Scheduled job run duration by job and outcome',
  labelNames: ['job', 'status'] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600],
  registers: [metricsRegistry],
});

/** A value read when Prometheus scrapes, not kept up to date by the code. */
export function scrapedGauge(name: string, help: string, read: () => Promise<number | null> | number | null, labelNames: readonly string[] = []): Gauge {
  return new Gauge({
    name,
    help,
    labelNames: labelNames as string[],
    registers: [metricsRegistry],
    async collect() {
      const value = await read();
      if (value !== null) this.set(value);
    },
  });
}

/** Several labelled values read at a scrape (one per provider, say). Replaces the series each time, so a removed one disappears. */
export function scrapedLabelledGauge(name: string, help: string, labelName: string, read: () => Promise<Record<string, number>> | Record<string, number>): Gauge {
  return new Gauge({
    name,
    help,
    labelNames: [labelName],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      for (const [label, value] of Object.entries(await read())) this.set({ [labelName]: label }, value);
    },
  });
}
